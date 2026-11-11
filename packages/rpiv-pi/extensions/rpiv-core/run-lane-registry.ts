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

import type { RunRecap } from "@juicesharp/rpiv-workflow";

import { addLaneUsage, type LaneUsage, toLaneUsage } from "./lane-usage.ts";
import { emitQuestionAsked, emitQuestionResolved } from "./question-lifecycle.ts";
import type {
	DisplayRow,
	LaneEntry,
	LaneProgress,
	LaneSession,
	LaneStatus,
	PendingInput,
	UnitLane,
} from "./run-lane-types.ts";

// ---------------------------------------------------------------------------
// Lane data model — the type surface lives in ./run-lane-types.ts (this
// module's stateless companion: zero runtime except the SINGLE_UNIT_KEY
// sentinel). Everything it declares is re-exported here so consumers keep the
// single ./run-lane-registry.js specifier they already import — the module
// surface is conserved exactly across the split. SINGLE_UNIT_KEY rides a
// VALUE re-export so mocks that spread this module's actual exports keep
// observing it through the same specifier.
// ---------------------------------------------------------------------------

export type {
	DisplayRow,
	LaneEntry,
	LaneProgress,
	LaneSession,
	LaneStatus,
	PendingInput,
	UnitLane,
} from "./run-lane-types.ts";
export { SINGLE_UNIT_KEY } from "./run-lane-types.ts";

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

/**
 * The single teardown settle-and-emit epilogue shared by `recordRun` (resume
 * reactivation), `retireRun`, `evictRun`, and `clearUnitLanes`. Ordering contract:
 * capture each unit with a parked question BEFORE settling (the settle drains the
 * queue that identifies it, so the index must be read first — captured units stay
 * addressable for a `cleared` emit after notify); settle every parked resolver with
 * `undefined` BEFORE the site mutation (a stalled child must never hang on a dangling
 * resolver, whatever teardown follows); run the site-specific mutation (`afterSettle`);
 * `notify()` BEFORE any `cleared` emit — notify listeners run synchronously inline, so
 * a lane subscriber must observe the fully committed teardown, not a half-settled one;
 * then emit `cleared` for ONLY the units that had parked input — a settle that parked
 * nothing publishes nothing, so a fresh `recordRun` notifies without emitting. An
 * undefined `entry` skips the settle loop entirely (the fresh-recordRun path). The
 * unconditional queue truncation is a deliberate dead store at the sites whose queue
 * dies with its map or lane inside `afterSettle`; `retireRun` is the one site whose
 * units survive the settle and rely on it.
 */
function settleAndEmitCleared(runId: string, entry: LaneEntry | undefined, afterSettle: () => void): void {
	const cleared: number[] = [];
	if (entry) {
		for (const unit of entry.units.values()) {
			if (unit.pendingInput.length > 0) cleared.push(unit.index);
			for (const p of unit.pendingInput) p.resolve(undefined); // never strand a child's resolver
			unit.pendingInput.length = 0;
		}
	}
	afterSettle();
	notify();
	for (const idx of cleared) emitQuestionResolved(runId, idx, "cleared");
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
	settleAndEmitCleared(runId, existing, () => {
		if (existing) {
			existing.name = name;
			existing.workflow = meta?.workflow ?? existing.workflow;
			existing.input = meta?.input ?? existing.input;
			existing.status = "running"; // reactivate a retained terminal lane (resume)
			dropUnitLanes(runId, existing); // bank the prior run's unit tokens, drop its sessions + snapshots
			existing.error = undefined; // clear the prior run's terminal failure reason
			existing.lastArtifact = undefined; // clear the prior run's primary artifact path
			existing.recap = undefined; // clear the prior run's end-of-run summary
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
				stageUsage: new Map<string, LaneUsage>(),
				progress: undefined,
			});
		}
	});
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

export function retireRun(
	runId: string,
	status: Exclude<LaneStatus, "running">,
	error?: string,
	lastArtifact?: string,
): void {
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
	if (lastArtifact !== undefined) entry.lastArtifact = lastArtifact; // primary artifact path (completed runs)
	settleAndEmitCleared(runId, entry, () => {
		for (const unit of entry.units.values()) {
			// Snapshot from a STILL-LIVE session if one is attached (the `x` path). In the
			// normal detached path the host already captured per unit via
			// `captureFinalSnapshot` and dropped the session, so `currentSession` is
			// undefined here — DON'T re-snapshot (now per unit).
			if (unit.currentSession) captureSnapshotInto(unit, unit.currentSession);
			unit.currentSession = undefined; // drop the live session; KEEP finalBranch
			// A never-ended unit reads terminal — including a pending unit that never fired
			// onUnitStart (a fanout generation that retired before its units dispatched).
			if (unit.status === "running" || unit.status === "pending") unit.status = "done";
		}
		entry.needsInputSince = undefined;
	});
}

/**
 * Store a run's end-of-run summary — the SOLE recap writer, deliberately ungated
 * by the lane's terminal status: the x-key `stopSelected` path (lane-console.ts)
 * retires the lane to "aborted" while the run is still in-flight, and the recap
 * computed at `onWorkflowEnd` must still land on that already-terminal lane
 * (`retireRun` is a first-retire-wins no-op there and never touches `recap`).
 * The host's hard-teardown dispose fallback (workflow-execution-host.ts), where
 * `onWorkflowEnd` may never fire, stores no recap — such a lane reads bare
 * "aborted". Best-effort: a missing lane is a no-op.
 */
export function setRecap(runId: string, recap: RunRecap): void {
	const entry = state().lanes.get(runId);
	if (!entry) return;
	entry.recap = recap;
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
	const unit = upsertUnit(entry, index);
	// The fold is gated on a LIVE lane (`status === "running"`): the dock's optimistic
	// `x` cancel calls `retireRun` BEFORE this teardown capture, and retire's own snapshot
	// parks the SAME still-live child's usage onto the slot — so the parked value here is a
	// same-child re-capture, not an outgoing sibling. Folding here would double-count (once
	// in the bucket, once via the retained unit at render). Post-retirement the overwrite-only
	// path is exactly right.
	if (unit.finalUsage && entry.status === "running") {
		// Fold-at-overwrite: a sequential multi-child stage parks EVERY child on the SAME
		// `SINGLE_UNIT_KEY` slot, so `captureSnapshotInto`'s `finalUsage =` overwrite would
		// evict each OUTGOING child's tokens before the stage-end `foldStageUsage` can count
		// them (losing all but the last). Fold the unit's already-parked `finalUsage` (the
		// outgoing child) into the CURRENT stage bucket via `addStageUsage` BEFORE the
		// overwrite; the overwrite then EVICTS it from the slot, so `foldStageUsage` cannot
		// re-count it. Capture-time (children 1..N-1) and stage-end (surviving last child N)
		// touch disjoint sets → fold-exactly-once, no double-count. Usage-only —
		// `finalBranch`/`finalCwd`/`finalToolDefs` stay last-writer-wins across the overwrite.
		addStageUsage(runId, entry.progress?.stageName, unit.finalUsage);
	}
	captureSnapshotInto(unit, session);
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
	settleAndEmitCleared(runId, entry, () => {
		lanes.delete(runId);
	});
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
		// A pending unit never fired onUnitStart, so it never has a matching onUnitEnd —
		// sweep it alongside a still-running unit so neither spins forever.
		if (unit.status === "running" || unit.status === "pending") {
			unit.status = status;
			changed = true;
		}
	}
	if (changed) notify();
}

/** Empty a lane's per-unit map WITHOUT losing its tokens: the outgoing units' usage is
 *  folded into their stage's `stageUsage` bucket first, so `units` and `stageUsage` never
 *  overlap and nothing is dropped uncounted. The one place units are discarded — shared by
 *  `clearUnitLanes` (stage / generation transition) and `recordRun` (resume reactivation).
 *  Reads `progress.stageName`, so it runs BEFORE any caller resets `progress`. */
function dropUnitLanes(runId: string, entry: LaneEntry): void {
	foldStageUsage(runId);
	entry.units.clear();
}

/** Clear the per-unit map at a stage or fan-out generation transition (bridge
 *  `onStageStart`/`onLoopStart`): the engine resets `cursor.slots` per loop, so the
 *  registry shows only the CURRENT generation's units (a run may fan out several times,
 *  reusing indices 0..N). The outgoing units' tokens are banked into `stageUsage` (see
 *  `dropUnitLanes`). Settles any dangling `pendingInput` so a child never hangs, and resets
 *  the lane clock. No-op on an empty map (the single-stage / first-generation path). */
export function clearUnitLanes(runId: string): void {
	const entry = state().lanes.get(runId);
	if (!entry || entry.units.size === 0) return;
	settleAndEmitCleared(runId, entry, () => {
		dropUnitLanes(runId, entry);
		entry.needsInputSince = undefined;
	});
}

/** Pairwise-accumulate one stage's usage into the `stageUsage` bucket for `runId` +
 *  `stageName` via `addLaneUsage` (so a re-folded stage SUMS, never overwrites). No-op
 *  on undefined usage / missing lane / undefined stageName — a pre-first-stage fold, or a
 *  lane with no live progress, records nothing. Does NOT notify (the caller's
 *  own notify covers it). */
export function addStageUsage(runId: string, stageName: string | undefined, usage: LaneUsage | undefined): void {
	if (usage === undefined || stageName === undefined) return;
	const entry = state().lanes.get(runId);
	if (!entry) return;
	const existing = entry.stageUsage.get(stageName);
	entry.stageUsage.set(stageName, existing ? addLaneUsage(existing, usage)! : usage);
}

/** Fold the CURRENT stage's per-unit orchestrator tokens into its `stageUsage` bucket.
 *  Reads the OUTGOING stage name off `progress.stageName` (`dropUnitLanes` runs it BEFORE
 *  the units are emptied, and the bridge clears BEFORE `setLaneProgress` flips to the next
 *  name), then folds each unit's effective `unitUsage` (teardown snapshot else live child)
 *  into that stage's bucket via `addStageUsage`. Does NOT clear `units` — calling it alone
 *  and then `dropUnitLanes` counts the same units twice. No-op when the stage name is unset
 *  or `units` is empty. Does NOT notify — the enclosing caller does. */
export function foldStageUsage(runId: string): void {
	const lane = state().lanes.get(runId);
	const stageName = lane?.progress?.stageName;
	if (!lane || stageName === undefined || lane.units.size === 0) return;
	for (const unit of lane.units.values()) addStageUsage(runId, stageName, unitUsage(unit));
}

/** Seed the CURRENT fan-out generation's unit sub-rows (bridge `onLoopStart` for a
 *  fanout): each declared unit's sub-lane is created FRESH keyed by its declared array
 *  `index`, so the dock fans out the generation the instant onLoopStart fires — BEFORE any
 *  onUnitStart flips a unit running. `status` defaults to "pending"; a resumed generation
 *  seeds its replayed units terminal ("done"/"failed") because they fire no unit events.
 *  Does NOT go through `upsertUnit` (the host's live-session lifecycle seeds "running");
 *  the pending→running flip is `setUnitStarted` (`onUnitStart`) on the SAME map key.
 *  One notify per seed. Best-effort: a missing run is a no-op, mirroring every sibling mutator. */
export function seedUnits(
	runId: string,
	units: ReadonlyArray<{ index: number; label: string; status?: "pending" | "done" | "failed" }>,
): void {
	const entry = state().lanes.get(runId);
	if (!entry) return;
	for (const u of units) {
		entry.units.set(u.index, {
			index: u.index,
			label: u.label,
			status: u.status ?? "pending",
			currentSession: undefined,
			pendingInput: [],
		});
	}
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

/** Enqueue a deferred foreground-stage UI request onto a UNIT's queue (relay).
 *  Stamps the LANE-level needs-input clock on the FIRST enqueue across the
 *  lane that finds it unset (held across a transient drain→refill so the aging
 *  heading never resets mid-wait). A missing run — or a retired (non-"running")
 *  lane — settles immediately so the child never hangs: the x-key abort races
 *  the child's relay park, and a park landing AFTER retireRun's settle pass
 *  would strand forever (first-retire-wins means no later settle runs), pinning
 *  the needs-input clock and the warp Blocked badge until manual evict/answer. */
export function enqueueInput(runId: string, index: number, pending: PendingInput): void {
	const entry = state().lanes.get(runId);
	if (entry?.status !== "running") {
		pending.resolve(undefined);
		return;
	}
	if (entry.needsInputSince === undefined) entry.needsInputSince = Date.now();
	upsertUnit(entry, index).pendingInput.push(pending);
	notify();
	// Emit AFTER notify() so a lifecycle subscriber observes the committed park. The
	// settle-immediately early-return above emits nothing (no question was ever parked).
	emitQuestionAsked(runId, index, entry.name, entry.workflow, entry.input);
}

/** Pop the oldest pending input for ONE unit (drain). Does NOT clear the
 *  lane clock on drain-to-empty (it's a continuous-wait marker reset only at
 *  retire/evict/reactivate/clear). */
export function dequeueInput(runId: string, index: number): PendingInput | undefined {
	const pending = state().lanes.get(runId)?.units.get(index)?.pendingInput.shift();
	if (pending) {
		notify();
		// Emit AFTER notify() so a lifecycle subscriber observes the committed dequeue.
		emitQuestionResolved(runId, index, "answered");
	}
	return pending;
}

/** Peek the oldest pending input for ONE unit WITHOUT removing it. The console reads
 *  the head to render the parked question; the switcher commits with `dequeueInput` +
 *  resolve ONLY on answer, so a defer/back-out leaves the FIFO and the needs-input
 *  clock intact (no notify — a read never mutates state). */
export function peekInput(runId: string, index: number): PendingInput | undefined {
	return state().lanes.get(runId)?.units.get(index)?.pendingInput[0];
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

/** Test reset — wired into test/setup.ts beforeEach. Clears lanes, listeners, focus
 *  IN PLACE so the process-global slot identity is preserved across resets. */
export function __resetRunLaneRegistry(): void {
	const s = state();
	s.lanes.clear();
	s.listeners.clear();
	s.focusedRunId = undefined;
}
