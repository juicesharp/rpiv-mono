/**
 * question-lifecycle — a consumer-neutral pub/sub stream of workflow question
 * lifecycle events, sourced from run-lane-registry's pending-input queue.
 *
 * run-lane-registry is the PRODUCER: every mutation that parks or settles a
 * foreground-contract stage's deferred question emits here (AFTER its own
 * `notify()`). This module is the SIGNAL surface a consumer subscribes to — it
 * owns NO registry state and imports NO `ExtensionAPI`, so any extension can read
 * the question lifecycle without coupling to the lane model. The first consumer
 * is the Warp badge bridge (workflow-question-warp-bridge.ts), which translates
 * the aggregate 0→≥1 / ≥1→0 transitions into OSC badge events.
 *
 * Instance-independent channel: the listener Set is anchored on a process-global
 * `Symbol.for("@juicesharp/rpiv-pi:questionLifecycle")` slot — NOT module-level
 * state. A detached workflow child re-loads rpiv-core and may get a SEPARATE
 * module instance; a module-local Set would split producers and consumers across
 * instances. The global slot guarantees every instance shares ONE stream,
 * mirroring run-lane-registry's own slot discipline. Reset in place by
 * `__resetQuestionLifecycle()` in test/setup.ts beforeEach.
 *
 * Fail-soft `publish`: a throwing listener never blocks its siblings or the
 * registry mutation that triggered the emit — per-listener try/catch, mirroring
 * run-lane-registry's `notify()`.
 */

/** Why a parked question left the outstanding set. */
export type QuestionResolveReason = "answered" | "cleared";

/** A foreground-contract stage parked a question (a deferred `ask_user_question`). */
export interface QuestionAskedEvent {
	readonly kind: "asked";
	readonly runId: string;
	readonly unitIndex: number;
	/** The lane's display name (run --name, else the workflow name). */
	readonly name: string;
	/** The run's workflow name (undefined for pre-field lanes — impossible in-session). */
	readonly workflow: string | undefined;
	/** The run's original /wf input (undefined for a prompt-less run). */
	readonly input: string | undefined;
	/** `Date.now()` stamp — extension code (the no-`Date.now` rule is workflow scripts). */
	readonly at: number;
}

export interface QuestionResolvedEvent {
	readonly kind: "resolved";
	readonly runId: string;
	readonly unitIndex: number;
	/**
	 * Why the parked question left the outstanding set:
	 * - `"answered"` — the question was dequeued and its answer consumed
	 *   (`dequeueInput`, the normal foreground-contract drain). Balanced 1:1 with
	 *   a prior `asked` for the same `(runId, unitIndex)`.
	 * - `"cleared"` — the question was DROPPED wholesale by a teardown settle
	 *   (`recordRun` reactivation, `retireRun`, `evictRun`, `clearUnitLanes`), NOT
	 *   count-balanced against `asked`: a single teardown clears ALL outstanding
	 *   questions for the affected unit in one shot. Consumers must treat a
	 *   `cleared` event as "drop ALL outstanding state for `(runId, unitIndex)`"
	 *   regardless of how many `asked` events preceded it. Under the load-bearing
	 *   ≤1-parked-question-per-unitIndex invariant (`ask_user_question` is
	 *   blocking) this is a 1:1 drop in practice, but the semantics are
	 *   reason-agnostic, total clearance.
	 */
	readonly reason: QuestionResolveReason;
	/** `Date.now()` stamp — extension code (the no-`Date.now` rule is workflow scripts). */
	readonly at: number;
}

export type QuestionLifecycleEvent = QuestionAskedEvent | QuestionResolvedEvent;

type QuestionLifecycleListener = (event: QuestionLifecycleEvent) => void;

// ---------------------------------------------------------------------------
// Process-global state — anchored on a `globalThis[Symbol.for(...)]` slot, NOT
// plain module-level state. A detached workflow child re-loads rpiv-core (Pi's
// jiti loader may hand each child a SEPARATE module instance); a module-local Set
// would give the producer (registry) and a consumer (bridge) DIFFERENT streams.
// The global slot guarantees one shared stream across every instance, mirroring
// run-lane-registry's slot discipline. Reset in place by
// __resetQuestionLifecycle() in test/setup.ts beforeEach.
// ---------------------------------------------------------------------------

interface LifecycleState {
	readonly listeners: Set<QuestionLifecycleListener>;
}

const LIFECYCLE_SLOT = Symbol.for("@juicesharp/rpiv-pi:questionLifecycle");

/** Read the single process-global lifecycle state, lazily creating it on first access. */
function state(): LifecycleState {
	const g = globalThis as Record<symbol, unknown>;
	let s = g[LIFECYCLE_SLOT] as LifecycleState | undefined;
	if (s === undefined) {
		s = { listeners: new Set<QuestionLifecycleListener>() };
		g[LIFECYCLE_SLOT] = s;
	}
	return s;
}

/** Fire every subscriber; fail-soft so one throwing listener never blocks the rest
 *  (mirrors run-lane-registry's `notify()`). */
function publish(event: QuestionLifecycleEvent): void {
	for (const l of state().listeners) {
		try {
			l(event);
		} catch {
			// a lifecycle listener must never break the registry's emit
		}
	}
}

/**
 * Emit an `asked` event — call AFTER the registry's `notify()` so a subscriber
 * observes the committed park. Called by run-lane-registry's `enqueueInput`
 * entry-exists path (the missing-run early-return emits nothing).
 */
export function emitQuestionAsked(
	runId: string,
	unitIndex: number,
	name: string,
	workflow: string | undefined,
	input: string | undefined,
): void {
	publish({ kind: "asked", runId, unitIndex, name, workflow, input, at: Date.now() });
}

/**
 * Emit a `resolved` event — call AFTER the registry's `notify()` so a subscriber
 * observes the committed settle. Called by `dequeueInput` (`"answered"`) and every
 * teardown settle loop (`"cleared"`).
 */
export function emitQuestionResolved(runId: string, unitIndex: number, reason: QuestionResolveReason): void {
	publish({ kind: "resolved", runId, unitIndex, reason, at: Date.now() });
}

/** Subscribe to the question-lifecycle stream; returns an unsubscribe fn. */
export function subscribeQuestionLifecycle(listener: QuestionLifecycleListener): () => void {
	const { listeners } = state();
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Test reset — wired into test/setup.ts beforeEach. Clears the listener Set IN
 *  PLACE so the process-global slot identity is preserved across resets. */
export function __resetQuestionLifecycle(): void {
	state().listeners.clear();
}
