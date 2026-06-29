/**
 * run-lane-registry — session-scoped singleton tracking each in-flight detached
 * /wf run as a switchable "lane".
 *
 * The launcher (root) owns this registry; detached runs are attached views under
 * it. A lane carries the run identity, a live status, the run's CURRENTLY-LIVE
 * child AgentSession (the viewer's transcript source), and a FIFO queue of
 * deferred UI requests from foreground-contract stages.
 *
 * Lives in rpiv-pi (NOT rpiv-workflow): rpiv-workflow must not import rpiv-pi
 * (clean-install contract), so retained sessions + the registry + the deferred-UI relay
 * are all rpiv-side, and the "needs input" signal is a direct in-process call —
 * no new cross-package relay channel. Module-level state mirrors session-capture;
 * __resetRunLaneRegistry is wired into test/setup.ts beforeEach.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { LaneUsage } from "./lane-usage.js";
import { toLaneUsage } from "./lane-usage.js";

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
 * One fan-out unit's switchable sub-lane. Bundles everything that used to
 * live as a single scalar on `LaneEntry` — the live child session, the terminal
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
	 *  "running" until `markUnitDone`/`sweepRunningUnits` flips it terminal. */
	status: "running" | "done" | "failed";
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
	/**
	 * Path ordinal — the count of stage ACTIVATIONS along the executed walk
	 * (`idx + 1`), so it climbs on every loop-back / re-entry and is unbounded by
	 * graph size. This is the "lap" number (`↻7`), NOT a fraction numerator: it is
	 * incommensurable with `totalStages` (distance travelled vs. map size).
	 */
	stageNumber: number;
	/** Distinct reachable stage NODES in the workflow graph (static, BFS at launch). */
	totalStages: number;
	/**
	 * Distinct stage nodes VISITED so far (≤ totalStages) — the one quantity for
	 * which `visited/totalStages ≤ 1` holds, so it (not `stageNumber`) is the
	 * progress-fraction numerator. Counts nodes actually entered PLUS the recovery
	 * arms a gate bypassed for good (carve's reslice/refine, credited via onRoute's
	 * `bypassed`), so a clean run reaches `totalStages` while its terminal stage
	 * runs instead of capping below until the onWorkflowEnd snap. Undefined for
	 * snapshots built outside the lifecycle bridge; the renderer falls back to
	 * `min(stageNumber, totalStages)`.
	 */
	visited?: number;
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
	/** Live stage progress; undefined until the first onStageStart. */
	progress: LaneProgress | undefined;
	/**
	 * Distinct stage names entered over this run's life — the accumulator behind
	 * `LaneProgress.visited`. Lives on the entry (not the per-event progress
	 * snapshot, which the bridge rebuilds wholesale) so a cyclic walk that revisits
	 * a stage never inflates the count. Retained across a same-session resume
	 * (those stages WERE visited); only a launcher restart resets it, which resets
	 * the whole lane anyway. Lazily created by `noteVisitedStage`.
	 */
	visitedStages?: Set<string>;
	/**
	 * Terminal failure cause — `result.termination.error` captured at
	 * `retireRun`, the readable reason a `failed`/`aborted`/`cancelled` run ended.
	 * The dock chip trims it (`shortFailureReason`); the viewer header shows it in
	 * full. Absent for a `completed` run (no error) and while still running.
	 */
	error?: string;
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

type Listener = () => void;

// ---------------------------------------------------------------------------
// Process-global state — anchored on a `globalThis[Symbol.for(...)]`
// slot, NOT plain module-level `let`/`const`. Detached child sessions re-load
// the rpiv-pi extension (Pi's jiti loader may hand each child a SEPARATE module
// instance); a module-local Map would give the launcher and a child DIFFERENT
// registries, so the second /wf's `recordRun` could land in a duplicate Map and
// the first run's lane would vanish from the overlay. A process-global slot is
// instance-independent — every instance shares ONE registry. Mirrors the proven
// execution-host provider box (rpiv-workflow/execution-host.ts). Reset in place
// by __resetRunLaneRegistry() in test/setup.ts beforeEach.
// ---------------------------------------------------------------------------

interface RegistryState {
	readonly lanes: Map<string, LaneEntry>;
	readonly listeners: Set<Listener>;
	/**
	 * The single lane the user is CURRENTLY switched into (viewer open), or
	 * undefined at root. Read on every keystroke by each run's abort tap so that
	 * ONLY the focused run interprets Ctrl-C — a floated background run must never
	 * steal the editor's ESC/Ctrl-C, nor abort an arbitrary sibling. Plain
	 * read-on-demand state: no notify (no renderer derives from focus).
	 */
	focusedRunId: string | undefined;
	/**
	 * Whether the always-mounted lane dock currently holds navigation focus (the
	 * user has "stepped into" the belowEditor dock). Unlike focusedRunId, the dock
	 * IS rendered from this state — the dock widget paints a selection cursor and an
	 * active footer when true — so its setters notify(). The editor (LaneDockEditor)
	 * is the sole writer at the idle prompt; the widget is the sole reader.
	 */
	dockActive: boolean;
	/** Selected row in the dock, an index into listLanesForDisplay() (the order the
	 *  dock renders). Clamped on every write and on read so a shrinking lane list
	 *  can never leave it dangling past the last row. */
	dockSelection: number;
}

const REGISTRY_SLOT = Symbol.for("@juicesharp/rpiv-pi:runLaneRegistry");

/** Read the single process-global registry state, lazily creating it on first access. */
function state(): RegistryState {
	const g = globalThis as Record<symbol, unknown>;
	let s = g[REGISTRY_SLOT] as RegistryState | undefined;
	if (s === undefined) {
		s = {
			lanes: new Map<string, LaneEntry>(),
			listeners: new Set<Listener>(),
			focusedRunId: undefined,
			dockActive: false,
			dockSelection: 0,
		};
		g[REGISTRY_SLOT] = s;
	}
	return s;
}

/** Fire every subscriber; fail-soft so one throwing listener never blocks the rest. */
function notify(): void {
	for (const l of state().listeners) {
		try {
			l();
		} catch {
			// a render listener must never break a registry mutation
		}
	}
}

// ---------------------------------------------------------------------------
// Mutations — every one notifies.
// ---------------------------------------------------------------------------

/**
 * Record a run at launch. recordRun is the launch signal for BOTH a fresh run
 * and a RESUME — and a resume reuses the original run id. A failed/finished run's
 * lane is RETAINED, so on resume that id already exists in a TERMINAL state.
 * Re-recording must therefore REACTIVATE it (back to live "running", terminal snapshot
 * + stale progress/needs-input cleared), not merely refresh the name — otherwise the
 * resumed run keeps rendering as the old failed/finished lane and never re-appears as
 * an in-flight one. `currentSession` is repointed by setCurrentSession when the resumed
 * stage spawns its child; the abort handle is re-wired by setLaneAbort.
 */
export function recordRun(runId: string, name: string, meta?: { workflow?: string; input?: string }): void {
	const { lanes } = state();
	const existing = lanes.get(runId);
	if (existing) {
		existing.name = name;
		existing.workflow = meta?.workflow ?? existing.workflow;
		existing.input = meta?.input ?? existing.input;
		existing.status = "running"; // reactivate a retained terminal lane (resume)
		existing.units.clear(); // drop the prior run's per-unit sessions + terminal snapshots
		existing.error = undefined; // clear the prior run's terminal failure reason
		existing.progress = undefined; // clear stale stage progress
		existing.needsInputSince = undefined; // clear any stale needs-input clock
	} else {
		lanes.set(runId, {
			runId,
			name,
			workflow: meta?.workflow,
			input: meta?.input,
			status: "running",
			units: new Map<number, UnitLane>(),
			progress: undefined,
		});
	}
	notify();
}

/**
 * RETIRE a run when it terminates — the run leaves the active set but
 * the lane is RETAINED (not deleted) so the user can come back to a finished run,
 * see its terminal status in the overlay, and open its transcript. Captures a
 * final transcript snapshot before the live session is dropped, settles any
 * queued input (a stalled child must never hang on a dangling resolver), and
 * clears the needs-input clock. The lane lives until the user dismisses it
 * (`evictRun`, via the manager's `x`) or a session reset.
 */
/**
 * Snapshot the tool definition of every assistant `toolCall` name in a captured branch
 * while the session is still alive, so the retired-lane viewer keeps per-tool rendering
 * after getToolDefinition (a live-session-only API) is gone. This is the one spot the
 * registry peeks at branch shape — a deliberate, contained narrowing that mirrors the
 * viewer's ViewerEntry; fail-soft per tool (a missing def degrades to the fallback).
 */
function snapshotToolDefs(branch: unknown, session: LaneSession): Map<string, unknown> {
	const defs = new Map<string, unknown>();
	if (!Array.isArray(branch)) return defs;
	for (const e of branch as Array<{ message?: { content?: Array<{ type?: string; name?: string }> } }>) {
		const content = e?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const c of content) {
			if (c?.type === "toolCall" && typeof c.name === "string" && !defs.has(c.name)) {
				try {
					defs.set(c.name, session.getToolDefinition(c.name));
				} catch {
					// tool unregistered / session disposed — skip; viewer falls back
				}
			}
		}
	}
	return defs;
}

/** Get or lazily create the `UnitLane` for `index` on an entry. The host (live
 *  session) and the bridge (label/status) both upsert the same key, in either order. */
function upsertUnit(entry: LaneEntry, index: number): UnitLane {
	let unit = entry.units.get(index);
	if (!unit) {
		unit = { index, status: "running", currentSession: undefined, pendingInput: [] };
		entry.units.set(index, unit);
	}
	return unit;
}

/**
 * Snapshot a live session's transcript + render inputs onto ONE unit sub-lane.
 * Fail-soft: a disposed/odd session yields an empty snapshot (the viewer shows
 * "unavailable") rather than throwing. Shared by `retireRun` (still-attached
 * session) and `captureFinalSnapshot` (the host's per-unit teardown, BEFORE the
 * session is dropped — now per unit). `snapshotToolDefs`
 * is unchanged (it takes the branch + session).
 */
function captureSnapshotInto(unit: UnitLane, session: LaneSession): void {
	try {
		const branch = session.sessionManager.getBranch();
		unit.finalBranch = branch;
		unit.finalCwd = session.sessionManager.getCwd();
		unit.finalToolDefs = snapshotToolDefs(branch, session);
	} catch {
		unit.finalBranch = undefined;
		unit.finalCwd = undefined;
		unit.finalToolDefs = undefined;
	}
	// Isolated fail-soft usage capture: a throwing/malformed getUsage() (or a
	// malformed SessionStats) leaves ONLY finalUsage undefined — it never wipes the
	// transcript snapshot above. Mirrors snapshotToolDefs' per-tool fail-soft
	// discipline. Own try/catch so a usage failure can't poison finalBranch/cwd/defs.
	try {
		unit.finalUsage = toLaneUsage(session.getUsage());
	} catch {
		unit.finalUsage = undefined;
	}
}

export function retireRun(runId: string, status: Exclude<LaneStatus, "running">, error?: string): void {
	const entry = state().lanes.get(runId);
	if (!entry) return;
	// Idempotent: FIRST retire wins. A lane can be retired by more than one path —
	// the manager's optimistic `x` cancel (lane-dock-editor) AND the runner's
	// terminal `onWorkflowEnd` (lane-progress) both call here for the same run.
	// The first call snapshots the transcript while the session is still live and
	// drops `currentSession`; a second call would re-snapshot off the now-absent
	// session and clobber `finalBranch` with `undefined`, wiping the viewable
	// transcript. Re-recording the SAME id (resume) flips the lane back to
	// "running" via `recordRun`, so this guard never strands a reactivated run.
	if (entry.status !== "running") return;
	entry.status = status;
	if (error !== undefined) entry.error = error; // terminal failure reason
	for (const unit of entry.units.values()) {
		// Snapshot from a STILL-LIVE session if one is attached (the `x` path). In the
		// normal detached path the host already captured per unit via
		// `captureFinalSnapshot` and dropped the session, so `currentSession` is
		// undefined here — DON'T re-snapshot (now per unit).
		if (unit.currentSession) captureSnapshotInto(unit, unit.currentSession);
		unit.currentSession = undefined; // drop the live session; KEEP finalBranch
		if (unit.status === "running") unit.status = "done"; // a never-ended unit reads terminal
		for (const p of unit.pendingInput) p.resolve(undefined); // never strand a child's resolver
		unit.pendingInput.length = 0;
	}
	entry.needsInputSince = undefined;
	notify();
}

/**
 * Capture a run's transcript snapshot WHILE its child session is still alive
 * (fast-path). The detached host calls this from its per-stage `finally`,
 * BEFORE `setCurrentSession(runId, undefined)` drops the session and `dispose()`
 * invalidates it — so when the runner's `onWorkflowEnd` later calls `retireRun`
 * (with `currentSession` already gone), the snapshot is already in place. Best-effort:
 * a missing/evicted lane is a no-op. Does NOT notify — the paired `setCurrentSession`
 * that immediately follows in the host does.
 */
export function captureFinalSnapshot(runId: string, index: number, session: LaneSession): void {
	const entry = state().lanes.get(runId);
	if (!entry) return;
	captureSnapshotInto(upsertUnit(entry, index), session);
}

/**
 * Record the persisted session file of a run's most-recent child (durable
 * path) — a durable string that outlives the disposed session and seeds the disk-jsonl
 * transcript fallback. Called by the host alongside `setCurrentSession` when a child
 * spawns. Best-effort: a missing lane or absent file is a no-op. No notify — it is
 * read lazily at disk-fallback time, and the paired `setCurrentSession` already notified.
 */
export function setLaneSessionFile(runId: string, index: number, file: string | undefined): void {
	if (file === undefined) return;
	const entry = state().lanes.get(runId);
	if (entry) upsertUnit(entry, index).lastSessionFile = file;
}

/** DISMISS a lane — hard-delete from the registry. The terminal-lane reaper:
 *  invoked by the manager's `x` on a finished lane and by the test reset. Settles
 *  any still-queued input so a child can never hang on a dangling resolver. */
export function evictRun(runId: string): void {
	const { lanes } = state();
	const entry = lanes.get(runId);
	if (!entry) return;
	lanes.delete(runId);
	for (const unit of entry.units.values()) for (const p of unit.pendingInput) p.resolve(undefined);
	notify();
}

/** Update a lane's status (best-effort — a missing lane is a no-op). */
export function setLaneStatus(runId: string, status: LaneStatus): void {
	const entry = state().lanes.get(runId);
	if (!entry || entry.status === status) return;
	entry.status = status;
	notify();
}

/** Point a unit sub-lane at its currently-live child — replaces the prior.
 *  The clear path (`session === undefined`, the host's teardown) only operates on an
 *  EXISTING unit, so a teardown after `clearUnitLanes` never resurrects a cleared unit. */
export function setCurrentSession(runId: string, index: number, session: LaneSession | undefined): void {
	const entry = state().lanes.get(runId);
	if (!entry) return; // run not recorded (or already evicted) — ignore
	if (session === undefined) {
		const unit = entry.units.get(index);
		if (!unit) return; // nothing to clear
		unit.currentSession = undefined;
	} else {
		upsertUnit(entry, index).currentSession = session;
	}
	notify();
}

/** Mark a fan-out unit STARTED (bridge `onUnitStart`): upsert its sub-lane with the
 *  display `label` + running status. The host publishes the live session separately
 *  via `setCurrentSession`; both lazily upsert the same key in either order. */
export function setUnitStarted(runId: string, index: number, label: string): void {
	const entry = state().lanes.get(runId);
	if (!entry) return;
	const unit = upsertUnit(entry, index);
	unit.label = label;
	unit.status = "running";
	notify();
}

/** Flip ONE unit terminal (bridge `onUnitEnd` → "done"). Best-effort — the row stays
 *  viewable via its snapshot/disk transcript; a missing/unchanged unit is a no-op. */
export function markUnitDone(runId: string, index: number, status: "done" | "failed"): void {
	const unit = state().lanes.get(runId)?.units.get(index);
	if (!unit || unit.status === status) return;
	unit.status = status;
	notify();
}

/** Orphan sweep (the asymmetric `onUnitStart`…`onUnitEnd` bracket): flip every
 *  still-"running" unit to a terminal status. The bridge calls this from
 *  `onStageError`/`onWorkflowEnd` because a fail-fast/abort/throw unit fires
 *  `onUnitStart` with NO matching `onUnitEnd` — without the sweep its sub-row would
 *  spin forever. The disk `.jsonl` still backs the transcript for post-mortem. */
export function sweepRunningUnits(runId: string, status: "done" | "failed"): void {
	const entry = state().lanes.get(runId);
	if (!entry) return;
	let changed = false;
	for (const unit of entry.units.values()) {
		if (unit.status === "running") {
			unit.status = status;
			changed = true;
		}
	}
	if (changed) notify();
}

/** Clear the per-unit map at a NEW fan-out generation (bridge `onLoopStart`): the
 *  engine resets `cursor.slots` per loop, so the registry shows only the CURRENT
 *  generation's units (a run may fan out several times, reusing indices 0..N).
 *  Settles any dangling `pendingInput` so a child never hangs, and resets the lane
 *  clock. No-op on an empty map (the single-stage / first-generation path). */
export function clearUnitLanes(runId: string): void {
	const entry = state().lanes.get(runId);
	if (!entry || entry.units.size === 0) return;
	for (const unit of entry.units.values()) for (const p of unit.pendingInput) p.resolve(undefined);
	entry.units.clear();
	entry.needsInputSince = undefined;
	notify();
}

/** Update a lane's live stage progress (best-effort — a missing/evicted
 *  run is a no-op, so non-detached runs cost nothing). */
export function setLaneProgress(runId: string, progress: LaneProgress | undefined): void {
	const entry = state().lanes.get(runId);
	if (!entry) return;
	entry.progress = progress;
	notify();
}

/**
 * Record a stage entry and return the running count of DISTINCT stages visited
 * for this run — the `LaneProgress.visited` numerator. Idempotent per stage name
 * (a `Set`), so the bridge can call it from every per-stage event (start, retry,
 * unit-end) and always read back the correct distinct count without inflating it
 * on a loop-back. Returns 0 for a missing/evicted run (best-effort, like
 * `setLaneProgress`). Does NOT `notify()` — the paired `setLaneProgress` does.
 */
export function noteVisitedStage(runId: string, stageName: string): number {
	const entry = state().lanes.get(runId);
	if (!entry) return 0;
	const visited = entry.visitedStages ?? new Set<string>();
	visited.add(stageName);
	entry.visitedStages = visited;
	return visited.size;
}

/**
 * Seed the distinct-visited accumulator with stage names the engine already walked
 * — the reconstructed `RunContext.visited` carried on `onWorkflowStart`'s
 * `LifecycleContext.visited`. UNIONS into the set (never replaces), so it composes
 * with `noteVisitedStage`: a fresh run seeds an empty list (no-op), while a RESUMED
 * run seeds its reconstructed walk so the first post-resume `noteVisitedStage` reads
 * back the true distinct count instead of recounting from zero (the `1/17`-near-done
 * bug). Idempotent + best-effort (a missing/evicted run no-ops). Returns the running
 * size. Does NOT `notify()` — the numerator surfaces on the next `setLaneProgress`.
 */
export function seedVisitedStages(runId: string, names: readonly string[]): number {
	const entry = state().lanes.get(runId);
	if (!entry) return 0;
	const visited = entry.visitedStages ?? new Set<string>();
	for (const name of names) visited.add(name);
	entry.visitedStages = visited;
	return visited.size;
}

/** Enqueue a deferred foreground-stage UI request onto a UNIT's queue (relay).
 *  Stamps the LANE-level needs-input clock on the FIRST enqueue across the
 *  lane that finds it unset (held across a transient drain→refill so the aging
 *  heading never resets mid-wait). A missing run settles immediately so the child
 *  never hangs. */
export function enqueueInput(runId: string, index: number, pending: PendingInput): void {
	const entry = state().lanes.get(runId);
	if (!entry) {
		pending.resolve(undefined);
		return;
	}
	if (entry.needsInputSince === undefined) entry.needsInputSince = Date.now();
	upsertUnit(entry, index).pendingInput.push(pending);
	notify();
}

/** Pop the oldest pending input for ONE unit (drain). Does NOT clear the
 *  lane clock on drain-to-empty (it's a continuous-wait marker reset only at
 *  retire/evict/reactivate/clear). */
export function dequeueInput(runId: string, index: number): PendingInput | undefined {
	const pending = state().lanes.get(runId)?.units.get(index)?.pendingInput.shift();
	if (pending) notify();
	return pending;
}

/** Wire a run's abort handle so the manager can cancel it without the
 *  user switching in. Best-effort — a missing lane is a no-op. */
export function setLaneAbort(runId: string, abort: () => void): void {
	const entry = state().lanes.get(runId);
	if (entry) entry.abort = abort;
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

/** A lane by id, or undefined. */
export function getLane(runId: string): LaneEntry | undefined {
	return state().lanes.get(runId);
}

/** All lanes, insertion-ordered (launch order). */
export function listLanes(): LaneEntry[] {
	return [...state().lanes.values()];
}

/** One row in the dock's flattened display/selection list: a lane (parent) row
 *  or a unit sub-row. Selection indexes this list; the four lane-resolving dock
 *  actions dereference a row to `(runId, unitIndex)`. */
export type DisplayRow =
	| { readonly kind: "lane"; readonly lane: LaneEntry }
	| { readonly kind: "unit"; readonly lane: LaneEntry; readonly unit: UnitLane };

/**
 * Rows ordered for DISPLAY — the same STABLE lane priority sort
 * (needs-input → running → terminal, insertion-stable within a bucket) with each
 * lane's CURRENT-generation unit sub-rows flattened directly beneath it, ascending by
 * declared index (the fold's order, so a sibling completing never shifts a selected
 * row). Only keys ≥ 0 become sub-rows — the `SINGLE_UNIT_KEY` slot is the lane row's
 * own session, so a single-stage run yields exactly one (lane) row.
 */
export function listLanesForDisplay(): DisplayRow[] {
	const bucket = (l: LaneEntry): number => {
		if (laneNeedsInput(l.runId)) return 0;
		if (l.status === "running") return 1;
		return 2;
	};
	const lanes = [...state().lanes.values()]
		.map((lane, index) => ({ lane, index }))
		.sort((a, b) => bucket(a.lane) - bucket(b.lane) || a.index - b.index)
		.map((d) => d.lane);
	const rows: DisplayRow[] = [];
	for (const lane of lanes) {
		rows.push({ kind: "lane", lane });
		const indices = [...lane.units.keys()].filter((k) => k >= 0).sort((a, b) => a - b);
		for (const i of indices) rows.push({ kind: "unit", lane, unit: lane.units.get(i)! });
	}
	return rows;
}

/** A unit sub-lane by (runId, index), or undefined. The viewer/dock address source. */
export function getUnit(runId: string, index: number): UnitLane | undefined {
	return state().lanes.get(runId)?.units.get(index);
}

/** True when ANY of a lane's units has ≥1 deferred UI request (the lane-level
 *  ⚑ badge + the needs-input display bucket). */
export function laneNeedsInput(runId: string): boolean {
	const entry = state().lanes.get(runId);
	if (!entry) return false;
	for (const unit of entry.units.values()) if (unit.pendingInput.length > 0) return true;
	return false;
}

/** True when a SPECIFIC unit sub-row has ≥1 deferred UI request (the per-row ⚑). */
export function unitNeedsInput(runId: string, index: number): boolean {
	return (state().lanes.get(runId)?.units.get(index)?.pendingInput.length ?? 0) > 0;
}

/**
 * Resolve a unit's EFFECTIVE token usage for rendering: the teardown snapshot
 * (`finalUsage`, post-retirement) when present, else the live child's usage narrowed
 * through the shared `toLaneUsage` (during execution). Fail-soft: a throwing or
 * malformed live `getUsage()` returns undefined (never throws into a render tick),
 * mirroring `captureSnapshotInto`'s isolated usage try/catch. Returns undefined for a
 * missing unit or a unit with neither snapshot nor live session.
 */
export function unitUsage(unit: UnitLane | undefined): LaneUsage | undefined {
	if (!unit) return undefined;
	if (unit.finalUsage) return unit.finalUsage;
	if (!unit.currentSession) return undefined;
	try {
		return toLaneUsage(unit.currentSession.getUsage());
	} catch {
		return undefined;
	}
}

/** Count of in-flight lanes — the overlay's auto-show/hide gate. */
export function laneCount(): number {
	return state().lanes.size;
}

// ---------------------------------------------------------------------------
// Subscription — overlay + manager re-render on any change.
// ---------------------------------------------------------------------------

/** Subscribe to registry changes; returns an unsubscribe fn. */
export function subscribeLanes(listener: Listener): () => void {
	const { listeners } = state();
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

// ---------------------------------------------------------------------------
// Focus — the currently switched-into lane (gates the per-run abort tap).
// Deliberately OUTSIDE the notify cycle: nothing renders from focus; the abort
// tap reads it synchronously per keystroke.
// ---------------------------------------------------------------------------

/** Mark the lane the user has switched into (undefined = back at root). The
 *  switcher sets this around the viewer; the abort tap reads it. */
export function setFocusedRun(runId: string | undefined): void {
	state().focusedRunId = runId;
}

/** The currently switched-into run, or undefined at root. */
export function getFocusedRun(): string | undefined {
	return state().focusedRunId;
}

// ---------------------------------------------------------------------------
// Dock — the always-mounted belowEditor lane dock's navigation state. Unlike
// focus (above), the dock renders from this, so every setter notify()s. The
// dock editor writes it from the idle prompt; the dock widget reads it. Selection
// is clamped against listLanesForDisplay() (the dock's render order) on write and
// on read so an evicted lane never strands the cursor past the last row.
// ---------------------------------------------------------------------------

/** Count of flattened display rows (Σ over lanes of 1 lane row + its unit sub-rows,
 *  keys ≥ 0). The clamp ceiling — replacing `lanes.size`, which could never reach a
 *  unit row below the last lane. */
function displayRowCount(): number {
	let n = 0;
	for (const lane of state().lanes.values()) {
		n += 1; // the lane row
		for (const k of lane.units.keys()) if (k >= 0) n += 1; // its unit sub-rows
	}
	return n;
}

/** Clamp `index` into the valid selection range for the current FLATTENED display. */
function clampSelection(index: number): number {
	const last = displayRowCount() - 1;
	if (last < 0) return 0;
	return Math.max(0, Math.min(last, index));
}

/** Activate or deactivate dock navigation. Deactivating resets the selection to
 *  the top so a fresh entry always starts at the first row. No-op (no notify) when
 *  already in the requested state. */
export function setDockActive(active: boolean): void {
	const s = state();
	if (s.dockActive === active) return;
	s.dockActive = active;
	if (!active) s.dockSelection = 0;
	else s.dockSelection = clampSelection(s.dockSelection);
	notify();
}

/** Set the selected dock row (clamped). No-op (no notify) when unchanged. */
export function setDockSelection(index: number): void {
	const s = state();
	const next = clampSelection(index);
	if (s.dockSelection === next) return;
	s.dockSelection = next;
	notify();
}

/** Move the dock selection by `delta` rows (clamped). */
export function moveDockSelection(delta: number): void {
	setDockSelection(state().dockSelection + delta);
}

/** Read the dock's navigation state. Selection is clamped on read so a caller
 *  indexing listLanesForDisplay() with it is always in bounds even if a lane was
 *  evicted since the last write. */
export function getDockState(): { active: boolean; selection: number } {
	const s = state();
	return { active: s.dockActive, selection: clampSelection(s.dockSelection) };
}

/** Test reset — wired into test/setup.ts beforeEach. Clears lanes, listeners, focus
 *  IN PLACE so the process-global slot identity is preserved across resets. */
export function __resetRunLaneRegistry(): void {
	const s = state();
	s.lanes.clear();
	s.listeners.clear();
	s.focusedRunId = undefined;
	s.dockActive = false;
	s.dockSelection = 0;
}
