/**
 * Tests for sessions.ts — the per-stage / per-phase session orchestrator.
 *
 * Drives the two public entries (`runStageSession`, `runFanoutSession`) against
 * synthetic StageSession / FanoutSession objects so internals (retryUntilValid,
 * resolveExtractor, readSessionOutcome, spawnSession, recordStageSuccess, halt
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
import type { NodeDef, NodeSchema } from "./api.js";
import { currentArtifactPath } from "./internal-utils.js";
import type { ExtractCtx, ExtractFn, ExtractResult, Outcome } from "./manifest.js";
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
	fallbackArtifactPath: undefined,
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

/** Minimal skill node — fresh policy, agent-end (no artifact extraction by default). */
const node = (overrides: Partial<NodeDef> = {}): NodeDef => ({
	skill: "test",
	completionStrategy: "agent-end",
	sessionPolicy: "fresh",
	...overrides,
});

/**
 * Build a StageSession with sensible defaults. Caller MUST supply cwd + state
 * (shared with the JSONL audit write) and any node/onSuccess overrides.
 */
const stageSession = (overrides: Partial<StageSession> & Pick<StageSession, "cwd" | "state">): StageSession => ({
	runId: "run-test",
	prompt: "/skill:test arg",
	skill: "test",
	node: node(),
	stageIndex: 0,
	baseline: undefined,
	onSuccess: async () => {},
	...overrides,
});

/** Stateful extract function: returns scripted payloads in sequence; ignores branch. */
const scriptedExtract = (results: ExtractResult[]): ExtractFn => {
	let i = 0;
	return () => {
		const r = results[i] ?? results[results.length - 1]!;
		i++;
		return r;
	};
};

/** Convenience: wrap a scripted extract fn as an Outcome (no `before`). */
const scriptedOutcome = (results: ExtractResult[]): Outcome => ({ extract: scriptedExtract(results) });

const okPayload = (data: unknown): ExtractResult => ({
	kind: "ok",
	payload: { kind: "test", data: data as Record<string, unknown> },
});

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
				node: node({ outputSchema: FOO_EQ_2_SCHEMA, outcome: scriptedOutcome([okPayload({ foo: 2 })]) }),
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
				node: node({
					outputSchema: FOO_EQ_2_SCHEMA,
					maxValidationRetries: 2,
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
				node: node({
					outputSchema: FOO_EQ_2_SCHEMA,
					maxValidationRetries: 1,
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

	it("clamps maxValidationRetries above the ceiling (MAX_VALIDATION_RETRIES)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const extract = vi.fn(scriptedExtract([okPayload({ foo: 1 })]));
		const outcome: Outcome = { extract };

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				node: node({
					outputSchema: FOO_EQ_2_SCHEMA,
					// Far above ceiling — must clamp to MAX_VALIDATION_RETRIES.
					maxValidationRetries: MAX_VALIDATION_RETRIES + 50,
					outcome,
				}),
			}),
		);

		// Initial extract + MAX retries → MAX+1 calls total.
		expect(extract).toHaveBeenCalledTimes(MAX_VALIDATION_RETRIES + 1);
		// One MSG_VALIDATION_RETRY per retry attempt.
		const retries = chain.notifications.filter((n) => /asking agent to fix/i.test(n.msg));
		expect(retries).toHaveLength(MAX_VALIDATION_RETRIES);
	});

	it("onValidationFailure='halt' skips retries — outcome called once, exhausted immediately", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const extract = vi.fn(scriptedExtract([okPayload({ foo: 1 })]));
		const outcome: Outcome = { extract };
		const onFailure = vi.fn();

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				node: node({
					outputSchema: FOO_EQ_2_SCHEMA,
					onValidationFailure: "halt",
					maxValidationRetries: 3,
					outcome,
				}),
				onFailure,
			}),
		);

		expect(extract).toHaveBeenCalledTimes(1);
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
				node: node({
					outputSchema: FOO_EQ_2_SCHEMA,
					maxValidationRetries: 1,
					validationRetryTimeoutMs: 1_000,
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
				node: node({
					outputSchema: FOO_EQ_2_SCHEMA,
					maxValidationRetries: 2,
					outcome: scriptedOutcome([
						okPayload({ foo: 1 }),
						{ kind: "fatal", message: "outcome blew up mid-retry" },
					]),
				}),
				onFailure,
			}),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(state.termination.error).toContain("outcome blew up mid-retry");
	});

	it("outcome returning undefined payload on retry → fatal with explicit message", async () => {
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
				node: node({
					outputSchema: FOO_EQ_2_SCHEMA,
					maxValidationRetries: 2,
					outcome: scriptedOutcome([
						okPayload({ foo: 1 }),
						{ kind: "ok", payload: undefined }, // ok-no-payload on retry — sessions.ts must synthesize fatal
					]),
				}),
				onFailure,
			}),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(state.termination.error).toMatch(/outcome returned no manifest on retry 1/);
	});

	it("clamps validationRetryTimeoutMs above ceiling", async () => {
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
				node: node({
					outputSchema: FOO_EQ_2_SCHEMA,
					maxValidationRetries: 1,
					validationRetryTimeoutMs: MAX_VALIDATION_RETRY_TIMEOUT_MS * 100,
					outcome: scriptedOutcome([okPayload({ foo: 1 }), okPayload({ foo: 2 })]),
				}),
			}),
		);

		// No timeout error surfaced → clamp held.
		expect(chain.notifications.some((n) => /exceeded/.test(n.msg))).toBe(false);
		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_COMPLETE("test"))).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Q15+IC — an async-returning schema that slipped past the load-time
	// `isAsyncSchema` probe (or a programmatic runWorkflow that bypassed
	// loadWorkflows entirely) used to throw from validateManifestData,
	// escape retryUntilValid → postStage, and land in runStageOrRecordFailure's
	// outer catch as MSG_STAGE_THREW — the wrong error class for a schema
	// constraint the workflow author owns. validateOrFatal funnels the
	// throw through the canonical kind:"fatal" path so the failure carries
	// the right error class (MSG_STAGE_FAILED via haltStageWithExtractionError),
	// fires onFailure, and exits cleanly without escaping the session.
	// -----------------------------------------------------------------------
	it("async-returning schema halts the stage via fatal-extraction, not via an escaped throw", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});
		const onFailure = vi.fn();

		// Hand-rolled async Standard Schema: validate() returns a Promise. The
		// runtime guard at validate-manifest.ts:70 throws synchronously when it sees
		// the Promise result; validateOrFatal catches and converts to fatal.
		const asyncSchema: NodeSchema<unknown, unknown> = {
			"~standard": {
				version: 1,
				vendor: "test-async",
				validate: () => Promise.resolve({ issues: [] }),
			},
		};

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				node: node({ outputSchema: asyncSchema, outcome: scriptedOutcome([okPayload({ foo: 2 })]) }),
				onSuccess,
				onFailure,
			}),
		);

		// Stage halted cleanly — onSuccess never ran, onFailure did.
		expect(onSuccess).not.toHaveBeenCalled();
		expect(onFailure).toHaveBeenCalledTimes(1);

		// Right error class: MSG_STAGE_FAILED (fatal-extraction path).
		// NOT MSG_STAGE_THREW (which would mean the throw escaped).
		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_FAILED("test"))).toBe(true);
		expect(chain.notifications.some((n) => /failed to start/.test(n.msg))).toBe(false);

		// state.termination.error carries the schema-shape diagnostic prefixed by skill,
		// so the user can find the offending node.
		expect(state.termination.error).toMatch(/test:.*async schema validation is not supported/);

		// JSONL row was written (not orphan) and attributed to `test`.
		const rows = readStageRows(tmpDir);
		const failedRows = rows.filter((r) => r.status === "failed");
		expect(failedRows).toHaveLength(1);
		expect(failedRows[0]?.skill).toBe("test");
	});
});

// ---------------------------------------------------------------------------
// Group 2 — outcome resolution (resolveExtractor)
// ---------------------------------------------------------------------------

describe("sessions — outcome resolution", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-outcome-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("explicit node.outcome wins over completionStrategy default", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const explicitExtract = vi.fn(scriptedExtract([okPayload({ tag: "explicit" })]));
		const explicit: Outcome = { extract: explicitExtract };

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				// artifact-emit would default to artifactMdOutcome (which would fatal — no
				// .rpiv/artifacts/... in the branch). The explicit outcome MUST win.
				node: node({ completionStrategy: "artifact-emit", outcome: explicit }),
			}),
		);

		expect(explicitExtract).toHaveBeenCalledTimes(1);
		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_COMPLETE("test"))).toBe(true);
	});

	it("artifact-emit default routes to artifactMdOutcome (fatal when no artifact in branch)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("no artifact mentioned here")] }],
		});
		const state = freshRunState();
		const onFailure = vi.fn();

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				node: node({ completionStrategy: "artifact-emit" }),
				onFailure,
			}),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(state.termination.error).toMatch(/finished without producing a \.rpiv\/artifacts/);
	});

	it("agent-end default routes to sideEffectOutcome (inherits prior artifact path)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState({ fallbackArtifactPath: ".rpiv/artifacts/research/r.md" });
		const onSuccess = vi.fn(async () => {});

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				node: node({ completionStrategy: "agent-end" }),
				onSuccess,
			}),
		);

		expect(onSuccess).toHaveBeenCalledTimes(1);
		// sideEffectOutcome pulls currentArtifactPath(state) into
		// manifest.artifact_path; recordStageSuccess then sets state.manifest.
		expect(state.manifest?.artifact_path).toBe(".rpiv/artifacts/research/r.md");
	});
});

// ---------------------------------------------------------------------------
// Group 3 — ExtractCtx contract (readSessionOutcome + buildExtractCtx)
//
// Post-L6-05: ExtractCtx.branch is ALWAYS the full unsliced branch;
// branchOffset is ALWAYS the policy-derived offset (continue → captured
// stage offset; fresh → undefined). Extractors slice on demand via the
// `offsetStart` parameter on `extractArtifactPath` / `classifyStop`. The
// initial extraction and the retry path emit the same offset value —
// the closed-I4 defect cannot re-introduce by construction.
// ---------------------------------------------------------------------------

describe("sessions — outcome ctx (always-unsliced branch + policy-derived offset)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-slice-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("continue policy: full unsliced branch + branchOffset = captured stage offset", async () => {
		const captured: ExtractCtx[] = [];
		const recordingOutcome: Outcome = {
			extract: (ctx) => {
				captured.push(ctx);
				return okPayload({});
			},
		};

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
				node: node({ sessionPolicy: "continue", outcome: recordingOutcome }),
				branchOffset: priorPrefix.length,
				pi: mockPi,
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
		const captured: ExtractCtx[] = [];
		let firstCall = true;
		const failThenPassOutcome: Outcome = {
			extract: (ctx) => {
				captured.push(ctx);
				// First call: schema-invalid → triggers retry.
				// Subsequent calls: schema-valid.
				const data = firstCall ? { foo: 0 } : { foo: 2 };
				firstCall = false;
				return okPayload(data);
			},
		};

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
				node: node({
					sessionPolicy: "continue",
					outputSchema: FOO_EQ_2_SCHEMA,
					outcome: failThenPassOutcome,
				}),
				branchOffset: priorPrefix.length,
				pi: mockPi,
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
		const captured: ExtractCtx[] = [];
		const recordingOutcome: Outcome = {
			extract: (ctx) => {
				captured.push(ctx);
				return okPayload({});
			},
		};
		const branch = [mockAssistantMessage("done")];
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [{ branch }] });

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				node: node({ sessionPolicy: "fresh", outcome: recordingOutcome }),
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
				node: node({ sessionPolicy: "continue" }),
				branchOffset: 0,
				pi: mockPi,
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
				node: node({ sessionPolicy: "continue" }),
				branchOffset: 0,
				pi: mockPi,
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

	it("manifest.artifact_path wins over the transcript-extracted artifact", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("see .rpiv/artifacts/research/from-transcript.md")] }],
		});
		const state = freshRunState();

		// Outcome declares a DIFFERENT artifact_path than what the transcript holds —
		// manifest's path is the authoritative source.
		const manifestPath = ".rpiv/artifacts/research/from-manifest.md";
		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				node: node({
					completionStrategy: "agent-end",
					outcome: {
						extract: () => ({ kind: "ok", payload: { kind: "test", artifact_path: manifestPath, data: {} } }),
					},
				}),
			}),
		);

		expect(state.manifest?.artifact_path).toBe(manifestPath);
		expect(currentArtifactPath(state)).toBe(manifestPath);
	});

	it("no manifest.artifact_path → falls back to outcome.artifact from transcript", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md")] }],
		});
		const state = freshRunState();

		await runStageSession(
			chain.ctx as RunnerCtx,
			stageSession({
				cwd: tmpDir,
				state,
				// agent-end + sideEffectOutcome leaves artifact_path = currentArtifactPath(state) (undefined),
				// so no manifest is set; the transcript-extracted path lands in fallbackArtifactPath.
				node: node({ completionStrategy: "agent-end" }),
			}),
		);

		expect(state.fallbackArtifactPath).toBe(".rpiv/artifacts/research/r.md");
		expect(currentArtifactPath(state)).toBe(".rpiv/artifacts/research/r.md");
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
				node: node({ completionStrategy: "agent-end" }),
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
				node: node({
					completionStrategy: "agent-end",
					outcome: { extract: () => ({ kind: "fatal", message: "outcome said no" }) },
				}),
				onFailure,
			}),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_FAILED("test"))).toBe(true);
		expect(state.termination.error).toBe("outcome said no");
	});
});
