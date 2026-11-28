import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatStatusLabel, t } from "../state/i18n-bridge.ts";
import { selectTaskSubjectById, selectTasksByStatus } from "../state/selectors.ts";
import type { TaskState } from "../state/state.ts";
import { sanitizeTerminalText } from "../tool/sanitize.ts";
import type { Task, TaskAction, TaskDetails, TaskMutationParams, TaskStatus } from "../tool/types.ts";

// Re-export so legacy import paths (todo.ts, tests) continue to resolve;
// the canonical definition lives in the i18n bridge.
export { formatStatusLabel };

// ---------------------------------------------------------------------------
// Status presentation tables — the single source of truth for glyph/color.
// ---------------------------------------------------------------------------

export const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	deleted: "⊘",
};

/**
 * Color palette for the renderResult status echo. `deleted` uses `muted` so a
 * successful delete is visually distinct from the error branch (which uses
 * `error` + `✗`).
 */
export const STATUS_COLOR: Record<TaskStatus, "dim" | "warning" | "success" | "muted"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
	deleted: "muted",
};

/**
 * Per-action prefix glyph for renderCall. `+` create, `→` update, `×` delete,
 * `›` get, `☰` list, `∅` clear.
 */
export const ACTION_GLYPH: Record<TaskAction, string> = {
	create: "+",
	update: "→",
	delete: "×",
	get: "›",
	list: "☰",
	clear: "∅",
};

/**
 * Glyph for the persistent overlay's per-task row. Differs from `STATUS_GLYPH`
 * for `completed` (`✓` vs `●`) and `deleted` (`✗` vs `⊘`) because the
 * overlay caller never renders a `deleted` row but uses `✗` in its
 * error-toned palette.
 */
export function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "in_progress":
			return theme.fg("warning", "◐");
		case "completed":
			return theme.fg("success", "✓");
		case "deleted":
			return theme.fg("error", "✗");
	}
}

/**
 * Format a single task row for the persistent overlay. The subject color
 * reflects task state while IDs and supporting metadata stay visually quiet.
 */
export function formatOverlayTaskLine(t: Task, theme: Theme, showId: boolean): string {
	const glyph = overlayStatusGlyph(t.status, theme);
	const subjectColor =
		t.status === "in_progress" ? "accent" : t.status === "completed" || t.status === "deleted" ? "muted" : "text";
	let subject = theme.fg(subjectColor, sanitizeTerminalText(t.subject));
	if (t.status === "completed" || t.status === "deleted") {
		subject = theme.strikethrough(subject);
	}
	let line = `${glyph}`;
	if (showId) line += ` ${theme.fg("dim", `#${t.id}`)}`;
	line += ` ${subject}`;
	if (t.status === "in_progress" && t.activeForm) {
		line += ` ${theme.fg("muted", `(${sanitizeTerminalText(t.activeForm)})`)}`;
	}
	if (t.blockedBy && t.blockedBy.length > 0) {
		line += ` ${theme.fg("muted", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	}
	return line;
}

/**
 * Format a single task line for the `/todos` slash command (no glyph color,
 * indented bullet prefix).
 */
export function formatCommandTaskLine(t: Task, glyph: string): string {
	const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
	const block = t.blockedBy?.length ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	return `  ${glyph} #${t.id} ${sanitizeTerminalText(t.subject)}${form}${block}`;
}

/**
 * Default wrap width for description blocks in the `/todos open` output.
 *
 * A description is free text written for the model, not for a terminal, so it
 * routinely runs past one line. Wrapping here rather than at the notify call
 * site keeps the case deterministic: the tests can assert exact lines instead
 * of matching a regex against whatever width the host happens to report.
 */
export const DESCRIPTION_WRAP_WIDTH = 76;

/**
 * Wrap one description into indented, prefix-aligned lines.
 *
 * Every produced line starts with `indent` so the block reads as part of the
 * task it belongs to. Words longer than the available width are left intact
 * (a path or a hash must not be split); the line just overflows, which is
 * better than a broken identifier.
 */
export function wrapDescription(description: string, indent: string, width = DESCRIPTION_WRAP_WIDTH): string[] {
	const text = sanitizeTerminalText(description).replace(/\s+/g, " ").trim();
	if (text.length === 0) return [];
	const available = Math.max(20, width - indent.length);
	const lines: string[] = [];
	let current = "";
	for (const word of text.split(" ")) {
		if (current.length === 0) {
			current = word;
			continue;
		}
		if (current.length + 1 + word.length <= available) {
			current = `${current} ${word}`;
			continue;
		}
		lines.push(`${indent}${current}`);
		current = word;
	}
	if (current.length > 0) lines.push(`${indent}${current}`);
	return lines;
}

/**
 * One task entry for `/todos open`: the usual command line, then its
 * description wrapped underneath. A task without a description yields exactly
 * one line, so the shape never depends on which tasks happen to carry one.
 */
export function formatOpenTaskLines(t: Task, glyph: string): string[] {
	const lines = [formatCommandTaskLine(t, glyph)];
	for (const line of wrapDescription(t.description ?? "", "      ")) lines.push(line);
	return lines;
}

/**
 * Build the `/todos open` notification body: every task that is not completed,
 * in work order (in progress first, then pending), each followed by its wrapped
 * description and its blocking ids.
 *
 * Completed tasks are omitted entirely rather than folded into a count: this
 * view exists to answer "what is left", and a count of what is finished does
 * not help that question.
 */
export function formatOpenView(state: TaskState, visible: readonly Task[]): string {
	const groups = selectTasksByStatus(state);
	const open = [...groups.inProgress, ...groups.pending];
	if (open.length === 0) {
		// Every visible task is completed: say so rather than emitting an empty body.
		return t("command.open.all_done", "Nothing outstanding — every task is completed.");
	}
	// `visible` is the caller's already-filtered set; the grouped selectors read
	// the same state, so the only thing worth guarding is a task that the group
	// selectors drop but the filter kept. Keeping the count honest matters more
	// than keeping the list long.
	const known = new Set(open.map((task) => task.id));
	for (const task of visible) {
		if (!known.has(task.id) && task.status !== "completed" && task.status !== "deleted") open.push(task);
	}
	const lines: string[] = [t("command.open.header", "Outstanding tasks")];
	for (const task of open) {
		const glyph = task.status === "in_progress" ? "◐" : "○";
		lines.push(...formatOpenTaskLines(task, glyph));
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool render hooks — wrapped so `todo.ts` becomes a thin call-site.
// ---------------------------------------------------------------------------

/**
 * `renderCall` body. Receives the call's args, the theme, and the live
 * `TaskState` (resolved by the caller via `getRenderState()`). The args may
 * still be streaming or may fail validation, so `action` can be absent.
 */
export function renderTodoCall(
	args: TaskMutationParams & { action?: TaskAction },
	theme: Theme,
	state: TaskState,
): Text {
	let text = theme.fg("toolTitle", theme.bold("todo "));
	if (args.action) text += theme.fg("muted", ACTION_GLYPH[args.action] ?? args.action);

	if (args.action === "create" && args.subject) {
		text += ` ${theme.fg("dim", sanitizeTerminalText(args.subject))}`;
	} else if (args.action === "create" && Array.isArray(args.tasks)) {
		text += ` ${theme.fg("dim", `${args.tasks.length} tasks`)}`;
	} else if (
		(args.action === "update" || args.action === "get" || args.action === "delete") &&
		args.id !== undefined
	) {
		const subject = selectTaskSubjectById(state, args.id);
		text += ` ${theme.fg("accent", subject ? sanitizeTerminalText(subject) : `#${args.id}`)}`;
	} else if (args.action === "list" && args.status) {
		text += ` ${theme.fg("muted", formatStatusLabel(args.status))}`;
	}
	return new Text(text, 0, 0);
}

/**
 * `renderResult` body. A failed call renders `✗` with its reason; a successful
 * `create`/`update`/`delete` echoes the task's status; anything else is `✓`.
 */
export function renderTodoResult(result: ToolResultView, theme: Theme, isError = false): Text {
	const failure = failureReason(result, isError);
	if (failure !== undefined) return new Text(theme.fg("error", failure ? `✗ ${failure}` : "✗"), 0, 0);

	const status = echoedStatus(result.details as TaskDetails | undefined);
	if (status) {
		return new Text(theme.fg(STATUS_COLOR[status], `${STATUS_GLYPH[status]} ${formatStatusLabel(status)}`), 0, 0);
	}
	return new Text(theme.fg("success", "✓"), 0, 0);
}

type ToolResultView = { content?: Array<{ type: string; text?: string }>; details?: unknown };

/**
 * First line of the failure message, or `undefined` when the call succeeded.
 * The reducer reports through `details.error`; Pi rejects a call before execute
 * with `isError` and the message as text content.
 */
function failureReason(result: ToolResultView, isError: boolean): string | undefined {
	const reducerError = (result.details as TaskDetails | undefined)?.error;
	if (!isError && !reducerError) return undefined;
	const message = reducerError ?? result.content?.find((c) => c.type === "text")?.text ?? "";
	return sanitizeTerminalText(message.split("\n")[0]);
}

/** Status the result card echoes: the task the call created, updated or deleted. */
function echoedStatus(details: TaskDetails | undefined): TaskStatus | undefined {
	if (!details) return undefined;
	const params = details.params as TaskMutationParams;
	switch (details.action) {
		case "create":
			return details.tasks.at(-1)?.status;
		case "update":
			return params.status ?? details.tasks.find((t) => t.id === params.id)?.status;
		case "delete":
			return details.tasks.find((t) => t.id === params.id)?.status;
		case "list":
		case "get":
		case "clear":
			return undefined;
	}
}
