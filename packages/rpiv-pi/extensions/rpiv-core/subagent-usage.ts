/**
 * subagent-usage — the process-global accumulator of subagent token usage,
 * keyed `runId → stageName → LaneUsage`.
 *
 * Subagents (pi-subagents) each run under their own `SessionManager.inMemory(...)`
 * session, so their tokens NEVER reach the orchestrator child's
 * `AgentSession.getSessionStats()` (the lane tally's source). The only structured
 * source of subagent tokens is the terminal EventBus event pi-subagents emits —
 * `subagents:completed`, or `subagents:failed` for error/stopped/aborted agents,
 * both carrying the same `{ …, tokens: { input, output, total } }` payload shape.
 * The host subscribes to BOTH: a subagent that burns tokens and then dies still
 * spent them.
 *
 * `sdk-workflow-host.ts` wires a PER-CHILD eventBus into each child's
 * `DefaultResourceLoader({ eventBus })`, so the bus an extension sees as `pi.events`
 * is the one the host created for that child — every loaded extension factory is
 * handed that same bus (`createExtensionAPI(…, eventBus)` → `api.events = eventBus`).
 * Subscribing on the child's own bus attributes each completion to the host's
 * `runId` + the registry's current `progress.stageName` with zero cross-talk between
 * concurrent fan-out children (no "single active run" assumption).
 *
 * Token-source partitioning (cross-phase invariant): subagent tokens live HERE,
 * per-stage orchestrator tokens live on `LaneEntry.stageUsage`. They are
 * NEVER mixed in storage — unified only at render time (`laneUsageTotal` /
 * `renderStageBreakdown` / the lane roll-in). Folding orchestrator tokens in here
 * would double-count.
 *
 * `cacheRead` is forced to `0` (pi-subagents deliberately excludes it — each turn's
 * cacheRead is the cumulative cached prefix re-read, so summing counts the prefix N
 * times; pi-subagents issue #38). `cacheWrite` is recovered as `max(0, total − input
 * − output)` since the payload omits it. A missing/malformed `tokens` is a no-op.
 *
 * Mirrors `run-lane-registry.ts`'s process-global slot discipline: a
 * `globalThis[Symbol.for("@juicesharp/rpiv-pi:subagentUsage")]` slot (NOT a
 * module-level variable) so every re-loaded rpiv-pi instance shares ONE accumulator.
 * `__resetSubagentUsage` clears it in place (slot identity preserved) and is wired
 * into `test/setup.ts` beforeEach.
 */

import { addLaneUsage, type LaneUsage } from "./lane-usage.js";

/** A minimal structural view of a `subagents:completed` payload, used only for
 *  defensive narrowing. Typed loose so the module imports no pi-subagents type. */
interface SubagentCompletedPayload {
	tokens?: {
		input?: unknown;
		output?: unknown;
		total?: unknown;
	};
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

interface SubagentState {
	/** runId → (stageName → accumulated LaneUsage). The outer key is the host run;
	 *  the inner key is the registry's `progress.stageName` at completion time. */
	readonly runs: Map<string, Map<string, LaneUsage>>;
}

const SUBAGENT_SLOT = Symbol.for("@juicesharp/rpiv-pi:subagentUsage");

/** Read the single process-global subagent accumulator, lazily creating it. */
function state(): SubagentState {
	const g = globalThis as Record<symbol, unknown>;
	let s = g[SUBAGENT_SLOT] as SubagentState | undefined;
	if (s === undefined) {
		s = { runs: new Map<string, Map<string, LaneUsage>>() };
		g[SUBAGENT_SLOT] = s;
	}
	return s;
}

/**
 * Narrow a raw `subagents:completed` payload into a `LaneUsage` defensively:
 * `cacheRead = 0` (pi-subagents excludes it — issue #38), `cacheWrite = max(0,
 * total − input − output)` (the payload omits it), `total` taken from the source.
 * A missing/malformed `tokens` (or non-finite fields) returns `undefined` — the
 * caller treats that as a no-op (never throws, never records a NaN).
 */
function narrowSubagentTokens(payload: unknown): LaneUsage | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const t = (payload as SubagentCompletedPayload).tokens;
	if (typeof t !== "object" || t === null) return undefined;
	const input = t.input;
	const output = t.output;
	const total = t.total;
	if (!isFiniteNumber(input) || !isFiniteNumber(output) || !isFiniteNumber(total)) return undefined;
	const cacheWrite = Math.max(0, total - input - output);
	return { input, output, cacheRead: 0, cacheWrite, total };
}

/**
 * Record one subagent terminal event's tokens (`subagents:completed` OR
 * `subagents:failed` — same payload shape) against a run + stage. Synchronous RMW
 * is race-free under concurrent children (Node single-threaded `on` callbacks).
 * A `undefined` stageName records nothing (the host can't attribute a completion
 * before the first `onStageStart`); a missing/malformed `tokens` payload is a
 * no-op. Subsequent completions for the SAME run+stage are pairwise-accumulated
 * via `addLaneUsage` so a multi-subagent stage sums rather than overwrites.
 */
export function recordSubagentCompletion(runId: string, stageName: string | undefined, payload: unknown): void {
	if (stageName === undefined) return;
	const usage = narrowSubagentTokens(payload);
	if (!usage) return;
	const { runs } = state();
	let stages = runs.get(runId);
	if (!stages) {
		stages = new Map<string, LaneUsage>();
		runs.set(runId, stages);
	}
	const existing = stages.get(stageName);
	// Both `existing` and `usage` are defined here (usage guarded above; existing by
	// the truthy branch), so addLaneUsage's contract ("undefined only when BOTH absent")
	// guarantees a defined result — the assertion is contract-backed, not speculative.
	stages.set(stageName, existing ? addLaneUsage(existing, usage)! : usage);
}

/**
 * The summed subagent usage for an entire run, across every stage that recorded a
 * completion. Returns `undefined` when no completion was ever recorded for the run
 * (so a run with no subagents renders byte-identical to before this module existed).
 */
export function getSubagentUsageForRun(runId: string): LaneUsage | undefined {
	const stages = state().runs.get(runId);
	if (!stages || stages.size === 0) return undefined;
	let acc: LaneUsage | undefined;
	for (const usage of stages.values()) acc = acc ? addLaneUsage(acc, usage) : usage;
	return acc;
}

/**
 * The accumulated subagent usage for ONE stage of a run, or `undefined` when no
 * completion was ever recorded for that run+stage. Mirrors `getSubagentUsageForRun`
 * but scoped to a single stage — consumed by `renderStageBreakdown` so a
 * stage's subagent contribution folds into its per-stage tally alongside its
 * orchestrator tokens.
 */
export function getSubagentUsageForStage(runId: string, stageName: string): LaneUsage | undefined {
	return state().runs.get(runId)?.get(stageName);
}

/** Test reset — wired into `test/setup.ts` beforeEach. Clears every run/stage map
 *  IN PLACE so the process-global slot identity is preserved across resets. */
export function __resetSubagentUsage(): void {
	const s = state();
	s.runs.clear();
}
