/**
 * run-lane-registry — session-scoped singleton tracking each in-flight detached
 * /wf run as a switchable "lane".
 *
 * The launcher (root) owns this registry; detached runs are attached views under
 * it. A lane carries the run identity, a live status, the run's CURRENTLY-LIVE
 * child AgentSession (the viewer's transcript source), and a FIFO queue of
 * deferred UI requests from foreground-contract stages (FR5).
 *
 * Lives in rpiv-pi (NOT rpiv-workflow): rpiv-workflow must not import rpiv-pi
 * (clean-install contract), so retained sessions + the registry + the FR5 relay
 * are all rpiv-side, and the "needs input" signal is a direct in-process call —
 * no new cross-package relay channel. Module-level state mirrors session-capture;
 * __resetRunLaneRegistry is wired into test/setup.ts beforeEach.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

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
	/** In-memory branch (always current); the viewer renders this. Typed `unknown`
	 *  — the viewer narrows via rpiv-workflow's BranchEntry shape. */
	readonly sessionManager: { getBranch(): unknown };
	/** Fires on every streaming tick; the viewer re-renders on it. Returns unsub. */
	subscribe(listener: () => void): () => void;
}

/** The two args of ctx.ui.custom — captured verbatim so a deferred questionnaire
 *  replays on the launcher UI byte-identically (drift-proof via Parameters<>). */
type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
type CustomOptions = Parameters<ExtensionUIContext["custom"]>[1];

/**
 * A foreground-contract stage's deferred UI request (FR5). The relay captures the
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

/**
 * Live stage progress for a lane (Phase 8) — sourced from the workflow lifecycle
 * bus (lane-progress.ts) and rendered by the overlay in place of the blind
 * `streaming…` label. Absent (undefined) before the first stage starts.
 */
export interface LaneProgress {
	stageNumber: number;
	totalStages: number;
	stageName: string;
	/** Glyph selector: running spinner · ⟲ retry · ✗ error. */
	phase: "running" | "retry" | "error";
	/** onStageRetry — "retry 2/3". */
	attempt?: number;
	/** Fanout sub-progress (onLoopStart seeds total; onUnitStart/End advance done). */
	units?: { done: number; total: number };
}

/** One switchable run lane. */
export interface LaneEntry {
	readonly runId: string;
	/** Display name — the run's --name, else the workflow name. */
	name: string;
	status: LaneStatus;
	/** The run's currently-live child session (the viewer source); undefined
	 *  between stages, before the first child spawns, or after retirement. */
	currentSession: LaneSession | undefined;
	/** FIFO of deferred foreground-stage UI requests (FR5). */
	readonly pendingInput: PendingInput[];
	/** Live stage progress (Phase 8); undefined until the first onStageStart. */
	progress: LaneProgress | undefined;
	/**
	 * Transcript snapshot captured at retirement (Phase A) — the live session is
	 * dropped when a run terminates, so the viewer renders this for a finished
	 * (retained-but-not-yet-dismissed) lane. Typed `unknown`; the viewer narrows.
	 */
	finalBranch?: unknown;
	/**
	 * When this lane first started waiting on a deferred foreground question
	 * (Phase C) — `Date.now()` at the 0→≥1 pendingInput transition, cleared when
	 * the queue drains or the lane retires/evicts. Drives the overlay's aging
	 * "needs input · 4m" heading. `Date.now()` is fine here (extension code; the
	 * no-`Date.now` rule applies to workflow *scripts*, not the rpiv-pi runtime).
	 */
	needsInputSince?: number;
	/**
	 * Abort handle for this run (Phase D) — the per-run `AbortController.abort`
	 * wired by the execution host. Lets the manager cancel a running lane without
	 * the user switching in (which the focus-gated Ctrl-C tap would otherwise
	 * require). Undefined for headless runs (no abort tap).
	 */
	abort?: () => void;
}

type Listener = () => void;

// ---------------------------------------------------------------------------
// Process-global state (Phase 7.3) — anchored on a `globalThis[Symbol.for(...)]`
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
		s = { lanes: new Map<string, LaneEntry>(), listeners: new Set<Listener>(), focusedRunId: undefined };
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

/** Record a run at launch (FR1). Idempotent: a second record updates the name. */
export function recordRun(runId: string, name: string): void {
	const { lanes } = state();
	const existing = lanes.get(runId);
	if (existing) {
		existing.name = name;
	} else {
		lanes.set(runId, {
			runId,
			name,
			status: "running",
			currentSession: undefined,
			pendingInput: [],
			progress: undefined,
		});
	}
	notify();
}

/**
 * RETIRE a run when it terminates (Phase A) — the run leaves the active set but
 * the lane is RETAINED (not deleted) so the user can come back to a finished run,
 * see its terminal status in the overlay, and open its transcript. Captures a
 * final transcript snapshot before the live session is dropped, settles any
 * queued input (a stalled child must never hang on a dangling resolver), and
 * clears the needs-input clock. The lane lives until the user dismisses it
 * (`evictRun`, via the manager's `x`) or a session reset.
 */
export function retireRun(runId: string, status: Exclude<LaneStatus, "running">): void {
	const entry = state().lanes.get(runId);
	if (!entry) return;
	entry.status = status;
	// Snapshot the transcript before dropping the live session — fail-soft: a
	// disposed/odd session just yields no snapshot (viewer shows "unavailable").
	try {
		entry.finalBranch = entry.currentSession?.sessionManager.getBranch();
	} catch {
		entry.finalBranch = undefined;
	}
	entry.currentSession = undefined;
	entry.needsInputSince = undefined;
	for (const p of entry.pendingInput) p.resolve(undefined);
	entry.pendingInput.length = 0;
	notify();
}

/** DISMISS a lane — hard-delete from the registry (FR6). The terminal-lane reaper:
 *  invoked by the manager's `x` on a finished lane and by the test reset. Settles
 *  any still-queued input so a child can never hang on a dangling resolver. */
export function evictRun(runId: string): void {
	const { lanes } = state();
	const entry = lanes.get(runId);
	if (!entry) return;
	lanes.delete(runId);
	for (const p of entry.pendingInput) p.resolve(undefined);
	notify();
}

/** Update a lane's status (best-effort — a missing lane is a no-op). */
export function setLaneStatus(runId: string, status: LaneStatus): void {
	const entry = state().lanes.get(runId);
	if (!entry || entry.status === status) return;
	entry.status = status;
	notify();
}

/** Point a lane at its currently-live child (Slice 2) — replaces the prior. */
export function setCurrentSession(runId: string, session: LaneSession | undefined): void {
	const entry = state().lanes.get(runId);
	if (!entry) return; // run not recorded (or already evicted) — ignore
	entry.currentSession = session;
	notify();
}

/** Update a lane's live stage progress (Phase 8; best-effort — a missing/evicted
 *  run is a no-op, so non-detached runs cost nothing). */
export function setLaneProgress(runId: string, progress: LaneProgress | undefined): void {
	const entry = state().lanes.get(runId);
	if (!entry) return;
	entry.progress = progress;
	notify();
}

/** Enqueue a deferred foreground-stage UI request (FR5, Slice 7). Stamps the
 *  needs-input clock (Phase C) on the 0→≥1 transition so the overlay can age it. */
export function enqueueInput(runId: string, pending: PendingInput): void {
	const entry = state().lanes.get(runId);
	if (!entry) {
		// No lane — the run is gone; settle so the child never hangs forever.
		pending.resolve(undefined);
		return;
	}
	if (entry.pendingInput.length === 0) entry.needsInputSince = Date.now();
	entry.pendingInput.push(pending);
	notify();
}

/** Pop the oldest pending input for a lane (FR5, Slice 7) — the manager replays it.
 *  Clears the needs-input clock (Phase C) once the queue drains. */
export function dequeueInput(runId: string): PendingInput | undefined {
	const entry = state().lanes.get(runId);
	const pending = entry?.pendingInput.shift();
	if (pending) {
		if (entry && entry.pendingInput.length === 0) entry.needsInputSince = undefined;
		notify();
	}
	return pending;
}

/** Wire a run's abort handle (Phase D) so the manager can cancel it without the
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
 * Lanes ordered for DISPLAY (Phase B) — a STABLE priority sort so the lane that
 * needs the user never hides below the overlay's `+N more` fold and sits at the
 * top of the manager: needs-input → running → terminal, insertion order preserved
 * within each bucket. Display-only; `listLanes()` keeps launch order for callers
 * that index by it.
 */
export function listLanesForDisplay(): LaneEntry[] {
	const bucket = (l: LaneEntry): number => {
		if (l.pendingInput.length > 0) return 0;
		if (l.status === "running") return 1;
		return 2;
	};
	// Stable: decorate with the original index, sort by (bucket, index).
	return [...state().lanes.values()]
		.map((lane, index) => ({ lane, index }))
		.sort((a, b) => bucket(a.lane) - bucket(b.lane) || a.index - b.index)
		.map((d) => d.lane);
}

/** True when a lane has ≥1 deferred UI request (the "needs input" badge source). */
export function laneNeedsInput(runId: string): boolean {
	return (state().lanes.get(runId)?.pendingInput.length ?? 0) > 0;
}

/** Count of in-flight lanes — the overlay's auto-show/hide gate. */
export function laneCount(): number {
	return state().lanes.size;
}

/**
 * The run's DISTINGUISHING short id for the overlay/manager rows (Phase 7.4).
 * `generateRunId` is `<timestamp-slug>-<hex>` (rpiv-workflow state/paths.ts), so
 * `slice(0, 6)` of the runId yields the shared date prefix (e.g. "2026-0") for
 * every same-month run — useless for telling two concurrent runs apart. The hex
 * suffix (after the LAST dash) is the random tail that actually differs. Falls
 * back to the whole id when there is no dash.
 */
export function shortRunId(runId: string): string {
	return runId.slice(runId.lastIndexOf("-") + 1);
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
// Focus — the currently switched-into lane (gates the per-run abort tap, Slice 6).
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
