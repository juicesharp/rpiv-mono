import type { Task } from "../tool/types.ts";

/**
 * Runtime-only bookkeeping that decides WHEN the todo list is put back in
 * front of the model.
 *
 * The problem this solves (issues #159, #222): the task data itself survives
 * compaction — `replayFromBranch` reads it back out of the branch — but the
 * model's working context does not contain it. After a `/compact`, a `/resume`,
 * or a long stretch of tool work the model keeps issuing `update` calls against
 * a list it can no longer see, so statuses drift while the overlay looks
 * healthy.
 *
 * Nothing here is persisted or replayed: a `custom` entry is invisible to the
 * model (`docs/tool-schema.md`), and a `custom_message` reminder would itself be
 * summarized away by the next compaction. Reminders are therefore rendered on
 * demand by the `context_with_system` handler and cleared as soon as they are
 * consumed. Only the task state is durable; every counter below is rebuilt from
 * live events.
 */
export interface SyncSettings {
	/** Turns without a successful `todo` call before a reminder is due. */
	staleAfterTurns: number;
	/** Minimum gap between two reminders. */
	reminderCooldownTurns: number;
	/** Master switch — false disables every injection. */
	enabled: boolean;
}

interface SessionSync {
	/** Set by session_start/session_compact/session_tree; the next request re-states the full list. */
	resyncPending: boolean;
	/** Set once the stale threshold is crossed; the next request nudges a reconcile. */
	reviewPending: boolean;
	/** Turns since the last successful `todo` call, scoped to one session. */
	turnsSinceTodo: number;
	/** `turnsSinceTodo` at the last reminder, for cooldown accounting. */
	lastReminderTurn: number;
	/** Guards the one forced review a single reminder may request. */
	continueOffered: boolean;
	/**
	 * A successful `todo` call happened during the CURRENT turn. Needed because
	 * `turn_end.toolResults` only carries the turn's own results: a `todo` reached
	 * through another tool (codemode's `ctx.executeTool`) emits
	 * `tool_execution_end` but never appears there, so without this flag a
	 * successful nested call would be counted as a turn with no update.
	 */
	todoInTurn: boolean;
}

/** Cap on rendered task rows so one injection cannot balloon the request. */
const MAX_TASK_LINES = 12;

const sessions = new Map<string, SessionSync>();

function slotFor(sessionId: string): SessionSync {
	let slot = sessions.get(sessionId);
	if (!slot) {
		slot = {
			resyncPending: false,
			reviewPending: false,
			turnsSinceTodo: 0,
			lastReminderTurn: 0,
			continueOffered: false,
			todoInTurn: false,
		};
		sessions.set(sessionId, slot);
	}
	return slot;
}

/** True while the list still holds work the model is expected to advance. */
export function hasOpenTasks(tasks: readonly Task[]): boolean {
	return tasks.some((t) => t.status === "pending" || t.status === "in_progress");
}

/** Status glyph matching the tool's `[status] #id subject` line, minus the id noise. */
function glyphFor(task: Task): string {
	if (task.status === "in_progress") return "[>]";
	if (task.status === "completed") return "[x]";
	return "[ ]";
}

function taskLine(task: Task): string {
	const form = task.status === "in_progress" && task.activeForm ? ` (${task.activeForm})` : "";
	const blocked = task.blockedBy?.length ? ` blocked by ${task.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	return `${glyphFor(task)} #${task.id} ${task.subject}${form}${blocked}`;
}

function foldOverflow(lines: string[], total: number): string[] {
	if (lines.length <= MAX_TASK_LINES) return lines;
	const shown = lines.slice(0, MAX_TASK_LINES - 1);
	return [...shown, `… ${total - shown.length} more`];
}

/**
 * Post-reconstruction statement of the whole list. Injected once after
 * session_start / session_compact / session_tree — the three events that leave
 * the store correct and the model's context stale.
 */
export function renderResyncBlock(tasks: readonly Task[]): string | undefined {
	const live = tasks.filter((t) => t.status !== "deleted");
	if (live.length === 0) return undefined;

	const completed = live.filter((t) => t.status === "completed").length;
	const head = `<todo-resync note="authoritative list after session reconstruction">`;
	const count = `${completed}/${live.length} completed`;
	const open = live.filter((t) => t.status !== "completed");
	const body =
		open.length === 0
			? ["All tasks completed — no status update needed unless new work appears."]
			: foldOverflow(open.map(taskLine), open.length);
	return [head, count, ...body, "Use the todo tool to keep these statuses current.", "</todo-resync>"].join("\n");
}

/**
 * Stale-list nudge. Deliberately shorter than the resync block: only the work
 * still outstanding, because the completed rows are not actionable.
 */
export function renderReviewBlock(tasks: readonly Task[], turns: number): string | undefined {
	const open = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
	if (open.length === 0) return undefined;

	const head = `<todo-review note="statuses not updated for ${turns} turn${turns === 1 ? "" : "s"}">`;
	return [
		head,
		...foldOverflow(open.map(taskLine), open.length),
		"Reconcile these before continuing; do not mark work completed without verification.",
		"</todo-review>",
	].join("\n");
}

/** A reconstruction happened: the next request must re-state the full list. */
export function markResyncPending(sessionId: string): void {
	slotFor(sessionId).resyncPending = true;
}

/** A `todo` call succeeded: the model is in sync, so every counter resets. */
export function noteTodoSuccess(sessionId: string): void {
	const slot = slotFor(sessionId);
	slot.turnsSinceTodo = 0;
	slot.lastReminderTurn = 0;
	slot.reviewPending = false;
	slot.continueOffered = false;
	// Set even when the call came through another tool (codemode), where the
	// turn's own `toolResults` will not mention it.
	slot.todoInTurn = true;
}

/**
 * Start of a turn. Any leftover turn-scoped flag is dropped here so an
 * out-of-order `tool_execution_end` can never make the NEXT turn look updated.
 */
export function beginTurn(sessionId: string): void {
	slotFor(sessionId).todoInTurn = false;
}

/**
 * Close out one turn. `hadTodo` is what `turn_end.toolResults` reported; the
 * turn-scoped flag covers a `todo` reached through another tool, which that
 * array never mentions. A turn with a successful call resets every counter
 * instead of advancing the stale count.
 *
 * Never injects anything itself — a reminder arms a flag that the next real
 * request consumes.
 */
export function noteTurnEnd(sessionId: string, tasks: readonly Task[], settings: SyncSettings, hadTodo: boolean): void {
	const slot = slotFor(sessionId);
	const updatedThisTurn = hadTodo || slot.todoInTurn;
	slot.todoInTurn = false;
	if (updatedThisTurn) {
		slot.turnsSinceTodo = 0;
		slot.lastReminderTurn = 0;
		slot.reviewPending = false;
		slot.continueOffered = false;
		return;
	}

	slot.turnsSinceTodo += 1;
	if (!settings.enabled || !hasOpenTasks(tasks)) {
		slot.reviewPending = false;
		return;
	}
	// `staleAfterTurns: 0` means "never nudge", not "nudge every turn".
	if (settings.staleAfterTurns <= 0) {
		slot.reviewPending = false;
		return;
	}
	if (slot.turnsSinceTodo < settings.staleAfterTurns) return;
	if (slot.turnsSinceTodo - slot.lastReminderTurn < settings.reminderCooldownTurns) return;
	slot.reviewPending = true;
	slot.lastReminderTurn = slot.turnsSinceTodo;
	// A fresh reminder may force its own continuation. Keeping this latched for
	// the session's lifetime would lock the settle guard forever after a single
	// ignored reminder; re-arming per reminder is safe because a reminder itself
	// is rate-limited by the threshold and the cooldown above.
	slot.continueOffered = false;
}

/**
 * Take (and clear) the text this request should carry. Resync wins over a
 * review nudge because it is strictly more informative. Returns undefined when
 * nothing is pending, so a normal request pays zero tokens.
 */
export function consumePendingInjection(
	sessionId: string,
	tasks: readonly Task[],
	settings: SyncSettings,
): string | undefined {
	if (!settings.enabled) return undefined;
	const slot = slotFor(sessionId);
	if (slot.resyncPending) {
		slot.resyncPending = false;
		slot.reviewPending = false;
		return renderResyncBlock(tasks);
	}
	if (slot.reviewPending) {
		slot.reviewPending = false;
		return renderReviewBlock(tasks, slot.turnsSinceTodo);
	}
	return undefined;
}

/**
 * Whether the settle boundary may request one extra request to force a
 * reconcile. At most once per REMINDER: the caller must follow a `true` with
 * `markContinueOffered`, and a later reminder re-opens the guard. Re-arming is
 * bounded by the reminder's own threshold and cooldown, so it cannot loop.
 */
export function shouldForceReview(sessionId: string, tasks: readonly Task[], settings: SyncSettings): boolean {
	if (!settings.enabled) return false;
	const slot = slotFor(sessionId);
	if (slot.continueOffered) return false;
	if (!slot.reviewPending) return false;
	return hasOpenTasks(tasks);
}

/** Record that the settle boundary already asked for its one forced review. */
export function markContinueOffered(sessionId: string): void {
	slotFor(sessionId).continueOffered = true;
}

/** Per-session teardown, mirroring the store's `evictSession`. */
export function evictSyncSession(sessionId: string): void {
	sessions.delete(sessionId);
}

/** Test-setup reset; wired wherever `__resetState()` runs. */
export function __resetSyncState(): void {
	sessions.clear();
}
