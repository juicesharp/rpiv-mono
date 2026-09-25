/**
 * Per-session runtime activity for stale-todo reminders. This is RUNTIME-ONLY
 * bookkeeping — it is deliberately NOT persisted, NOT replayed, and never
 * written into the `Task` shape or the `TaskDetails` snapshot. The live store
 * (`state/store.ts`) stays the single source of truth for task data; this
 * module only answers "how many turns has the model gone without touching
 * `todo`" for each session, which cannot be derived from persisted data.
 *
 * The map is keyed by session id so a detached/child session (distinct sid)
 * can never read or clobber another session's counters — same isolation
 * contract as `state/store.ts`.
 *
 * IMPORTANT — turn-index scoping: Pi resets `turnIndex` to 0 on every
 * `agent_start` (`_turnIndex = 0` in agent-session.js). So the counters here
 * are only meaningful WITHIN one low-level agent run. Across runs (a
 * follow-up prompt, a compaction retry, a queued continuation) the
 * "N turns without a todo call" count restarts from 0, and a fresh agent run
 * starts with `lastTodoTurn === undefined` (no baseline yet). This is
 * intentional: cross-run staleness is deliberately NOT tracked. The human
 * operator sees the todo list in the TUI at all times, so a reminder adds no
 * information for them; only the model's own in-run drift matters, and a
 * fresh agent run always starts from a clean todo state it re-reads on
 * demand. Do not try to make `currentTurn` monotonically grow across agent
 * runs — the runtime provides no stable per-session turn counter, and
 * inventing one would couple this module to Pi internals.
 */

export interface TodoActivity {
	/** The most recent `turn_end` turn index observed for this session. */
	currentTurn: number;
	/**
	 * The turn index of the last SUCCESSFUL `todo` call for this agent run.
	 * `undefined` = no successful `todo` call yet this run — no baseline, so
	 * no stale reminder may fire. IMPORTANT: this must be `undefined` (not a
	 * numeric sentinel), because a real successful call in turn 0 legitimately
	 * stores 0 and must not collide with the "no baseline" marker.
	 */
	lastTodoTurn?: number;
	/** The turn index of the last stale reminder injected (undefined = none yet). */
	lastReminderTurn?: number;
	/** Set on `session_compact`; consumed by the next `before_agent_start` to inject one resync hint. */
	compactionResyncPending?: boolean;
	/** Set by `tool_result` on a successful `todo` call; consumed by `turn_end` to advance `lastTodoTurn`. */
	todoSyncedThisTurn?: boolean;
}

/**
 * Per-session runtime activity. The Map is the single mutation seam — only
 * `getActivity` (get-or-create) and `resetActivityState` write it.
 */
const activities = new Map<string, TodoActivity>();

/** Get-or-create a session's activity slot. Returns the live object; callers
 *  mutate its fields in place (matches `state/store.ts`'s `commitState` spirit
 *  but keeps the activity row tiny and side-channel-free). */
export function getActivity(sessionId: string): TodoActivity {
	let activity = activities.get(sessionId);
	if (!activity) {
		activity = { currentTurn: 0 };
		activities.set(sessionId, activity);
	}
	return activity;
}

/** Test-setup reset. Wired into `state/store.ts` `__resetState` (see its comment)
 *  so the existing `__resetState` import path clears BOTH task state and activity
 *  counters. */
export function resetActivityState(): void {
	activities.clear();
}
