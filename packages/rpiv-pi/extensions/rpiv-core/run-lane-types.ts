/**
 * run-lane-types — the stateless type companion of run-lane-registry.ts: the
 * lane data model (status taxonomy, live-session surface, deferred-input
 * requests, unit sub-lanes, stage progress, lane entries, dock display rows)
 * with zero runtime surface except the SINGLE_UNIT_KEY sentinel const. The
 * registry owns all state and behavior and re-exports everything declared
 * here — consumers keep importing from "./run-lane-registry.ts", never from
 * this module directly.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { RunRecap } from "@juicesharp/rpiv-workflow";

import type { LaneUsage } from "./lane-usage.ts";

/** Lane status taxonomy — mirrors rpiv-workflow's RunTermination.status (types.ts:145-149). */
export type LaneStatus = "running" | "completed" | "failed" | "aborted" | "cancelled";

/**
 * The minimal live-session surface a lane exposes — structural, so the registry
 * stays free of an AgentSession value import and is unit-testable with a stub.
 * A real Pi AgentSession satisfies it.
 */
export interface LaneSession {
	readonly sessionId: string;
	readonly isStreaming: boolean;
	/** In-memory branch (always current) + the cwd tool renderers resolve paths against.
	 *  `getBranch()` is typed `unknown` — the viewer narrows via rpiv-workflow's
	 *  BranchEntry shape; `getCwd()` is concrete (a plain string). */
	readonly sessionManager: { getBranch(): unknown; getCwd(): string };
	/** Per-tool renderer lookup for the viewer's ToolExecutionComponent pass. Typed
	 *  `unknown` — the viewer narrows to the SDK's ToolDefinition at the call site so
	 *  the registry stays free of an SDK value/type import. Returns undefined when the
	 *  tool isn't registered (the component falls back to a generic renderer). */
	getToolDefinition(name: string): unknown;
	/** The in-flight partial assistant message during streaming — the same value the
	 *  SDK's `message_update` event carries, narrowed to `ViewerMessage` at the call site.
	 *  Typed `unknown` so the registry stays free of an SDK message-type import, exactly
	 *  like `getBranch`/`getToolDefinition`. Returns `undefined` when no turn is streaming
	 *  OR the instant the turn commits into `getBranch()` (the per-turn dedup signal) — so a
	 *  surface reading it after each tick shows live thinking without double-rendering the
	 *  committed turn. Backed by the host's `createLaneSessionView` (lane-streaming.ts). */
	getStreamingMessage(): unknown;
	/** Aggregate token usage off the live child — the host's `createLaneSessionView`
	 *  delegates this to `AgentSession.getSessionStats()`. Typed `unknown` — narrowed
	 *  to `LaneUsage` at the storage site via `toLaneUsage` — so the registry stays
	 *  free of an `AgentSession` import, exactly like `getStreamingMessage`/`getBranch`.
	 *  Captured at teardown WHILE the child is still alive (the usage is permanently
	 *  lost after `dispose()`), mirroring `getBranch` for `finalBranch`. */
	getUsage(): unknown;
	/** Fires on every streaming tick; the viewer re-renders on it. Returns unsub. */
	subscribe(listener: () => void): () => void;
}

/** The two args of ctx.ui.custom — captured verbatim so a deferred questionnaire
 *  replays on the launcher UI byte-identically (drift-proof via Parameters<>). */
type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
type CustomOptions = Parameters<ExtensionUIContext["custom"]>[1];

/**
 * A foreground-contract stage's deferred UI request. The relay captures the
 * factory + options the child passed to ctx.ui.custom and an unresolved-promise
 * resolver; the manager replays the factory on the launcher's real ctx.ui.custom
 * when the user switches in, then calls resolve with the result — settling the
 * child's stalled tool turn.
 */
export interface PendingInput {
	readonly factory: CustomFactory;
	readonly options: CustomOptions;
	readonly resolve: (result: unknown) => void;
}

/** Reserved unit key for the non-fanout single-stage child (it carries no fanout
 *  index). Real fanout unit indices are 0..N-1, so the sentinel never collides:
 *  the lane (parent) row resolves `units.get(SINGLE_UNIT_KEY)`, and ONLY keys ≥ 0
 *  flatten into selectable unit sub-rows — a single-stage run shows just its lane
 *  row, byte-identical to the pre-change scalar path. Nested fan-out (depth>0) also
 *  collapses onto this key (the host's depth-gate), so grandchildren never collide
 *  with their top-level cousins' indices. */
export const SINGLE_UNIT_KEY = -1;

/**
 * One fan-out unit's switchable sub-lane. Bundles the live child session, the terminal
 * snapshot (branch/cwd/tool-defs), the durable disk-fallback pointer, and the
 * deferred-input queue — so each concurrent unit owns its own slot keyed by its
 * declared fan-out `index`. Under fan-out a sibling's teardown can never clobber
 * another's entry (each owns its key), which retires the slot-owner identity guard.
 */
export interface UnitLane {
	/** The fan-out unit index this sub-lane addresses (== the map key);
	 *  `SINGLE_UNIT_KEY` for the non-fan-out single-stage child. */
	readonly index: number;
	/** Display label from the bridge's `onUnitStart` (e.g. "phase 2/5"). Undefined
	 *  until `setUnitStarted` fires — the host may publish a live session first. */
	label?: string;
	/** Per-unit lifecycle status — drives the sub-row glyph and the orphan sweep.
	 *  "pending" is seeded by `seedUnits` (a fanout `onLoopStart`) and flipped to
	 *  "running" by `setUnitStarted` (`onUnitStart`); "running" until `markUnitDone`/
	 *  `sweepRunningUnits`/`retireRun` flips it terminal. A resumed generation's replayed
	 *  units are seeded terminal directly — they fire no unit events. */
	status: "running" | "pending" | "done" | "failed";
	/** This unit's currently-live child session (the viewer/preview source);
	 *  undefined before the child spawns, between stages, or after teardown. */
	currentSession: LaneSession | undefined;
	/** Transcript snapshot captured at teardown WHILE the child is still alive
	 *  (per unit) — rendered for a finished-but-retained unit. */
	finalBranch?: unknown;
	/** cwd captured alongside `finalBranch` so the snapshot's tool-result renderers
	 *  resolve relative paths after the live session's `getCwd` is gone. */
	finalCwd?: string;
	/** Tool defs for the tool names present in `finalBranch`, snapshotted at teardown
	 *  so per-tool rendering survives the dropped live `getToolDefinition`. */
	finalToolDefs?: Map<string, unknown>;
	/** Token usage captured at teardown WHILE the child is still alive — the
	 *  structural twin of `finalBranch`: fail-soft (a throwing/malformed `getUsage`
	 *  leaves ONLY this undefined, never the transcript), preserved by `retireRun`
	 *  (KEEP), and readable post-retirement via `getUnit`. */
	finalUsage?: LaneUsage;
	/** This unit's most-recent persisted child session file — seeds the per-unit
	 *  disk-jsonl fallback (`runId::index::lastSessionFile`). */
	lastSessionFile?: string;
	/** FIFO of THIS unit's deferred foreground-stage UI requests. The relay
	 *  enqueues onto the unit it was bound to; the switcher drains only this queue. */
	readonly pendingInput: PendingInput[];
}

/**
 * Live stage progress for a lane — sourced from the workflow lifecycle
 * bus (lane-progress.ts) and rendered by the overlay in place of the blind
 * `streaming…` label. Absent (undefined) before the first stage starts.
 */
export interface LaneProgress {
	stageName: string;
	/** Glyph selector: running spinner · ⟲ retry · ✗ error. */
	phase: "running" | "retry" | "error";
	/**
	 * Stage failure cause — set on the `"error"` phase from
	 * `onStageError`'s `error` param so a failed row can show WHY before the run
	 * retires. The dock chip trims it via `shortFailureReason`; absent otherwise.
	 */
	reason?: string;
	/** onStageRetry — "retry 2/3". */
	attempt?: number;
	/**
	 * FANOUT-ONLY sub-progress. `onLoopStart` seeds `total` from the fanout's
	 * precomputed unit list (and `done: 0`); `onUnitEnd` advances `done` by a TRUE
	 * completion count (not the declared unit index, which regresses under out-of-order
	 * parallel completion). Pull loops (iterate/assess/verify) carry NO precomputed
	 * total, so `onLoopStart` leaves this `undefined` and `onUnitEnd` keeps it
	 * `undefined` (the `units` advance is gated behind the `fanoutRuns` set) — the dock
	 * omits the `· units x/y` segment for them. No `onUnitStart` handler touches this
	 * field — the bridge only advances `done` on unit completion.
	 */
	units?: { done: number; total: number };
}

/** One switchable run lane. */
export interface LaneEntry {
	readonly runId: string;
	/** Display name — the run's --name, else the workflow name. */
	name: string;
	/** The run's workflow name — the dock renders it as a dim `workflow:` tag. Set at
	 *  recordRun; undefined only for lanes recorded before this field existed (impossible
	 *  in a session — the launcher restart clears the registry). */
	workflow?: string;
	/** The run's original `/wf` input (the user prompt) — the dock renders it as the
	 *  descriptor label when no `--name` alias is set. Undefined for a prompt-less run. */
	input?: string;
	status: LaneStatus;
	/**
	 * Per-unit sub-lanes keyed by fan-out index — the replacement for the
	 * collapsing single-slot session/snapshot scalars. A non-fan-out stage writes the
	 * `SINGLE_UNIT_KEY` slot; a fan-out generation writes 0..N-1. Cleared at each new
	 * fan-out generation (`clearUnitLanes`) so the dock shows the CURRENT
	 * generation only; the final generation's snapshots survive retirement.
	 */
	readonly units: Map<number, UnitLane>;
	/** Per-stage orchestrator token usage, keyed by stage name in execution (insertion)
	 *  order. Folded by `foldStageUsage` at each stage transition (BEFORE `clearUnitLanes`
	 *  empties `units`), so a completed stage's tokens survive even though its units are
	 *  gone. The CURRENT running stage's tokens are NOT yet folded — they read live off
	 *  `units` at render time (`renderStageBreakdown`). Survives resume reactivation
	 *  (`recordRun` clears `units`, not this). Never mixed with subagent tokens
	 *  (`subagent-usage.ts`) — unified only at render time. */
	readonly stageUsage: Map<string, LaneUsage>;
	/** Live stage progress; undefined until the first onStageStart. */
	progress: LaneProgress | undefined;
	/**
	 * Terminal failure cause — `result.termination.error` captured at
	 * `retireRun`, the readable reason a `failed`/`aborted`/`cancelled` run ended.
	 * The dock chip trims it (`shortFailureReason`); the viewer header shows it in
	 * full. Absent for a `completed` run (no error) and while still running.
	 */
	error?: string;
	/**
	 * Primary artifact path at run termination — `RunWorkflowResult.lastArtifact`
	 * captured at `retireRun` (the runner's terminal `onWorkflowEnd`), so a completed
	 * lane row can surface `→ <bucket>/<file>.md` as a trailing
	 * segment. Undefined for a side-effect-only run (no `produces` stage emitted a
	 * primary artifact) and for aborted/failed runs (the terminal writers pass ≤3
	 * args). Cleared on resume (`recordRun` reactivation) so a resumed run never
	 * leaks the prior run's path — mirroring the `error`/`progress`/`needsInputSince`
	 * clears.
	 */
	lastArtifact?: string;
	/**
	 * End-of-run summary projected from the on-disk JSONL trail by `summarizeRun`
	 * (rpiv-workflow) — the lane-console renders it via `renderRecap` for a terminal
	 * lane that carries one. Written by `setRecap` at `onWorkflowEnd` — see it for
	 * the single-writer invariant. Undefined for a run that never reached
	 * `onWorkflowEnd` (in-progress / hard-teardown) and cleared on resume
	 * (`recordRun` reactivation) so a resumed run never leaks the prior recap —
	 * mirroring `lastArtifact`.
	 */
	recap?: RunRecap;
	/**
	 * When this lane first started waiting on a deferred foreground question
	 * — `Date.now()` stamped on the FIRST enqueue that finds the clock
	 * unset, and HELD across transient drains so a switch-in drain racing a
	 * background sibling enqueue never resets the displayed age. Cleared only when
	 * the lane stops needing input for real: retire/evict/reactivate (`recordRun`).
	 * Drives the overlay's aging "needs input · 4m" heading. `Date.now()` is fine
	 * here (extension code; the no-`Date.now` rule applies to workflow *scripts*).
	 */
	needsInputSince?: number;
	/**
	 * Abort handle for this run — the per-run `AbortController.abort`
	 * wired by the execution host. Lets the manager cancel a running lane without
	 * the user switching in (which the focus-gated Ctrl-C tap would otherwise
	 * require). Undefined for headless runs (no abort tap).
	 */
	abort?: () => void;
}

/** One row in the dock's flattened display/selection list: a lane (parent) row
 *  or a unit sub-row. Selection indexes this list; the four lane-resolving dock
 *  actions dereference a row to `(runId, unitIndex)`. */
export type DisplayRow =
	| { readonly kind: "lane"; readonly lane: LaneEntry }
	| { readonly kind: "unit"; readonly lane: LaneEntry; readonly unit: UnitLane };
