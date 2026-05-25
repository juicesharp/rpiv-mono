/**
 * Tests for sessions.ts — the per-stage / per-phase session orchestrator.
 *
 * Drives the two public entries (`runStageSession`, `runFanoutSession`) against
 * synthetic StageSession / FanoutSession objects so internals (retryUntilValid,
 * runOutcome, readSessionOutcome, spawnSession, recordStageSuccess, halt
 * helpers) are exercised at a finer grain than runner.test.ts can reach via
 * runWorkflow.
 *
 * Wiring strategy: every test allocates a temp cwd (audit writes JSONL there)
 * and feeds runStageSession either a `createMockSessionChain` ctx (fresh path,
 * scripted branch) or a hand-rolled RunnerCtx (continue path, outer branch).
 * Stage nodes carry custom `outcome` functions that close over an attempt
 * counter — this is how we drive retry-loop scenarios without mutating the
 * mock branch between attempts.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockPi, createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StageDef, StageSchema } from "./api.js";
import { fs as fsHandle } from "./handle.js";
import { currentPrimaryArtifact } from "./internal-utils.js";
import type { CollectCtx, OutputSpec } from "./manifest.js";
import {
	ERR_VALIDATION_FAILED,
	MSG_STAGE_ABORTED,
	MSG_STAGE_COMPLETE,
	MSG_STAGE_FAILED,
	MSG_STAGE_NO_RESPONSE,
	MSG_VALIDATION_EXHAUSTED,
	MSG_VALIDATION_RETRY,
} from "./messages.js";
import { runFanoutSession, runStageSession } from "./sessions/index.js";
import { typeboxSchema } from "./typebox-adapter.js";
import type { FanoutSession, RunnerCtx, RunState, StageSession } from "./types.js";
import { MAX_VALIDATION_RETRIES, MAX_VALIDATION_RETRY_TIMEOUT_MS } from "./validate-manifest.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Bare RunState — every field nullish/zero so tests pin the deltas sessions.ts produces. */
const freshRunState = (overrides: Partial<RunState> = {}): RunState => ({
	originalInput: "x",
	primaryArtifact: undefined,
	manifest: undefined,
	stagesCompleted: 0,
	lastAllocatedStageNumber: 0,
	telemetry: {
		backwardJumps: 0,
		droppedRoutingRows: [],
	},
	termination: {
		success: true,
		error: undefined,
	},
	...overrides,
});

/** Minimal skill stage — fresh policy, side-effect (no artifact extraction by default). */
const stage = (overrides: Partial<StageDef> = {}): StageDef => ({
	skill: "test",
	kind: "side-effect",
	sessionPolicy: "fresh",
	...overrides,
});

/**
 * Build a StageSession with sensible defaults. Caller MUST supply cwd + state
 * (shared with the JSONL audit write) and any stage/onSuccess overrides.
 */
const stageSession = (overrides: Partial<StageSession> & Pick<StageSession, "cwd" | "state">): StageSession => ({
	runId: "run-test",
	prompt: "/skill:test arg",
	skill: "test",
	stage: stage(),
	stageIndex: 0,
	snapshot: undefined,
	onSuccess: async () => {},
	...overrides,
});

/**
 * Scripted outcome — produces a sequence of {ok+data | fatal} results
 * across successive `runOutcome` invocations (the retry loop drives
 * this). Collector + parser advance in lockstep on the same index.
 */
type ScriptedResult = { kind: "ok"; data: Record<string, unknown> } | { kind: "fatal"; message: string };

type ScriptedOutcome = OutputSpec & { collectSpy: ReturnType<typeof vi.fn> };

const scriptedOutcome = (results: ScriptedResult[]): ScriptedOutcome => {
	let i = 0;
	const collectSpy = vi.fn(() => {
		const r = results[i] ?? results[results.length - 1]!;
		i++;
		if (r.kind === "fatal") return { kind: "fatal" as const, message: r.message };
		return {
			kind: "ok" as const,
			artifacts: [{ handle: fsHandle(`scripted-${i}.md`), role: "primary" }],
		};
	});
	const outcome: OutputSpec = {
		collector: { collect: collectSpy as ScriptedOutcome["collector"]["collect"] },
		parser: {
			parse: () => {
				const r = results[i - 1] ?? results[0]!;
				if (r.kind === "fatal") return { kind: "fatal", message: r.message };
				return { kind: "ok", payload: { kind: "test", data: r.data } };
			},
		},
	};
	return Object.assign(outcome, { collectSpy });
};

const okPayload = (data: Record<string, unknown>): ScriptedResult => ({ kind: "ok", data });
const fatalPayload = (message: string): ScriptedResult => ({ kind: "fatal", message });

const FOO_EQ_2_SCHEMA = typeboxSchema(Type.Object({ foo: Type.Literal(2) }, { additionalProperties: true }));

/** Read JSONL rows the audit layer wrote under cwd/.rpiv/workflows/<runId>.jsonl. */
const readStageRows = (cwd: string): Array<Record<string, unknown>> => {
	const dir = join(cwd, ".rpiv", "workflows");
	const files = readdirSync(dir);
	const lines = readFileSync(join(dir, files[0]!), "utf-8").trim().split("\n");
	return lines.map((l) => JSON.parse(l));
};

// ---------------------------------------------------------------------------
// Group 1 — retry-loop coverage (retryUntilValid + extractAndValidateManifest)
// ---------------------------------------------------------------------------

describe("sessions — validation retry loop", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-retry-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("passes on first extract — no retry, no MSG_VALIDATION_RETRY notify", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({ outputSchema: FOO_EQ_2_SCHEMA, outcome: scriptedOutcome([okPayload({ foo: 2 })]) }),
				onSuccess,
			}),
		);

		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(chain.notifications.find((n) => /asking agent to fix/i.test(n.msg))).toBeUndefined();
		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_COMPLETE("test"))).toBe(true);
		expect(state.stagesCompleted).toBe(1);
	});

	it("retries once after invalid output, then succeeds", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({
					outputSchema: FOO_EQ_2_SCHEMA,
					maxRetries: 2,
					outcome: scriptedOutcome([okPayload({ foo: 1 }), okPayload({ foo: 2 })]),
				}),
				onSuccess,
			}),
		);

		expect(onSuccess).toHaveBeenCalledTimes(1);
		// One retry attempt → one MSG_VALIDATION_RETRY notification.
		const retryNotifies = chain.notifications.filter((n) => n.msg === MSG_VALIDATION_RETRY("test", 1));
		expect(retryNotifies).toHaveLength(1);
		// The fix-request prompt MUST appear in sentMessages between initial prompt and success.
		expect(chain.sentMessages.some((m) => m.includes("doesn't satisfy the expected output schema"))).toBe(true);
		expect(state.stagesCompleted).toBe(1);
	});

	it("exhausts retries → MSG_VALIDATION_EXHAUSTED + ERR_VALIDATION_FAILED, onFailure fires", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});
		const onFailure = vi.fn();

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({
					outputSchema: FOO_EQ_2_SCHEMA,
					maxRetries: 1,
					// Always invalid → 1 retry attempt then exhaustion.
					outcome: scriptedOutcome([okPayload({ foo: 1 })]),
				}),
				onSuccess,
				onFailure,
			}),
		);

		expect(onSuccess).not.toHaveBeenCalled();
		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(chain.notifications.some((n) => n.msg === MSG_VALIDATION_EXHAUSTED("test"))).toBe(true);
		expect(state.termination.error).toMatch(new RegExp(ERR_VALIDATION_FAILED("test", "foo").split(":")[0] ?? ""));
		expect(state.termination.error).toContain("/foo");
	});

	it("clamps maxRetries above the ceiling (MAX_VALIDATION_RETRIES)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const outcome = scriptedOutcome([okPayload({ foo: 1 })]);

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({
					outputSchema: FOO_EQ_2_SCHEMA,
					// Far above ceiling — must clamp to MAX_VALIDATION_RETRIES.
					maxRetries: MAX_VALIDATION_RETRIES + 50,
					outcome,
				}),
			}),
		);

		// Initial collect + MAX retries → MAX+1 calls total.
		expect(outcome.collectSpy).toHaveBeenCalledTimes(MAX_VALIDATION_RETRIES + 1);
		// One MSG_VALIDATION_RETRY per retry attempt.
		const retries = chain.notifications.filter((n) => /asking agent to fix/i.test(n.msg));
		expect(retries).toHaveLength(MAX_VALIDATION_RETRIES);
	});

	it("onInvalid='halt' skips retries — outcome called once, exhausted immediately", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const outcome = scriptedOutcome([okPayload({ foo: 1 })]);
		const onFailure = vi.fn();

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({
					outputSchema: FOO_EQ_2_SCHEMA,
					onInvalid: "halt",
					maxRetries: 3,
					outcome,
				}),
				onFailure,
			}),
		);

		expect(outcome.collectSpy).toHaveBeenCalledTimes(1);
		expect(chain.notifications.find((n) => /asking agent to fix/i.test(n.msg))).toBeUndefined();
		expect(onFailure).toHaveBeenCalledTimes(1);
	});

	it("withTimeout fires inside askAgentToFix → fatal surfaces, onFailure called once", async () => {
		// Override the freshCtx sendUserMessage to hang forever — withTimeout
		// must convert this into a fatal halt rather than an unhandled rejection.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onFailure = vi.fn();
		// Patch the underlying freshCtx sendUserMessage indirectly: createMockSessionChain
		// wires every replaced ctx to a single shared `sendUserMessageFn`. Replace it
		// by intercepting the next newSession call to override sendUserMessage on the
		// freshCtx Object.
		const realNewSession = chain.ctx.newSession;
		(chain.ctx as { newSession: unknown }).newSession = vi.fn(
			async (opts: { withSession?: (c: unknown) => Promise<void> }) => {
				return realNewSession({
					withSession: async (freshCtx: unknown) => {
						// First message (initial prompt) still resolves — we only want the
						// retry roundtrip to hang. We do that by hooking ONLY after the
						// initial sendUserMessage by overriding it AFTER `withSession` enters.
						// But sessions.ts calls sendUserMessage first; we need the FIRST call
						// to succeed and SUBSEQUENT calls to hang. Use a counter.
						const original = (freshCtx as { sendUserMessage: (m: string) => Promise<void> }).sendUserMessage;
						let calls = 0;
						(freshCtx as { sendUserMessage: (m: string) => Promise<void> }).sendUserMessage = async (
							m: string,
						) => {
							calls++;
							if (calls === 1) return original(m);
							// 2nd call (validation retry roundtrip) hangs forever.
							await new Promise<void>(() => {});
						};
						if (opts.withSession) await opts.withSession(freshCtx);
					},
				});
			},
		);

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({
					outputSchema: FOO_EQ_2_SCHEMA,
					maxRetries: 1,
					validateTimeoutMs: 1_000,
					outcome: scriptedOutcome([okPayload({ foo: 1 })]),
				}),
				onFailure,
			}),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(state.termination.error).toMatch(/validation retry attempt 1 exceeded 1000ms/);
		// Halt path: MSG_STAGE_FAILED (extraction-error variant), not MSG_VALIDATION_EXHAUSTED.
		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_FAILED("test"))).toBe(true);
	}, 5_000);

	it("outcome returning {fatal} on retry → halts with that message", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onFailure = vi.fn();

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({
					outputSchema: FOO_EQ_2_SCHEMA,
					maxRetries: 2,
					outcome: scriptedOutcome([okPayload({ foo: 1 }), fatalPayload("outcome blew up mid-retry")]),
				}),
				onFailure,
			}),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(state.termination.error).toContain("outcome blew up mid-retry");
	});

	// Removed: "outcome returning undefined payload on retry" — the new
	// collector/parser split has no `ok-no-payload` state. An empty
	// collector result on an produces stage fatals at the contract
	// check (enforceCompletionContract); the equivalent behaviour for
	// side-effect nodes is "inherit prior" which is the success path, not
	// a halt.

	it("clamps validateTimeoutMs above ceiling", async () => {
		// Smoke: timeoutMs above ceiling must clamp. We assert the clamp
		// indirectly via MSG_VALIDATION_RETRY firing without timeout.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({
					outputSchema: FOO_EQ_2_SCHEMA,
					maxRetries: 1,
					validateTimeoutMs: MAX_VALIDATION_RETRY_TIMEOUT_MS * 100,
					outcome: scriptedOutcome([okPayload({ foo: 1 }), okPayload({ foo: 2 })]),
				}),
			}),
		);

		// No timeout error surfaced → clamp held.
		expect(chain.notifications.some((n) => /exceeded/.test(n.msg))).toBe(false);
		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_COMPLETE("test"))).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Async schemas (Standard Schema permits async `validate`; libs like
	// ArkType return Promises by default, and filesystem-backed schemas need
	// I/O). The validation seam awaits the schema result, so a Promise-
	// returning schema flows through retryUntilValid the same as a sync one —
	// passing schemas advance the stage, failing schemas drive the retry
	// loop, and a rejected Promise surfaces as fatal-extraction (not as an
	// escaped throw under MSG_STAGE_THREW).
	// -----------------------------------------------------------------------
	it("async-returning schema that resolves clean lets the stage complete", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});
		const onFailure = vi.fn();

		const asyncOkSchema: StageSchema<unknown, unknown> = {
			"~standard": {
				version: 1,
				vendor: "test-async",
				validate: () => Promise.resolve({ value: { foo: 2 } }),
			},
		};

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({ outputSchema: asyncOkSchema, outcome: scriptedOutcome([okPayload({ foo: 2 })]) }),
				onSuccess,
				onFailure,
			}),
		);

		expect(onFailure).not.toHaveBeenCalled();
		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_COMPLETE("test"))).toBe(true);
	});

	it("async-rejected schema halts the stage via fatal-extraction, not via an escaped throw", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});
		const onFailure = vi.fn();

		// Hand-rolled async Standard Schema that rejects (e.g. an I/O probe
		// raised mid-validation). validateOrFatal funnels the rejection
		// through the canonical kind:"fatal" path so the failure carries the
		// right error class (MSG_STAGE_FAILED via haltStageWithExtractionError),
		// fires onFailure, and exits cleanly without escaping the session.
		const asyncFailingSchema: StageSchema<unknown, unknown> = {
			"~standard": {
				version: 1,
				vendor: "test-async",
				validate: () => Promise.reject(new Error("io-probe blew up")),
			},
		};

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({ outputSchema: asyncFailingSchema, outcome: scriptedOutcome([okPayload({ foo: 2 })]) }),
				onSuccess,
				onFailure,
			}),
		);

		expect(onSuccess).not.toHaveBeenCalled();
		expect(onFailure).toHaveBeenCalledTimes(1);

		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_FAILED("test"))).toBe(true);
		expect(chain.notifications.some((n) => /failed to start/.test(n.msg))).toBe(false);

		expect(state.termination.error).toMatch(/test:.*io-probe blew up/);

		const rows = readStageRows(tmpDir);
		const failedRows = rows.filter((r) => r.status === "failed");
		expect(failedRows).toHaveLength(1);
		expect(failedRows[0]?.skill).toBe("test");
	});

	// An async schema whose Promise never settles would otherwise hang the
	// stage indefinitely — sync schemas can't hang, but I/O-backed schemas
	// (fs probes, registry lookups, missing AbortSignal on fetch) can.
	// `validateTimeoutMs` is the same budget that bounds
	// `askAgentToFix`; reusing it for the schema call keeps the public
	// surface narrow and surfaces a clear schema-timeout message.
	it("async schema that never settles halts via fatal-extraction within validateTimeoutMs", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});
		const onFailure = vi.fn();

		const hangingSchema: StageSchema<unknown, unknown> = {
			"~standard": {
				version: 1,
				vendor: "test-async",
				validate: () => new Promise<never>(() => {}),
			},
		};

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({
					outputSchema: hangingSchema,
					validateTimeoutMs: 1_000,
					outcome: scriptedOutcome([okPayload({ foo: 2 })]),
				}),
				onSuccess,
				onFailure,
			}),
		);

		expect(onSuccess).not.toHaveBeenCalled();
		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_FAILED("test"))).toBe(true);
		expect(state.termination.error).toMatch(/outputSchema validation exceeded 1000ms/);
	}, 5_000);
});

// ---------------------------------------------------------------------------
// Group 2 — outcome resolution (resolveOutcome)
// ---------------------------------------------------------------------------

describe("sessions — outcome resolution", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-outcome-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("explicit stage.outcome wins (produces has no framework default)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const explicit = scriptedOutcome([okPayload({ tag: "explicit" })]);

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({ kind: "produces", outcome: explicit }),
			}),
		);

		expect(explicit.collectSpy).toHaveBeenCalledTimes(1);
		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_COMPLETE("test"))).toBe(true);
	});

	it("produces without outcome throws (load-time validation should reject; runtime is defense-in-depth)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		// validateWorkflow rejects this at load — but this test goes
		// straight through runStageSession, bypassing validation. The
		// runner's defense-in-depth throw must surface.
		await expect(
			runStageSession(
				chain.ctx as RunnerCtx,
				stageSession({
					cwd: tmpDir,
					state: freshRunState(),
					stage: stage({ kind: "produces" }),
				}),
			),
		).rejects.toThrow(/no `outcome`/);
	});

	it("side-effect default (sideEffectOutcome) leaves the rolling primary artifact unchanged", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const prior = { handle: fsHandle(".rpiv/artifacts/research/r.md"), role: "primary" };
		const state = freshRunState({ primaryArtifact: prior });
		const onSuccess = vi.fn(async () => {});

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({ kind: "side-effect" }),
				onSuccess,
			}),
		);

		expect(onSuccess).toHaveBeenCalledTimes(1);
		// Side-effect with no collector output → empty artifacts list on the
		// stage's manifest, but the chain's primaryArtifact rolling slot
		// stays put so the next stage inherits the upstream input.
		expect(state.manifest?.artifacts).toEqual([]);
		expect(state.primaryArtifact).toBe(prior);
		expect(currentPrimaryArtifact(state)).toBe(prior);
	});
});

// ---------------------------------------------------------------------------
// Group 3 — CollectCtx contract (readSessionOutcome + buildCollectCtx)
//
// Post-L6-05: CollectCtx.branch is ALWAYS the full unsliced branch;
// branchOffset is ALWAYS the policy-derived offset (continue → captured
// stage offset; fresh → undefined). Collectors slice on demand via the
// `branchOffset` field. The initial production and the retry path emit
// the same offset value — the closed-I4 defect cannot re-introduce by
// construction.
// ---------------------------------------------------------------------------

describe("sessions — collector ctx (always-unsliced branch + policy-derived offset)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-slice-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const recordingOutcomeOf = (results: ScriptedResult[], captured: CollectCtx[]): OutputSpec => {
		let i = 0;
		return {
			collector: {
				collect: (ctx) => {
					captured.push(ctx);
					const r = results[i] ?? results[results.length - 1]!;
					i++;
					if (r.kind === "fatal") return { kind: "fatal", message: r.message };
					return { kind: "ok", artifacts: [{ handle: fsHandle(`s-${i}.md`), role: "primary" }] };
				},
			},
			parser: {
				parse: () => {
					const r = results[i - 1] ?? results[0]!;
					if (r.kind === "fatal") return { kind: "fatal", message: r.message };
					return { kind: "ok", payload: { kind: "test", data: r.data } };
				},
			},
		};
	};

	it("continue policy: full unsliced branch + branchOffset = captured stage offset", async () => {
		const captured: CollectCtx[] = [];
		const recordingOutcome = recordingOutcomeOf([okPayload({})], captured);

		// Outer ctx (continue path) — branch contains prior-stage prefix + current-stage tail.
		const priorPrefix = [mockAssistantMessage("prior stage output")];
		const currentTail = [mockAssistantMessage("current stage output")];
		const outerBranch = [...priorPrefix, ...currentTail];

		const mockPi = createMockPi().pi;
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [], // continue → no newSession
			outerBranch,
			pi: mockPi,
		});

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({ sessionPolicy: "continue", outcome: recordingOutcome }),
				branchOffset: priorPrefix.length,
				host: mockPi,
			}),
		);

		expect(captured).toHaveLength(1);
		// Branch is the FULL unsliced outer branch.
		expect(captured[0]?.branch).toHaveLength(outerBranch.length);
		// branchOffset carries the captured stage offset so extractArtifactPath
		// skips the prior-stage prefix on demand.
		expect(captured[0]?.branchOffset).toBe(priorPrefix.length);
	});

	it("continue policy + validation retry: initial + retry emit the same branchOffset (closed-I4 by construction)", async () => {
		// Pre-L6-05: initial extraction received a pre-sliced branch + undefined
		// offset, retry received the unsliced branch + captured offset — an
		// asymmetric pair that could re-introduce the I4 defect if a future
		// refactor changed one path without the other.
		// Post-L6-05: both extractions emit identical `(full branch, captured offset)`.
		const captured: CollectCtx[] = [];
		// First call: schema-invalid → triggers retry. Subsequent: schema-valid.
		const failThenPassOutcome = recordingOutcomeOf([okPayload({ foo: 0 }), okPayload({ foo: 2 })], captured);

		const priorPrefix = [mockAssistantMessage("prior stage output"), mockAssistantMessage("more prior")];
		const currentTail = [mockAssistantMessage("current stage output")];
		const outerBranch = [...priorPrefix, ...currentTail];

		const mockPi = createMockPi().pi;
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [],
			outerBranch,
			pi: mockPi,
		});

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({
					sessionPolicy: "continue",
					outputSchema: FOO_EQ_2_SCHEMA,
					outcome: failThenPassOutcome,
				}),
				branchOffset: priorPrefix.length,
				host: mockPi,
			}),
		);

		// At least one retry should have fired.
		expect(captured.length).toBeGreaterThanOrEqual(2);
		// Initial + retry both see the FULL unsliced branch + captured offset.
		expect(captured[0]?.branch.length).toBeGreaterThanOrEqual(outerBranch.length);
		expect(captured[0]?.branchOffset).toBe(priorPrefix.length);
		const retryCtx = captured[captured.length - 1]!;
		expect(retryCtx.branch.length).toBeGreaterThanOrEqual(outerBranch.length);
		expect(retryCtx.branchOffset).toBe(priorPrefix.length);
	});

	it("fresh policy: full branch + branchOffset undefined (handler forces undefined regardless of stage carry)", async () => {
		const captured: CollectCtx[] = [];
		const recordingOutcome = recordingOutcomeOf([okPayload({})], captured);
		const branch = [mockAssistantMessage("done")];
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [{ branch }] });

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({ sessionPolicy: "fresh", outcome: recordingOutcome }),
				// Stage's captured offset is set artificially here; in production
				// `computeBranchOffset` returns undefined for fresh stages anyway.
				// The handler short-circuits — fresh ALWAYS emits `undefined`.
				branchOffset: 5,
			}),
		);

		expect(captured).toHaveLength(1);
		expect(captured[0]?.branch).toHaveLength(branch.length);
		expect(captured[0]?.branchOffset).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Group 4 — spawn primitive (spawnSession + sendAndAwaitIdle)
// ---------------------------------------------------------------------------

describe("sessions — spawn primitive", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-spawn-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("continue path: skips newSession, uses pi.sendUserMessage + ctx.waitForIdle, body runs on outer ctx", async () => {
		const mockPi = createMockPi().pi;
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [],
			outerBranch: [mockAssistantMessage("done")],
			pi: mockPi,
		});

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({ sessionPolicy: "continue" }),
				branchOffset: 0,
				host: mockPi,
				prompt: "/skill:test continue-prompt",
			}),
		);

		expect(chain.ctx.newSession).not.toHaveBeenCalled();
		expect(chain.ctx.waitForIdle).toHaveBeenCalledTimes(1);
		expect(mockPi.sendUserMessage).toHaveBeenCalledWith("/skill:test continue-prompt");
	});

	it("fresh path: opens newSession; cancelled freshly → onCancelled fires, body never runs", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ cancelled: true }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				onSuccess,
			}),
		);

		expect(chain.ctx.newSession).toHaveBeenCalledTimes(1);
		expect(onSuccess).not.toHaveBeenCalled();
		// recordCancellation writes a "skipped" row + sets state.termination.error.
		expect(state.termination.error).toMatch(/cancelled by user/);
		const rows = readStageRows(tmpDir);
		expect(rows[0]?.status).toBe("skipped");
	});

	it("continue path: never fires onCancelled even if branch is empty (no cancel signal)", async () => {
		// An empty branch is "noResponse", not cancellation — onCancelled should
		// remain wired only to the fresh-path early-exit, never to halt paths.
		const mockPi = createMockPi().pi;
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [],
			outerBranch: [],
			pi: mockPi,
		});
		const onFailure = vi.fn();

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({ sessionPolicy: "continue" }),
				branchOffset: 0,
				host: mockPi,
				onFailure,
			}),
		);

		// noResponse → recordStopFailure → onFailure (not onCancelled, not skipped row).
		expect(onFailure).toHaveBeenCalledTimes(1);
		const rows = readStageRows(tmpDir);
		expect(rows[0]?.status).not.toBe("skipped");
	});
});

// ---------------------------------------------------------------------------
// Group 5 + 6 — success persistence (recordStageSuccess + recordPhaseSuccess)
// ---------------------------------------------------------------------------

describe("sessions — success persistence", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-success-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("side-effect with a collector emitting one artifact records the manifest but does NOT advance the chain primary", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();

		// Side-effect outcome that produces an artifact (e.g. a commit-style
		// stage). manifest.artifacts records it; primaryArtifact stays
		// undefined because only produces stages advance the chain
		// input.
		const recorded = ".rpiv/artifacts/research/from-collector.md";
		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({
					kind: "side-effect",
					outcome: {
						collector: {
							collect: () => ({
								kind: "ok",
								artifacts: [{ handle: fsHandle(recorded), role: "primary" }],
							}),
						},
					},
				}),
			}),
		);

		expect(state.manifest?.artifacts[0]?.handle).toEqual({ kind: "fs", path: recorded });
		// Chain primary stays put — side-effect never advances the rolling slot.
		expect(state.primaryArtifact).toBeUndefined();
	});

	it("produces advances state.primaryArtifact to the collector's first artifact", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const path = ".rpiv/artifacts/research/r.md";

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({
					kind: "produces",
					outcome: {
						collector: {
							collect: () => ({
								kind: "ok",
								artifacts: [{ handle: fsHandle(path), role: "primary" }],
							}),
						},
					},
				}),
			}),
		);

		expect(state.primaryArtifact?.handle).toEqual({ kind: "fs", path });
		expect(currentPrimaryArtifact(state)?.handle).toEqual({ kind: "fs", path });
	});

	it("stagesCompleted bumps exactly once per successful stage", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({ kind: "side-effect" }),
			}),
		);

		expect(state.stagesCompleted).toBe(1);
		expect(state.lastAllocatedStageNumber).toBe(1);
	});

	it("phase session: row label is `<skill> (phase N/total)`, never notifies completion", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});

		const phase: FanoutSession = {
			cwd: tmpDir,
			runId: "run-test",
			state,
			prompt: "/skill:implement phase",
			skill: "implement",
			unitIndex: 2,
			label: "phase 2/4",
			stageIndex: 1,
			onSuccess,
		};

		await runFanoutSession(chain.ctx as RunnerCtx, phase);

		expect(onSuccess).toHaveBeenCalledTimes(1);
		const rows = readStageRows(tmpDir);
		expect(rows[0]?.skill).toBe("implement (phase 2/4)");
		// Phase rows MUST NOT notify — the parent stage owns the completion banner.
		expect(chain.notifications.some((n) => /completed/.test(n.msg))).toBe(false);
	});

	it("phase session with empty branch → haltPhase records failed row, no onSuccess", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [] }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});

		const phase: FanoutSession = {
			cwd: tmpDir,
			runId: "run-test",
			state,
			prompt: "/skill:implement phase",
			skill: "implement",
			unitIndex: 1,
			label: "phase 1/2",
			stageIndex: 0,
			onSuccess,
		};

		await runFanoutSession(chain.ctx as RunnerCtx, phase);

		expect(onSuccess).not.toHaveBeenCalled();
		const rows = readStageRows(tmpDir);
		// Phase halt writes a "failed" row via recordStopFailure → noResponse arm.
		expect(rows[0]?.status).toBe("failed");
		expect(rows[0]?.skill).toBe("implement");
	});
});

// ---------------------------------------------------------------------------
// Group 7 — halt routing matrix
// ---------------------------------------------------------------------------

describe("sessions — halt routing", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-halt-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("noResponse → MSG_STAGE_NO_RESPONSE notify + failed row + state.termination.error", async () => {
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [{ branch: [] }] });
		const state = freshRunState();
		const onFailure = vi.fn();

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				onFailure,
			}),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_NO_RESPONSE("test"))).toBe(true);
		expect(state.termination.error).toMatch(/no assistant message/);
	});

	it("aborted → MSG_STAGE_ABORTED notify + aborted row + ESC error string", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("partial", "aborted")] }],
		});
		const state = freshRunState();
		const onFailure = vi.fn();

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				onFailure,
			}),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_ABORTED("test"))).toBe(true);
		expect(state.termination.error).toMatch(/aborted by user/);
		const rows = readStageRows(tmpDir);
		expect(rows[0]?.status).toBe("aborted");
	});

	it("outcome fatal (no validation) → MSG_STAGE_FAILED notify + raw outcome message", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onFailure = vi.fn();

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({
					kind: "side-effect",
					outcome: { collector: { collect: () => ({ kind: "fatal", message: "outcome said no" }) } },
				}),
				onFailure,
			}),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_FAILED("test"))).toBe(true);
		expect(state.termination.error).toBe("outcome said no");
	});
});
