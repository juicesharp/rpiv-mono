/**
 * Tests for sessions.ts — the per-stage session orchestrator.
 *
 * Drives the sole public entry (`executeStageSession`) against synthetic
 * StageSessionContext objects so internals (retryUntilValid, runOutcome,
 * readSessionOutcome, spawnSession, recordStageSuccess, halt helpers) are
 * exercised at a finer grain than runner.test.ts can reach via runWorkflow.
 *
 * Wiring strategy: every test allocates a temp cwd (audit writes JSONL there)
 * and feeds executeStageSession either a `createMockSessionChain` ctx (fresh path,
 * scripted branch) or a hand-rolled WorkflowHostContext (continue path, outer branch).
 * Stage nodes carry custom `outcome` functions that close over an attempt
 * counter — this is how we drive retry-loop scenarios without mutating the
 * mock branch between attempts.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StageDef, StageSchema, Workflow } from "./api.js";
import { currentPrimaryArtifact } from "./chain-state.js";
import { LifecycleDispatcher } from "./events.js";
import { type Artifact, fs as fsHandle } from "./handle.js";
import { WorkflowAbortError } from "./internal-utils.js";
import {
	ERR_VALIDATE_RETRY_UNCHANGED,
	FAIL_STAGE_NO_RESPONSE,
	FAIL_VALIDATION_EXHAUSTED,
	MSG_STAGE_FAILED,
} from "./messages.js";
import { finalizeOutput, type Output, outputMeta } from "./output.js";
import type { CollectContext, Outcome } from "./output-spec.js";
import { reconstructState } from "./runner/resume.js";
import {
	handleRetry,
	produceAttempt,
	type RetryDeps,
	validateOutput,
	worktreeUnchangedSince,
} from "./sessions/extraction.js";
import { executeStageSession } from "./sessions/index.js";
import { appendHeader, appendStage, STATE_SCHEMA_VERSION, type WorkflowHeader } from "./state/index.js";
import { DEFAULT_TRIGGER } from "./triggers.js";
import { typeboxSchema } from "./typebox-adapter.js";
import type { RunState, StageSessionContext, WorkflowHostContext, WorkflowSessionContext } from "./types.js";

/** Default test wiring for SessionContext's lifecycle + runIdentity fields. */
const testLifecycle = () => new LifecycleDispatcher(undefined);
const testRunIdentity = (overrides: Partial<{ workflow: string; totalStages: number }> = {}) => ({
	workflow: "test-wf",
	totalStages: 1,
	trigger: DEFAULT_TRIGGER,
	...overrides,
});

import { MAX_VALIDATION_RETRIES, MAX_VALIDATION_RETRY_TIMEOUT_MS } from "./validate-output.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Bare RunState — every field nullish/zero so tests pin the deltas sessions.ts produces. */
const freshRunState = (overrides: Partial<RunState> = {}): RunState => ({
	originalInput: "x",
	primaryArtifact: undefined,
	output: undefined,
	named: {},
	stagesCompleted: 0,
	lastAllocatedStageNumber: 0,
	telemetry: {
		backwardJumps: 0,
		droppedRoutingRows: [],
		droppedFailureRows: [],
	},
	failureMemos: [],
	termination: { status: "running" },
	...overrides,
});

/** Minimal skill stage — fresh policy, side-effect (no artifact extraction by default). */
const stage = (overrides: Partial<StageDef> = {}): StageDef =>
	({
		skill: "test",
		kind: "side-effect",
		sessionPolicy: "fresh",
		...overrides,
	}) as StageDef;

/**
 * Build a StageSessionContext with sensible defaults. Caller MUST supply cwd + state
 * (shared with the JSONL audit write) and any stage/onSuccess overrides.
 */
const stageSession = (
	overrides: Partial<StageSessionContext> & Pick<StageSessionContext, "cwd" | "state">,
): StageSessionContext => ({
	runId: "run-test",
	prompt: "/skill:test arg",
	stageName: "test",
	skill: "test",
	lifecycle: testLifecycle(),
	runIdentity: testRunIdentity(),
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

type ScriptedOutcome = Outcome & { collectSpy: ReturnType<typeof vi.fn> };

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
	const outcome: Outcome = {
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
	const dir = join(cwd, ".rpiv", "workflows", "runs");
	const files = readdirSync(dir);
	const lines = readFileSync(join(dir, files[0]!), "utf-8").trim().split("\n");
	return lines.map((l) => JSON.parse(l));
};

// ---------------------------------------------------------------------------
// Retry-loop coverage (retryUntilValid + extractAndValidateOutput)
// ---------------------------------------------------------------------------

describe("sessions — validation retry loop", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-retry-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("passes on first extract — no retry, no fix-request prompt sent", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({ outputSchema: FOO_EQ_2_SCHEMA, outcome: scriptedOutcome([okPayload({ foo: 2 })]) }),
				onSuccess,
			}),
		);

		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(chain.sentMessages.find((m) => m.includes("doesn't satisfy the expected output schema"))).toBeUndefined();
		expect(readStageRows(tmpDir).some((r) => r.status === "completed")).toBe(true);
		expect(state.stagesCompleted).toBe(1);
	});

	it("retries once after invalid output, then succeeds", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
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
		// One retry attempt → exactly one fix-request prompt sent into the child session
		// (the fix-request prompt appears in sentMessages between initial prompt and success).
		const retryPrompts = chain.sentMessages.filter((m) => m.includes("doesn't satisfy the expected output schema"));
		expect(retryPrompts).toHaveLength(1);
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

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
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
		expect(chain.notifications.some((n) => n.msg === FAIL_VALIDATION_EXHAUSTED("test", "").toast)).toBe(true);
		expect(state.termination.error).toMatch(
			new RegExp(FAIL_VALIDATION_EXHAUSTED("test", "foo").error.split(":")[0] ?? ""),
		);
		expect(state.termination.error).toContain("foo:");
	});

	it("clamps maxRetries above the ceiling (MAX_VALIDATION_RETRIES)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const outcome = scriptedOutcome([okPayload({ foo: 1 })]);

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
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
		// One fix-request prompt per retry attempt.
		const retries = chain.sentMessages.filter((m) => m.includes("doesn't satisfy the expected output schema"));
		expect(retries).toHaveLength(MAX_VALIDATION_RETRIES);
	});

	it("onInvalid='halt' skips retries — outcome called once, exhausted immediately", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const outcome = scriptedOutcome([okPayload({ foo: 1 })]);
		const onFailure = vi.fn();

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
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
		expect(chain.sentMessages.find((m) => m.includes("doesn't satisfy the expected output schema"))).toBeUndefined();
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
		// In the detached model the HOST sends the initial prompt inside spawnChild;
		// the ONLY sendUserMessage inside withSession is the validation-retry
		// roundtrip (resendIntoChild). Override it to hang forever so withTimeout
		// converts the stall into a fatal halt rather than an unhandled rejection.
		const realSpawnChild = chain.ctx.spawnChild as (o: unknown) => Promise<unknown>;
		(chain.ctx as { spawnChild: unknown }).spawnChild = vi.fn(
			async (opts: { prompt: string; withSession?: (c: unknown) => Promise<void> }) => {
				return realSpawnChild({
					...opts,
					withSession: async (freshCtx: unknown) => {
						(freshCtx as { sendUserMessage: (m: string) => Promise<void> }).sendUserMessage = () =>
							new Promise<void>(() => {});
						if (opts.withSession) await opts.withSession(freshCtx);
					},
				});
			},
		);

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
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

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
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

	it("retry/end lifecycle refs and the row share ONE allocator-based stage number", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		// Simulate prior loop units having burned numbers 1..5 — graph index
		// (stageIndex 0) and allocator value (6) diverge, so a retry ref built
		// from `stageIndex + 1` would read 1 while the end ref reads 6.
		const state = freshRunState({ lastAllocatedStageNumber: 5 });
		const refs: Array<{ event: string; stageNumber: number }> = [];
		const lifecycle = new LifecycleDispatcher({
			onStageRetry: (ref) => void refs.push({ event: "retry", stageNumber: ref.stageNumber }),
			onStageEnd: (ref) => void refs.push({ event: "end", stageNumber: ref.stageNumber }),
		});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				lifecycle,
				stage: stage({
					outputSchema: FOO_EQ_2_SCHEMA,
					maxRetries: 2,
					outcome: scriptedOutcome([okPayload({ foo: 1 }), okPayload({ foo: 2 })]),
				}),
			}),
		);

		// One numbering base for the whole activation — listeners can correlate.
		expect(refs).toEqual([
			{ event: "retry", stageNumber: 6 },
			{ event: "end", stageNumber: 6 },
		]);
		// The JSONL row and the output envelope carry the same pre-allocated
		// number — no `lastAllocatedStageNumber + 1` peek skew.
		const rows = readStageRows(tmpDir).filter((r) => typeof r.stageNumber === "number");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.stageNumber).toBe(6);
		expect((rows[0]?.output as { meta?: { stageNumber?: number } })?.meta?.stageNumber).toBe(6);
	});

	it("a THROWING collector halts with attributed wording, not an escaped machinery throw", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onFailure = vi.fn();

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({
					outcome: {
						collector: {
							collect: () => {
								throw new Error("custom collector bug");
							},
						},
					},
				}),
				onFailure,
			}),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		// Attributed to the collector — the primary extension point — not to
		// stage-start machinery.
		expect(state.termination.error).toContain("outcome collector threw");
		expect(state.termination.error).toContain("custom collector bug");
		expect(chain.notifications.some((n) => n.msg === MSG_STAGE_FAILED("test"))).toBe(true);
	});

	it("a THROWING parser halts with attributed wording", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onFailure = vi.fn();

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({
					outcome: {
						collector: { collect: () => ({ kind: "ok", artifacts: [{ handle: fsHandle("a.md") }] }) },
						parser: {
							parse: () => {
								throw new Error("custom parser bug");
							},
						},
					},
				}),
				onFailure,
			}),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(state.termination.error).toContain("outcome parser threw");
		expect(state.termination.error).toContain("custom parser bug");
	});

	// Removed: "outcome returning undefined payload on retry" — the new
	// collector/parser split has no `ok-no-payload` state. An empty
	// collector result on an produces stage fatals at the contract
	// check (enforceCompletionContract); the equivalent behaviour for
	// side-effect nodes is "inherit prior" which is the success path, not
	// a halt.

	it("clamps validateTimeoutMs above ceiling", async () => {
		// Smoke: timeoutMs above ceiling must clamp. We assert the clamp
		// indirectly via the retry loop completing without a timeout error.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
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
		expect(readStageRows(tmpDir).some((r) => r.status === "completed")).toBe(true);
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

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
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
		expect(readStageRows(tmpDir).some((r) => r.status === "completed")).toBe(true);
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

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
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

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
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
// Direct unit tests for the extracted retry-loop members
// (produceAttempt / validateOutput / handleRetry / worktreeUnchangedSince).
// The behavior-preservation guard above drives the same hooks end-to-end via
// executeStageSession; these pin each extracted member's contract at the seam.
// ---------------------------------------------------------------------------

describe("sessions — extracted retry hooks (direct)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-hooks-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Minimal Output envelope for a direct-hook call (shape only — no audit write). */
	const mkOutput = (data: unknown): Output =>
		finalizeOutput(
			{ kind: "test", artifacts: [], data },
			outputMeta({
				stage: "test",
				skill: "test",
				stageNumber: 1,
				ts: "2026-01-01T00:00:00.000Z",
				runId: "run-test",
			}),
		);

	/** `RetryDeps.finalize` mirror: respects the collector/parser `parts` (kind +
	 *  data) the way `wrapOutput` does on the live path, so a re-produced value
	 *  flows into the Output envelope byte-identically. */
	const testFinalize = (parts: { kind: string; artifacts: readonly Artifact[]; data: unknown }): Output =>
		finalizeOutput(
			parts,
			outputMeta({
				stage: "test",
				skill: "test",
				stageNumber: 1,
				ts: "2026-01-01T00:00:00.000Z",
				runId: "run-test",
			}),
		);

	/** The predicate reads only `cwd` + `worktreeDigest`; a partial cast is the
	 *  minimal honest fixture (the other StageSessionContext fields are unused). */
	const digestSession = (worktreeDigest: () => string | undefined): StageSessionContext =>
		({ cwd: tmpDir, worktreeDigest }) as unknown as StageSessionContext;

	it("worktreeUnchangedSince: undefined baseline → false (degrade, never skip)", () => {
		// resolveDigest is NEVER called when the baseline is undefined — short-circuits.
		expect(
			worktreeUnchangedSince(
				undefined,
				digestSession(() => "fixed-digest"),
			),
		).toBe(false);
	});

	it("worktreeUnchangedSince: equal digest → true", () => {
		expect(
			worktreeUnchangedSince(
				"same",
				digestSession(() => "same"),
			),
		).toBe(true);
	});

	it("worktreeUnchangedSince: differing digest → false", () => {
		expect(
			worktreeUnchangedSince(
				"before-fix",
				digestSession(() => "after-fix"),
			),
		).toBe(false);
	});

	it("worktreeUnchangedSince: undefined current (non-repo) with a defined baseline → false (proceed)", () => {
		// A defined baseline but a missing current signal degrades to proceed.
		expect(
			worktreeUnchangedSince(
				"some-baseline",
				digestSession(() => undefined),
			),
		).toBe(false);
	});

	it("validateOutput: schema-valid output → { ok, result.valid:true }", async () => {
		const result = await validateOutput(FOO_EQ_2_SCHEMA, "test", 5_000, mkOutput({ foo: 2 }));
		expect(result).toEqual({ kind: "ok", result: { valid: true, failures: [] } });
	});

	it("validateOutput: schema-invalid output → { ok, result.valid:false } (the loop drives the retry)", async () => {
		const result = await validateOutput(FOO_EQ_2_SCHEMA, "test", 5_000, mkOutput({ foo: 1 }));
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.result.valid).toBe(false);
		expect(result.result.failures.length).toBeGreaterThan(0);
	});

	it("validateOutput: a rejecting schema maps onto the { aborted } arm (fatal, not retried)", async () => {
		const rejecting: StageSchema<unknown, unknown> = {
			"~standard": { version: 1, vendor: "test-reject", validate: () => Promise.reject(new Error("boom")) },
		};
		const result = await validateOutput(rejecting, "test", 5_000, mkOutput({ foo: 2 }));
		expect(result.kind).toBe("aborted");
		if (result.kind !== "aborted") return;
		expect(result.abort).toEqual({ kind: "fatal", message: expect.stringContaining("boom") });
	});

	it("produceAttempt: attempt 0 returns the initial Output without re-collection", async () => {
		const outcome = scriptedOutcome([okPayload({ foo: 1 })]);
		const deps: RetryDeps = {
			outcome,
			collectCtx: {
				cwd: tmpDir,
				runId: "run-test",
				stageIndex: 0,
				state: freshRunState(),
				branch: [],
				branchOffset: undefined,
				snapshot: undefined,
				skill: "test",
			},
			finalize: testFinalize,
		};
		const initial = mkOutput({ foo: 2 });

		// The fast path (`attempt === 0`) returns `initial` WITHOUT touching ctx, so a
		// bare stub is honest — produceAttempt never reads it on this branch.
		const result = await produceAttempt(
			{} as unknown as WorkflowSessionContext,
			stageSession({ cwd: tmpDir, state: freshRunState() }),
			deps,
			initial,
			0,
		);

		expect(result).toEqual({ kind: "ok", value: initial });
		// Fast-path: the collector is NEVER re-run for attempt 0.
		expect(outcome.collectSpy).not.toHaveBeenCalled();
	});

	it("produceAttempt: attempt > 0 re-reads the branch, re-runs the outcome, and returns the re-produced value", async () => {
		// A direct `produceAttempt(attempt=1)` call drives exactly ONE collect (the
		// initial produce ran outside this hook), so a single-result scripted
		// outcome is the honest fixture — its first collect returns this payload.
		const outcome = scriptedOutcome([okPayload({ foo: 2 })]);
		const deps: RetryDeps = {
			outcome,
			collectCtx: {
				cwd: tmpDir,
				runId: "run-test",
				stageIndex: 0,
				state: freshRunState(),
				branch: [],
				branchOffset: undefined,
				snapshot: undefined,
				skill: "test",
			},
			finalize: testFinalize,
		};
		// `attempt > 0` re-reads the branch via `readBranch(ctx)` — the only ctx surface it
		// touches — so a ctx carrying a scripted sessionManager is the minimal honest fixture.
		const ctx = {
			sessionManager: { getBranch: () => [mockAssistantMessage("done")] },
		} as unknown as WorkflowSessionContext;

		const result = await produceAttempt(
			ctx,
			stageSession({ cwd: tmpDir, state: freshRunState() }),
			deps,
			mkOutput({ foo: 1 }),
			1,
		);

		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		// The retry re-ran the collector once (the direct hook's single produce).
		expect(outcome.collectSpy).toHaveBeenCalledTimes(1);
		expect((result.value.data as { foo: number }).foo).toBe(2);
	});

	it("produceAttempt: attempt > 0 maps a fatal collector result onto the { aborted } arm", async () => {
		// One collect (the retry produce) returns the fatal payload directly.
		const outcome = scriptedOutcome([fatalPayload("collector died on retry")]);
		const deps: RetryDeps = {
			outcome,
			collectCtx: {
				cwd: tmpDir,
				runId: "run-test",
				stageIndex: 0,
				state: freshRunState(),
				branch: [],
				branchOffset: undefined,
				snapshot: undefined,
				skill: "test",
			},
			finalize: testFinalize,
		};
		const ctx = {
			sessionManager: { getBranch: () => [mockAssistantMessage("done")] },
		} as unknown as WorkflowSessionContext;

		const result = await produceAttempt(
			ctx,
			stageSession({ cwd: tmpDir, state: freshRunState() }),
			deps,
			mkOutput({ foo: 1 }),
			1,
		);

		expect(result).toEqual({ kind: "aborted", abort: { kind: "fatal", message: "collector died on retry" } });
	});

	/** Minimal child-ctx surface handleRetry touches: `ui.notify` (lifecycle.fire's
	 *  DispatchHost), `sendUserMessage` + `waitForIdle` (resendIntoChild via askAgentToFix). */
	const childCtx = (sent: string[]): WorkflowSessionContext =>
		({
			ui: { notify: vi.fn() },
			sendUserMessage: vi.fn(async (m: string) => void sent.push(m)),
			waitForIdle: vi.fn(async () => {}),
		}) as unknown as WorkflowSessionContext;

	it("handleRetry: fires onStageRetry, re-prompts the agent, and proceeds when the worktree changed", async () => {
		const sent: string[] = [];
		const onStageRetry = vi.fn();
		// handleRetry reads the digest TWICE: once for the baseline (before the fix),
		// once inside worktreeUnchangedSince (after). A mutable holder models the
		// agent's fix landing between the two reads — baseline "before-fix" then
		// current "after-fix" → tree changed → proceed.
		let read = 0;
		const s = stageSession({
			cwd: tmpDir,
			state: freshRunState(),
			lifecycle: new LifecycleDispatcher({ onStageRetry }),
			worktreeDigest: () => (read++ === 0 ? "before-fix" : "after-fix"),
		});

		const result = await handleRetry(childCtx(sent), s, 1, [], 5_000);

		expect(onStageRetry).toHaveBeenCalledTimes(1);
		// A fix-request prompt was sent into the child.
		expect(sent.some((m) => m.includes("doesn't satisfy the expected output schema"))).toBe(true);
		expect(result).toEqual({ kind: "ok" });
	});

	it("handleRetry: an unchanged worktree after the fix → { aborted } with the unchanged-worktree message", async () => {
		const sent: string[] = [];
		const s = stageSession({
			cwd: tmpDir,
			state: freshRunState(),
			// baseline === current → the fix changed nothing observable → abort.
			worktreeDigest: () => "frozen",
		});

		const result = await handleRetry(childCtx(sent), s, 1, [], 5_000);

		expect(result.kind).toBe("aborted");
		if (result.kind !== "aborted") return;
		expect(result.abort).toEqual({ kind: "fatal", message: ERR_VALIDATE_RETRY_UNCHANGED("test") });
	});
});

// ---------------------------------------------------------------------------
// Outcome resolution (resolveOutcome)
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

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({ kind: "produces", outcome: explicit }),
			}),
		);

		expect(explicit.collectSpy).toHaveBeenCalledTimes(1);
		expect(readStageRows(tmpDir).some((r) => r.status === "completed")).toBe(true);
	});

	it("produces without outcome throws (load-time validation should reject; runtime is defense-in-depth)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		// validateWorkflow rejects this at load — but this test goes
		// straight through executeStageSession, bypassing validation. The
		// runner's defense-in-depth throw must surface.
		await expect(
			executeStageSession(
				chain.ctx as WorkflowHostContext,
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

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({ kind: "side-effect" }),
				onSuccess,
			}),
		);

		expect(onSuccess).toHaveBeenCalledTimes(1);
		// Side-effect with no collector output → empty artifacts list on the
		// stage's output, but the chain's primaryArtifact rolling slot
		// stays put so the next stage inherits the upstream input.
		expect(state.output?.artifacts).toEqual([]);
		expect(state.primaryArtifact).toBe(prior);
		expect(currentPrimaryArtifact(state)).toBe(prior);
	});

	it("terminal side-effect (inheritsArtifacts: false) clears the rolling primary so downstream stages don't inherit", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const prior = { handle: fsHandle(".rpiv/artifacts/research/r.md"), role: "primary" };
		const state = freshRunState({ primaryArtifact: prior });
		const onSuccess = vi.fn(async () => {});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({ kind: "side-effect", inheritsArtifacts: false }),
				onSuccess,
			}),
		);

		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(state.output?.artifacts).toEqual([]);
		// Terminal explicitly breaks the chain — anything downstream starts
		// without an inherited artifact.
		expect(state.primaryArtifact).toBeUndefined();
		expect(currentPrimaryArtifact(state)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// CollectContext contract (readSessionOutcome + buildCollectCtx)
//
// CollectContext.branch is ALWAYS the full unsliced branch; branchOffset is
// ALWAYS the policy-derived offset (continue → captured stage offset;
// fresh → undefined). Collectors slice on demand via the `branchOffset`
// field. The initial production and the retry path emit the same offset
// value — the prior pre-slicing defect cannot re-introduce by
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

	const recordingOutcomeOf = (results: ScriptedResult[], captured: CollectContext[]): Outcome => {
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
		const captured: CollectContext[] = [];
		const recordingOutcome = recordingOutcomeOf([okPayload({})], captured);

		// Child branch (continue path) — contains prior-stage prefix + current-stage tail.
		const priorPrefix = [mockAssistantMessage("prior stage output")];
		const currentTail = [mockAssistantMessage("current stage output")];
		const childBranch = [...priorPrefix, ...currentTail];

		// postStage scopes a continue stage's outcome by the offset on its session
		// (`branchOffsetFor` returns the captured value for continue) — the mechanism
		// the live continue body re-derives from the forked branch and the resume
		// path takes from the persisted row. Driven here through `executeStageSession`
		// with an explicit `branchOffset` to test the slicing in isolation.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: childBranch }],
		});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({ sessionPolicy: "continue", outcome: recordingOutcome }),
				branchOffset: priorPrefix.length,
			}),
		);

		expect(captured).toHaveLength(1);
		// Branch is the FULL unsliced child branch.
		expect(captured[0]?.branch).toHaveLength(childBranch.length);
		// branchOffset carries the captured stage offset so extractArtifactPath
		// skips the prior-stage prefix on demand.
		expect(captured[0]?.branchOffset).toBe(priorPrefix.length);
	});

	it("continue policy + validation retry: initial + retry emit the same branchOffset", async () => {
		// Previously the initial extraction received a pre-sliced branch +
		// undefined offset while retry received the unsliced branch +
		// captured offset — an asymmetric pair a future refactor could
		// regress by touching one path and not the other. Both extractions
		// now emit identical `(full branch, captured offset)`.
		const captured: CollectContext[] = [];
		// First call: schema-invalid → triggers retry. Subsequent: schema-valid.
		const failThenPassOutcome = recordingOutcomeOf([okPayload({ foo: 0 }), okPayload({ foo: 2 })], captured);

		const priorPrefix = [mockAssistantMessage("prior stage output"), mockAssistantMessage("more prior")];
		const currentTail = [mockAssistantMessage("current stage output")];
		const childBranch = [...priorPrefix, ...currentTail];

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: childBranch }],
		});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({
					sessionPolicy: "continue",
					outputSchema: FOO_EQ_2_SCHEMA,
					outcome: failThenPassOutcome,
				}),
				branchOffset: priorPrefix.length,
			}),
		);

		// At least one retry should have fired.
		expect(captured.length).toBeGreaterThanOrEqual(2);
		// Initial + retry both see the FULL unsliced branch + captured offset.
		expect(captured[0]?.branch.length).toBeGreaterThanOrEqual(childBranch.length);
		expect(captured[0]?.branchOffset).toBe(priorPrefix.length);
		const retryCtx = captured[captured.length - 1]!;
		expect(retryCtx.branch.length).toBeGreaterThanOrEqual(childBranch.length);
		expect(retryCtx.branchOffset).toBe(priorPrefix.length);
	});

	it("fresh policy: full branch + branchOffset undefined (handler forces undefined regardless of stage carry)", async () => {
		const captured: CollectContext[] = [];
		const recordingOutcome = recordingOutcomeOf([okPayload({})], captured);
		const branch = [mockAssistantMessage("done")];
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [{ branch }] });

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({ sessionPolicy: "fresh", outcome: recordingOutcome }),
				// Stage's captured offset is set artificially here; a fresh stage's
				// session is never assigned one in production. `branchOffsetFor`
				// short-circuits — fresh ALWAYS emits `undefined`.
				branchOffset: 5,
			}),
		);

		expect(captured).toHaveLength(1);
		expect(captured[0]?.branch).toHaveLength(branch.length);
		expect(captured[0]?.branchOffset).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Spawn primitive (spawnSession + sendAndAwaitIdle)
// ---------------------------------------------------------------------------

describe("sessions — spawn primitive", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-spawn-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("continue policy spawns a detached child like fresh (no host); empty branch → failure row, not skipped", async () => {
		// Continue collapses to a detached child — it no longer skips spawn or
		// leans on a registry-host fallback (the old CONTINUE_HANDLER path is
		// gone). An empty child branch is "noResponse" (recordStopFailure →
		// onFailure), never a cancellation / skipped row.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [] }],
		});
		const onFailure = vi.fn();

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({ sessionPolicy: "continue" }),
				branchOffset: 0,
				onFailure,
			}),
		);

		expect(chain.ctx.spawnChild).toHaveBeenCalledTimes(1);
		expect(onFailure).toHaveBeenCalledTimes(1);
		const rows = readStageRows(tmpDir);
		expect(rows[0]?.status).not.toBe("skipped");
	});
});

// ---------------------------------------------------------------------------
// Success persistence (recordStageSuccess + recordPhaseSuccess)
// ---------------------------------------------------------------------------

describe("sessions — success persistence", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-success-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("side-effect with a collector emitting one artifact records the output but does NOT advance the chain primary", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();

		// Side-effect outcome that produces an artifact (e.g. a commit-style
		// stage). output.artifacts records it; primaryArtifact stays
		// undefined because only produces stages advance the chain
		// input.
		const recorded = ".rpiv/artifacts/research/from-collector.md";
		await executeStageSession(
			chain.ctx as WorkflowHostContext,
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

		expect(state.output?.artifacts[0]?.handle).toEqual({ kind: "fs", path: recorded });
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

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
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

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({ kind: "side-effect" }),
			}),
		);

		expect(state.stagesCompleted).toBe(1);
		expect(state.lastAllocatedStageNumber).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Halt routing matrix
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

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				onFailure,
			}),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(chain.notifications.some((n) => n.msg === FAIL_STAGE_NO_RESPONSE("test").toast)).toBe(true);
		expect(state.termination.error).toMatch(/no assistant message/);
	});

	it("aborted outcome → postStage throws WorkflowAbortError before any row write", async () => {
		// `session.abort()` makes the SDK RESOLVE `prompt()` with a
		// `stopReason:"aborted"` transcript message, so an aborted child runs
		// straight into postStage. postStage throws `WorkflowAbortError` BEFORE
		// any halt/row write, so: the run-stage seam classifies it as a
		// cooperative abort (recordAbortedAtSeam → FAIL_WORKFLOW_ABORTED) and a
		// collect-all unit's slot stays unfilled (resume re-dispatches). No row is
		// written here and `onFailure` does not fire.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("partial", "aborted")] }],
		});
		const state = freshRunState();
		const onFailure = vi.fn();

		await expect(
			executeStageSession(
				chain.ctx as WorkflowHostContext,
				stageSession({
					cwd: tmpDir,
					state,
					onFailure,
				}),
			),
		).rejects.toBeInstanceOf(WorkflowAbortError);

		expect(onFailure).not.toHaveBeenCalled();
		// No terminal row written: postStage threw before any audit write, so the
		// run trail directory was never created.
		expect(existsSync(join(tmpDir, ".rpiv", "workflows", "runs"))).toBe(false);
	});

	it("watchdog tool-timeout on a collect-all unit → soft-halt (onUnitHalt), NOT WorkflowAbortError", async () => {
		// A per-command bash watchdog aborts a runaway command: the child resolves with an
		// `aborted` stop AND the host reports a `toolTimeout` reason. postStage must NOT throw
		// WorkflowAbortError (that re-runs the same command on resume) — it routes through the
		// soft-halt gate, so a collect-all fan-out unit records a non-terminal failed row + a
		// sentinel (onSuccess), the run survives, and the gate can finalize.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{
					branch: [mockAssistantMessage("scanning", "aborted")],
					toolTimeout: { reason: "bash command exceeded the 180s per-command timeout and was aborted: `find /`" },
				},
			],
		});
		const state = freshRunState();
		const onUnitHalt = vi.fn();
		const onFailure = vi.fn();
		const onSuccess = vi.fn<(ctx: WorkflowHostContext, output: Output) => Promise<void>>(async () => {});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				stageName: "plan-grade (correctness)",
				skill: "judge",
				collectAll: true,
				bashTimeoutStrikes: 0, // pre-exhausted ⇒ the single-timeout step escalates exactly as today
				lifecycle: new LifecycleDispatcher({ onUnitHalt }),
				unit: { parent: "plan-grade", role: "verify", index: 1, id: "correctness", label: "correctness" },
				onSuccess,
				onFailure,
			}),
		);

		// Soft-halt: the timeout reason rides onUnitHalt, the fold gets its sentinel via onSuccess,
		// and no terminal failure fires (the run lives on).
		expect(onUnitHalt).toHaveBeenCalledTimes(1);
		expect(onUnitHalt.mock.calls[0]![2]).toContain("per-command timeout");
		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("infra-death stop (error) on a collect-all unit → HARD terminal fail, UNCOLLECTED row (resume re-dispatches)", async () => {
		// A dead child session (SDK/API error, OOM-killed process) must NOT be
		// collected: a `collected:true` row is a PERMANENT skip — the resume fold
		// rebuilds the sentinel and never re-dispatches the unit, turning one
		// transient infra death into an unrepairable hole downstream (the
		// slice-design → subplan-check incident). The hard failed row (no
		// `collected`) leaves the slot unfilled so resume re-dispatches this unit.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("partial", "error")] }],
		});
		const state = freshRunState();
		const onUnitHalt = vi.fn();
		const onStageError = vi.fn();
		const onSuccess = vi.fn<(ctx: WorkflowHostContext, output: Output) => Promise<void>>(async () => {});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				stageName: "slice-design (slice-2)",
				skill: "design-slice",
				collectAll: true,
				lifecycle: new LifecycleDispatcher({ onUnitHalt, onStageError }),
				unit: { parent: "slice-design", role: "produce", index: 1, id: "slice-2", label: "slice 2/3" },
				onSuccess,
			}),
		);

		// Terminal: the run stops; no soft-halt lifecycle, no sentinel handed to the fold.
		expect(state.termination.status).toBe("failed");
		expect(onStageError).toHaveBeenCalledTimes(1);
		expect(onUnitHalt).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();

		// The failed row is UNCOLLECTED and carries the unit identity the resume
		// drift guard reads — foldFanoutRow leaves its slot unfilled → re-dispatch.
		const failed = readStageRows(tmpDir).find((r) => r.status === "failed")!;
		expect(failed.collected).toBeUndefined();
		expect(failed.parent).toBe("slice-design");
		expect(failed.unitId).toBe("slice-2");
		expect(failed.unitIndex).toBe(1);
	});

	it("infra-death stop (noResponse) on a collect-all unit → HARD terminal fail, UNCOLLECTED row", async () => {
		// An empty child branch (the model never spoke — the child died before
		// producing anything) is the same infra-death class: hard-fail so resume
		// re-dispatches, never a collected skip.
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [{ branch: [] }] });
		const state = freshRunState();
		const onUnitHalt = vi.fn();
		const onSuccess = vi.fn<(ctx: WorkflowHostContext, output: Output) => Promise<void>>(async () => {});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				collectAll: true,
				lifecycle: new LifecycleDispatcher({ onUnitHalt }),
				unit: { parent: "slice-design", role: "produce", index: 0, id: "slice-1", label: "slice 1/3" },
				onSuccess,
			}),
		);

		expect(state.termination.status).toBe("failed");
		expect(onUnitHalt).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
		const failed = readStageRows(tmpDir).find((r) => r.status === "failed")!;
		expect(failed.collected).toBeUndefined();
		expect(failed.unitId).toBe("slice-1");
	});

	it("infra-death stop (toolUse) on a collect-all unit → HARD terminal fail, UNCOLLECTED row", async () => {
		// A transcript that ENDS on a tool request is a truncated agentic loop —
		// the signature of a child process killed mid-tool (e.g. the OOM killer).
		// Same routing as error/noResponse: hard-fail, uncollected, re-dispatchable.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("running bash…", "toolUse")] }],
		});
		const state = freshRunState();
		const onUnitHalt = vi.fn();
		const onSuccess = vi.fn<(ctx: WorkflowHostContext, output: Output) => Promise<void>>(async () => {});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				collectAll: true,
				lifecycle: new LifecycleDispatcher({ onUnitHalt }),
				unit: { parent: "slice-design", role: "produce", index: 2, id: "slice-3", label: "slice 3/3" },
				onSuccess,
			}),
		);

		expect(state.termination.status).toBe("failed");
		expect(onUnitHalt).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
		const failed = readStageRows(tmpDir).find((r) => r.status === "failed")!;
		expect(failed.collected).toBeUndefined();
		expect(failed.unitId).toBe("slice-3");
	});

	it("watchdog tool-timeout on a non-fan-out stage → terminal fail carrying the timeout reason", async () => {
		// Same abort+toolTimeout shape, but a plain (non-collect-all) stage: the soft-halt gate
		// falls through to a terminal failure whose errMsg is the watchdog reason.
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{
					branch: [mockAssistantMessage("scanning", "aborted")],
					toolTimeout: { reason: "bash command exceeded the 180s per-command timeout and was aborted: `find /`" },
				},
			],
		});
		const state = freshRunState();
		const onFailure = vi.fn();

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({ cwd: tmpDir, state, onFailure, bashTimeoutStrikes: 0 }),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(state.termination.error).toContain("per-command timeout");
	});

	it("outcome fatal (no validation) → MSG_STAGE_FAILED notify + raw outcome message", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onFailure = vi.fn();

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
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

	it("bash strike recovery: overrun → steering resent into the SAME child → resumed turn stops → completed + strike history", async () => {
		const reason = "bash command exceeded the 180s per-command timeout and was aborted: `find /`";
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{
					// Initial spawn: the first bash call overruns.
					branch: [mockAssistantMessage("scanning", "aborted")],
					toolTimeout: { reason },
					// Resumed turn after the steering resend: a normal completion, no timeout.
					onSend: [{ branch: [mockAssistantMessage("diagnosed; all green")], toolTimeout: undefined }],
				},
			],
		});
		const state = freshRunState();
		const onFailure = vi.fn();
		const onSuccess = vi.fn<(ctx: WorkflowHostContext, output: Output) => Promise<void>>(async () => {});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({ cwd: tmpDir, state, onSuccess, onFailure }),
		);

		// The steering message was sent into the SAME child (no second spawn) and carries the steering guidance.
		expect(chain.sentMessages.some((m) => m.includes("HUNG, not merely slow"))).toBe(true);
		// Recovery → completion: no failure row, no onFailure, onSuccess fired once.
		expect(onFailure).not.toHaveBeenCalled();
		expect(onSuccess).toHaveBeenCalledTimes(1);
		// The completed row carries the strike history (count + reasons).
		const rows = readStageRows(tmpDir);
		const completed = rows[rows.length - 1]!;
		expect(completed.status).toBe("completed");
		expect(completed.bashTimeoutStrikes).toEqual({ count: 1, reasons: [reason] });
	});

	it("bash strike recovery: two overruns in one session drive per-session accounting + carry the final-strike warning on #2", async () => {
		const reason = "bash command exceeded the 180s per-command timeout and was aborted: `find /`";
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{
					branch: [mockAssistantMessage("overrun 1", "aborted")],
					toolTimeout: { reason },
					onSend: [
						{ branch: [mockAssistantMessage("overrun 2", "aborted")], toolTimeout: { reason } }, // strike 2 (final)
						{ branch: [mockAssistantMessage("diagnosed; done")], toolTimeout: undefined }, // resumed turn completes
					],
				},
			],
		});
		const state = freshRunState();
		const onFailure = vi.fn();
		const onSuccess = vi.fn<(ctx: WorkflowHostContext, output: Output) => Promise<void>>(async () => {});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({ cwd: tmpDir, state, bashTimeoutStrikes: 2, onSuccess, onFailure }),
		);

		// The final-strike warning (#2) was sent on the second steering message.
		expect(chain.sentMessages.some((m) => m.includes("FINAL strike"))).toBe(true);
		expect(onFailure).not.toHaveBeenCalled();
		expect(onSuccess).toHaveBeenCalledTimes(1);
		// Both strikes consumed (per-session-activation scope, not per-command).
		const rows = readStageRows(tmpDir);
		expect(rows[rows.length - 1]!.bashTimeoutStrikes).toEqual({ count: 2, reasons: [reason, reason] });
	});

	it("bash strike exhaustion: with a default-2 ceiling, overrun #3 escalates to terminal fail byte-identical to today", async () => {
		const reason = "bash command exceeded the 180s per-command timeout and was aborted: `find /`";
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{
					branch: [mockAssistantMessage("overrun 1", "aborted")],
					toolTimeout: { reason },
					onSend: [
						{ branch: [mockAssistantMessage("overrun 2", "aborted")], toolTimeout: { reason } },
						{ branch: [mockAssistantMessage("overrun 3", "aborted")], toolTimeout: { reason } }, // exhausts
					],
				},
			],
		});
		const state = freshRunState();
		const onFailure = vi.fn();

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({ cwd: tmpDir, state, onFailure, bashTimeoutStrikes: 2 }),
		);

		// Escalation: terminal fail, the SAME {kind:"timeout"} errMsg as today.
		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(state.termination.error).toContain("per-command timeout");
		// No completed row ⇒ no strike-history field on any row (the timeout row is the unchanged seam).
		const rows = readStageRows(tmpDir);
		expect(rows.some((r) => r.bashTimeoutStrikes !== undefined)).toBe(false);
	});

	it("clean completion (zero timeouts) writes a row with NO bashTimeoutStrikes field — byte-identical to today", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({ cwd: tmpDir, state, onSuccess: async () => {} }),
		);

		const rows = readStageRows(tmpDir);
		const completed = rows[rows.length - 1]!;
		expect(completed.status).toBe("completed");
		expect("bashTimeoutStrikes" in completed).toBe(false); // field omitted ⇒ byte-identical row
	});

	it("a completed row carrying bashTimeoutStrikes replays through the resume fold byte-for-byte (additive — no re-dispatch)", async () => {
		// The additive strike-history field is resume-safe: the strict resume reader's deep
		// guard tolerates the unknown field (like errMsg) and the fold's `foldKnownStage` reads
		// only status/output/session/stage, so the row advances stagesCompleted once with no
		// re-dispatch and no STATE_SCHEMA_VERSION bump. Drives the real `reconstructState` fold
		// over a hand-written trail (header + one completed side-effect stage row carrying the field).
		const header: WorkflowHeader = {
			runId: "run-resume-strikes",
			workflow: "test-wf",
			input: "x",
			ts: "2026-01-01T00:00:00.000Z",
			v: STATE_SCHEMA_VERSION,
		};
		const workflow: Workflow = {
			name: "test-wf",
			start: "test",
			stages: { test: { kind: "side-effect", sessionPolicy: "fresh" } },
			edges: { test: "stop" },
		};
		appendHeader(tmpDir, header);
		appendStage(tmpDir, header.runId, {
			stageNumber: 1,
			stage: "test",
			skill: "test",
			status: "completed",
			ts: "2026-01-01T00:00:01.000Z",
			session: { id: "s1" },
			bashTimeoutStrikes: {
				count: 1,
				reasons: ["bash command exceeded the 180s per-command timeout and was aborted: `find /`"],
			},
		});

		const result = await reconstructState(tmpDir, workflow, header);

		expect(result.ok).toBe(true); // NOT refused as malformed-row / version-mismatch
		if (!result.ok) return; // type narrow
		expect(result.state.stagesCompleted).toBe(1); // advanced exactly once — the field did not block the fold
	});
});

// ---------------------------------------------------------------------------
// Output validation sourced from contract `produces.data` when the stage
// carries no `outputSchema` of its own.
// ---------------------------------------------------------------------------

describe("sessions — contract-sourced output validation", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-contract-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// produces.data raw JSON Schema mirroring FOO_EQ_2_SCHEMA, keyed to skill "test".
	const FOO_EQ_2_CONTRACTS = new Map([
		[
			"test",
			{
				source: "declared",
				produces: {
					kind: "produces",
					data: {
						type: "object",
						properties: { foo: { const: 2 } },
						required: ["foo"],
						additionalProperties: true,
					},
				},
			},
		],
	]) satisfies StageSessionContext["skillContracts"];

	it("validates output against produces.data when the stage has no outputSchema", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				skillContracts: FOO_EQ_2_CONTRACTS,
				// No outputSchema — must fall back to the contract's produces.data.
				stage: stage({ outcome: scriptedOutcome([okPayload({ foo: 2 })]) }),
				onSuccess,
			}),
		);

		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(state.stagesCompleted).toBe(1);
	});

	it("drives the retry loop off the contract schema — invalid output retries then succeeds", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				skillContracts: FOO_EQ_2_CONTRACTS,
				stage: stage({
					maxRetries: 2,
					// foo:1 violates the contract → one retry → foo:2 passes.
					outcome: scriptedOutcome([okPayload({ foo: 1 }), okPayload({ foo: 2 })]),
				}),
				onSuccess,
			}),
		);

		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(chain.sentMessages.filter((m) => m.includes("doesn't satisfy the expected output schema"))).toHaveLength(
			1,
		);
		expect(state.stagesCompleted).toBe(1);
	});

	it("the stage's own outputSchema wins over the contract (precedence)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onFailure = vi.fn();

		// Stage schema demands foo:2; contract would accept anything else. Output
		// foo:1 must FAIL — proving the stage schema, not the contract, is used.
		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				skillContracts: new Map([
					[
						"test",
						{
							source: "declared",
							produces: { kind: "produces", data: { type: "object", additionalProperties: true } },
						},
					],
				]) satisfies StageSessionContext["skillContracts"],
				stage: stage({
					outputSchema: FOO_EQ_2_SCHEMA,
					maxRetries: 1,
					outcome: scriptedOutcome([okPayload({ foo: 1 })]),
				}),
				onFailure,
			}),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(state.termination.error).toContain("foo:");
	});

	it("degrades to no validation when neither outputSchema nor contract supplies a schema", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onSuccess = vi.fn(async () => {});

		// No outputSchema, no contracts — output passes through unvalidated.
		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				stage: stage({ outcome: scriptedOutcome([okPayload({ anything: "goes" })]) }),
				onSuccess,
			}),
		);

		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(state.stagesCompleted).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Loop-unit session coverage (executeStageSession with `unit` set)
// ---------------------------------------------------------------------------

describe("sessions — loop unit session", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-unit-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("writes structured row fields, fires onUnitEnd (never onStageEnd), emits no completion toast", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onUnitEnd = vi.fn();
		const onStageEnd = vi.fn();
		const onSuccess = vi.fn<(ctx: WorkflowHostContext, output: Output) => Promise<void>>(async () => {});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				// Pre-decorated display name; machine identity rides `unit`.
				stageName: "implement (phase-2)",
				skill: "implement",
				lifecycle: new LifecycleDispatcher({ onUnitEnd, onStageEnd }),
				stage: stage({ outputSchema: FOO_EQ_2_SCHEMA, outcome: scriptedOutcome([okPayload({ foo: 2 })]) }),
				unit: { parent: "implement", role: "produce", index: 1, id: "phase-2", label: "phase 2/5" },
				onSuccess,
			}),
		);

		// onUnitEnd fires once with the PARENT-named ref; onStageEnd never fires for unit sessions.
		expect(onUnitEnd).toHaveBeenCalledTimes(1);
		expect(onStageEnd).not.toHaveBeenCalled();
		const [ref, unitEvent, output] = onUnitEnd.mock.calls[0]!;
		expect(ref.name).toBe("implement");
		expect(unitEvent).toMatchObject({
			role: "produce",
			index: 1,
			unitId: "phase-2",
			label: "phase 2/5",
			skill: "implement",
		});
		expect(output.artifacts).toBeDefined();

		// Completion is silent — neither a per-unit nor a stage banner is emitted.
		expect(chain.notifications.some((n) => n.msg.startsWith("✓"))).toBe(false);

		// The success row carries the decorated display `stage` + all four structured identity fields.
		const completed = readStageRows(tmpDir).find((r) => r.status === "completed")!;
		expect(completed.stage).toBe("implement (phase-2)");
		expect(completed.parent).toBe("implement");
		expect(completed.role).toBe("produce");
		expect(completed.unitId).toBe("phase-2");
		expect(completed.unitIndex).toBe(1);

		// onSuccess receives the full validated Output envelope, not just artifacts[0].
		expect(onSuccess).toHaveBeenCalledTimes(1);
		const successOutput = onSuccess.mock.calls[0]![1];
		expect(successOutput.artifacts).toEqual((output as Output).artifacts);
	});

	it("collect-all unit soft-halt fires onUnitHalt (not onUnitEnd/onStageError), survives the run, writes a collected:true row", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onUnitHalt = vi.fn();
		const onUnitEnd = vi.fn();
		const onStageError = vi.fn();
		const onSuccess = vi.fn<(ctx: WorkflowHostContext, output: Output) => Promise<void>>(async () => {});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				stageName: "design (slice-3)",
				skill: "design",
				// collect-all fanout unit: an extraction-fatal halt soft-halts THIS unit instead of
				// terminating the run (the fold places a failedOutput sentinel by index).
				collectAll: true,
				lifecycle: new LifecycleDispatcher({ onUnitHalt, onUnitEnd, onStageError }),
				stage: stage({ outputSchema: FOO_EQ_2_SCHEMA, outcome: scriptedOutcome([fatalPayload("slice blew up")]) }),
				unit: { parent: "design", role: "produce", index: 2, id: "slice-3", label: "slice 3/4" },
				onSuccess,
			}),
		);

		// onUnitHalt fires once with the PARENT-named ref + the halt reason; the success-only
		// onUnitEnd and the terminal onStageError never fire for a soft-halt.
		expect(onUnitHalt).toHaveBeenCalledTimes(1);
		expect(onUnitEnd).not.toHaveBeenCalled();
		expect(onStageError).not.toHaveBeenCalled();
		const [ref, unitEvent, reason] = onUnitHalt.mock.calls[0]!;
		expect(ref.name).toBe("design");
		expect(unitEvent).toMatchObject({
			role: "produce",
			index: 2,
			unitId: "slice-3",
			label: "slice 3/4",
			skill: "design",
		});
		expect(reason).toContain("slice blew up");

		// The run SURVIVES — onSuccess advances the fold with the failedOutput sentinel; no terminate.
		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(state.termination.status).toBe("running");

		// A NON-terminal collected:true failed row lands (resume reads errMsg to rebuild the sentinel).
		const failed = readStageRows(tmpDir).find((r) => r.status === "failed")!;
		expect(failed.collected).toBe(true);
		expect(failed.unitIndex).toBe(2);
	});

	it("single-stage session stays byte-identical: no structured fields, onStageEnd, no completion toast", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});
		const state = freshRunState();
		const onUnitEnd = vi.fn();
		const onStageEnd = vi.fn();

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state,
				lifecycle: new LifecycleDispatcher({ onUnitEnd, onStageEnd }),
				stage: stage({ outputSchema: FOO_EQ_2_SCHEMA, outcome: scriptedOutcome([okPayload({ foo: 2 })]) }),
			}),
		);

		expect(onStageEnd).toHaveBeenCalledTimes(1);
		expect(onUnitEnd).not.toHaveBeenCalled();
		// Completion is silent — no toast on the notify channel.
		expect(chain.notifications.some((n) => n.msg.startsWith("✓"))).toBe(false);

		const completed = readStageRows(tmpDir).find((r) => r.status === "completed")!;
		expect(completed).not.toHaveProperty("parent");
		expect(completed).not.toHaveProperty("role");
		expect(completed).not.toHaveProperty("unitId");
		expect(completed).not.toHaveProperty("unitIndex");
	});
});

// ---------------------------------------------------------------------------
// Session provenance capture (readSessionRef → WorkflowStage.session)
// ---------------------------------------------------------------------------

describe("sessions — session provenance capture", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-sessions-provenance-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// The chain fixture's sessionManager reports id "test-session" and file
	// "/tmp/test-session.jsonl" (createMockSessionManager defaults).
	const MOCK_REF = { id: "test-session", file: "/tmp/test-session.jsonl" };

	it("fresh success row carries the backing SessionRef (no branchOffset)", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }],
		});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({ cwd: tmpDir, state: freshRunState() }),
		);

		const completed = readStageRows(tmpDir).find((r) => r.status === "completed")!;
		expect(completed.session).toEqual(MOCK_REF);
	});

	it("continue success row carries the captured branchOffset on the SessionRef", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("prior"), mockAssistantMessage("done")] }],
		});

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({
				cwd: tmpDir,
				state: freshRunState(),
				stage: stage({ sessionPolicy: "continue" }),
				branchOffset: 1,
			}),
		);

		const completed = readStageRows(tmpDir).find((r) => r.status === "completed")!;
		expect(completed.session).toEqual({ ...MOCK_REF, branchOffset: 1 });
	});

	it("stop-failure row is session-backed too (failed stage stays resumable)", async () => {
		// A non-abort halting stop (`error`) still flows through postStage →
		// haltStage → recordStopFailure, so the terminal "failed" row records the
		// backing SessionRef. (Abort no longer writes a postStage row — it throws
		// WorkflowAbortError before any halt; the seam records that case.)
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("partial", "error")] }],
		});
		const onFailure = vi.fn();

		await executeStageSession(
			chain.ctx as WorkflowHostContext,
			stageSession({ cwd: tmpDir, state: freshRunState(), onFailure }),
		);

		expect(onFailure).toHaveBeenCalledTimes(1);
		const failed = readStageRows(tmpDir).find((r) => r.status === "failed")!;
		expect(failed.session).toEqual(MOCK_REF);
	});
});
