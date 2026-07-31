/**
 * Focused unit tests for the two Phase-12 extractions:
 *   - `effectiveOutputSchemaOf` (`stage-identity.ts`) — the shared RUNTIME
 *     output-schema predicate (precedence + contract fallback + fail-soft).
 *   - `gateValidationRedispatch` (`run-stage.ts`) — the validation-redispatch
 *     gate lifted out of `runSingleStage`.
 *
 * The gate's positive-halt case runs `recordTerminalFailure` for real over a
 * tmpDir trail, so the assertions pin the persisted failure row + the
 * termination state — not just the boolean return.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StageDef, Workflow } from "../api.js";
import { LifecycleDispatcher } from "../events.js";
import { effectiveOutputSchemaOf } from "../stage-identity.js";
import { appendHeader, readAllStages, STATE_SCHEMA_VERSION } from "../state/index.js";
import type { RunContext, RunState, WorkflowHostContext } from "../types.js";
import type { ResolvedStage } from "./resolve-stage.js";
import { gateValidationRedispatch } from "./run-stage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Bare RunState — matches `freshRunState` (run-context.ts) so deltas are visible. */
const freshRunState = (overrides: Partial<RunState> = {}): RunState => ({
	originalInput: "x",
	primaryArtifact: undefined,
	output: undefined,
	named: {},
	stagesCompleted: 0,
	lastAllocatedStageNumber: 0,
	telemetry: { backwardJumps: 0, droppedRoutingRows: [], droppedFailureRows: [] },
	failureMemos: [],
	lastGatedDispatch: undefined,
	termination: { status: "running" },
	...overrides,
});

const workflow: Workflow = {
	name: "gate-wf",
	start: "plan",
	stages: { plan: { kind: "produces", sessionPolicy: "fresh", skill: "plan" } },
	edges: { plan: "stop" },
};

/** Minimal launcher ctx — only `ui.notify` is touched by the failure writers. */
const mockCtx = (notify: ReturnType<typeof vi.fn> = vi.fn()): WorkflowHostContext =>
	({ ui: { notify } }) as unknown as WorkflowHostContext;

/** A produces `ResolvedStage` carrying its own `outputSchema` (qualifies on its own). */
const stageWithOwnSchema = (schema: object): ResolvedStage => ({
	def: {
		kind: "produces",
		sessionPolicy: "fresh",
		skill: "plan",
		outputSchema: schema as unknown as StageDef["outputSchema"],
	},
	name: "plan",
	stageNumber: 1,
	skill: "plan",
	mode: "skill",
	dispatch: "skill",
});

/** A side-effect `ResolvedStage` (never qualifies — no output schema). */
const sideEffectStage = (): ResolvedStage => ({
	def: { kind: "side-effect", sessionPolicy: "fresh", skill: "plan" },
	name: "plan",
	stageNumber: 1,
	skill: "plan",
	mode: "skill",
	dispatch: "skill",
});

/** A produces `ResolvedStage` with NO own schema (qualifies only via contract). */
const producesStageNoSchema = (): ResolvedStage => ({
	def: { kind: "produces", sessionPolicy: "fresh", skill: "plan" },
	name: "plan",
	stageNumber: 1,
	skill: "plan",
	mode: "skill",
	dispatch: "skill",
});

/** A run over a tmpDir with a written header, a spy notify, and stub contracts/digest. */
function buildRun(opts: {
	cwd: string;
	runId: string;
	skillContracts?: Map<string, unknown>;
	worktreeDigest?: () => string | undefined;
	resumedFrom?: unknown;
	stagesCompleted?: number;
	lastGatedDispatch?: RunState["lastGatedDispatch"];
}): { run: RunContext; notify: ReturnType<typeof vi.fn> } {
	const notify = vi.fn();
	const state = freshRunState({
		stagesCompleted: opts.stagesCompleted ?? 0,
		lastGatedDispatch: opts.lastGatedDispatch,
	});
	const run: RunContext = {
		cwd: opts.cwd,
		runId: opts.runId,
		workflow,
		totalStages: 1,
		state,
		visited: new Set<string>(),
		revisits: new Map<string, number>(),
		skillContracts: opts.skillContracts as RunContext["skillContracts"],
		worktreeDigest: opts.worktreeDigest,
		maxBackwardJumps: 1,
		maxIterations: 1,
		trigger: {
			kind: "command",
			name: "/wf",
			...(opts.resumedFrom !== undefined ? { meta: { resumedFrom: opts.resumedFrom } } : {}),
		},
		lifecycle: new LifecycleDispatcher(undefined),
	};
	return { run, notify };
}

// ---------------------------------------------------------------------------
// effectiveOutputSchemaOf
// ---------------------------------------------------------------------------

describe("effectiveOutputSchemaOf", () => {
	const ownSchema = { "~standard": { version: 1, validate: () => ({ value: undefined }) } };

	it("returns the stage's own outputSchema when present (precedence over contract)", () => {
		const contracts = new Map([
			["plan", { produces: { kind: "produces", data: { type: "object" } }, source: "declared" }],
		]);
		const def = {
			kind: "produces",
			sessionPolicy: "fresh",
			skill: "plan",
			outputSchema: ownSchema as unknown as StageDef["outputSchema"],
		} as StageDef;
		expect(effectiveOutputSchemaOf(def, "plan", contracts as never)).toBe(ownSchema);
	});

	it("returns the contract produces.data (standardized) when the stage has no outputSchema", () => {
		const contracts = new Map([
			["plan", { produces: { kind: "produces", data: { type: "object" } }, source: "declared" }],
		]);
		const def = { kind: "produces", sessionPolicy: "fresh", skill: "plan" } as StageDef;
		const schema = effectiveOutputSchemaOf(def, "plan", contracts as never);
		expect(schema).toBeDefined();
		expect((schema as { "~standard": { vendor: string } })["~standard"].vendor).toBe("rpiv-json-schema");
	});

	it("returns undefined when neither outputSchema nor a contract is present", () => {
		const def = { kind: "produces", sessionPolicy: "fresh", skill: "plan" } as StageDef;
		expect(effectiveOutputSchemaOf(def, "plan", undefined)).toBeUndefined();
		expect(effectiveOutputSchemaOf(def, "plan", new Map())).toBeUndefined();
	});

	it("returns undefined when produces.data is present but not a JSON-Schema object (fail-soft)", () => {
		const contracts = new Map([
			["plan", { produces: { kind: "produces", data: "not-an-object" }, source: "declared" }],
		]);
		const def = { kind: "produces", sessionPolicy: "fresh", skill: "plan" } as StageDef;
		expect(effectiveOutputSchemaOf(def, "plan", contracts as never)).toBeUndefined();
	});

	it("keys the contract by def.skill ?? stageName", () => {
		// def.skill aliases the stage away from its record key — the lookup MUST
		// use the alias (resolveSkill), not the record key.
		const contracts = new Map([
			["aliased", { produces: { kind: "produces", data: { type: "object" } }, source: "declared" }],
		]);
		const def = { kind: "produces", sessionPolicy: "fresh", skill: "aliased" } as StageDef;
		expect(effectiveOutputSchemaOf(def, "plan", contracts as never)).toBeDefined();
		// record key has no contract ⇒ resolves via alias
		const noAlias = new Map([
			["plan", { produces: { kind: "produces", data: { type: "object" } }, source: "declared" }],
		]);
		expect(effectiveOutputSchemaOf(def, "plan", noAlias as never)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// gateValidationRedispatch
// ---------------------------------------------------------------------------

describe("gateValidationRedispatch", () => {
	let cwd: string;
	const runId = "2026-07-26_00-35-22-ab";

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "rpiv-gate-"));
		appendHeader(cwd, { runId, workflow: "gate-wf", input: "x", ts: "t0", v: STATE_SCHEMA_VERSION });
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	const ownSchema = { "~standard": { version: 1, validate: () => ({ value: undefined }) } };

	it("positive halt: qualifying produces stage + matching digest ⇒ true, terminal failure row, prepareSingleStage never runs", async () => {
		const { run, notify } = buildRun({
			cwd,
			runId,
			worktreeDigest: () => "digest-1",
			stagesCompleted: 3,
			lastGatedDispatch: { stage: "plan", digest: "digest-1", stagesCompleted: 3 },
		});
		const hostCtx = mockCtx(notify);
		const stage = stageWithOwnSchema(ownSchema);

		const halted = await gateValidationRedispatch(hostCtx, stage, run);

		expect(halted).toBe(true);
		expect(run.state.termination.status).toBe("failed");
		expect(notify).toHaveBeenCalledTimes(1);
		const rows = readAllStages(cwd, runId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("failed");
		expect(rows[0]?.errMsg).toMatch(/plan/);
	});

	it("undefined-digest-never-gates: worktreeDigest ⇒ undefined ⇒ false, NO failure row, baseline NOT written", async () => {
		const { run, notify } = buildRun({
			cwd,
			runId,
			worktreeDigest: () => undefined,
			stagesCompleted: 3,
			lastGatedDispatch: { stage: "plan", digest: "digest-1", stagesCompleted: 3 },
		});
		const halted = await gateValidationRedispatch(mockCtx(notify), stageWithOwnSchema(ownSchema), run);

		expect(halted).toBe(false);
		expect(run.state.termination.status).toBe("running");
		expect(notify).not.toHaveBeenCalled();
		expect(readAllStages(cwd, runId)).toHaveLength(0);
		expect(run.state.lastGatedDispatch).toEqual({ stage: "plan", digest: "digest-1", stagesCompleted: 3 });
	});

	it("operator-resume exclusion: trigger.meta.resumedFrom set ⇒ false (early bypass), NO failure, baseline untouched", async () => {
		const { run, notify } = buildRun({
			cwd,
			runId,
			resumedFrom: "2026-07-25_22-33-52-cd34",
			worktreeDigest: () => "digest-1",
			stagesCompleted: 3,
			lastGatedDispatch: { stage: "plan", digest: "digest-1", stagesCompleted: 3 },
		});
		const halted = await gateValidationRedispatch(mockCtx(notify), stageWithOwnSchema(ownSchema), run);

		expect(halted).toBe(false);
		expect(run.state.termination.status).toBe("running");
		expect(notify).not.toHaveBeenCalled();
		// baseline untouched even though stage + digest + stagesCompleted all match
		expect(run.state.lastGatedDispatch).toEqual({ stage: "plan", digest: "digest-1", stagesCompleted: 3 });
	});

	it("baseline-writes-on-every-qualifying-dispatch: old baseline, new digest ⇒ false AND baseline OVERWRITTEN", async () => {
		const { run, notify } = buildRun({
			cwd,
			runId,
			worktreeDigest: () => "digest-new",
			stagesCompleted: 3,
			lastGatedDispatch: { stage: "plan", digest: "digest-old", stagesCompleted: 3 },
		});
		const halted = await gateValidationRedispatch(mockCtx(notify), stageWithOwnSchema(ownSchema), run);

		expect(halted).toBe(false);
		expect(run.state.termination.status).toBe("running");
		expect(notify).not.toHaveBeenCalled();
		expect(run.state.lastGatedDispatch).toEqual({ stage: "plan", digest: "digest-new", stagesCompleted: 3 });
	});

	it("non-qualifying: a side-effect stage ⇒ false, baseline untouched", async () => {
		const { run, notify } = buildRun({
			cwd,
			runId,
			worktreeDigest: () => "digest-1",
			stagesCompleted: 3,
			lastGatedDispatch: { stage: "plan", digest: "digest-1", stagesCompleted: 3 },
		});
		const halted = await gateValidationRedispatch(mockCtx(notify), sideEffectStage(), run);

		expect(halted).toBe(false);
		expect(run.state.termination.status).toBe("running");
		expect(run.state.lastGatedDispatch).toEqual({ stage: "plan", digest: "digest-1", stagesCompleted: 3 });
	});

	it("produces stage qualifies via contract produces.data when it has no own outputSchema", async () => {
		// Confirms part (b) consumes part (a): qualifies=true via the contract path.
		const contracts = new Map([
			["plan", { produces: { kind: "produces", data: { type: "object" } }, source: "declared" }],
		]);
		const { run, notify } = buildRun({
			cwd,
			runId,
			skillContracts: contracts,
			worktreeDigest: () => "digest-1",
			stagesCompleted: 3,
			lastGatedDispatch: { stage: "plan", digest: "digest-1", stagesCompleted: 3 },
		});
		const halted = await gateValidationRedispatch(mockCtx(notify), producesStageNoSchema(), run);

		expect(halted).toBe(true);
		expect(run.state.termination.status).toBe("failed");
	});
});
