import type { Task, TaskDetails, TaskStatus } from "../tool/types.ts";
import { EMPTY_STATE, type TaskState } from "./state.ts";

const TASK_STATUSES: ReadonlySet<unknown> = new Set<TaskStatus>(["pending", "in_progress", "completed", "deleted"]);

const optional = (value: unknown, valid: (v: unknown) => boolean): boolean => value === undefined || valid(value);
const isString = (v: unknown): boolean => typeof v === "string";

function isTask(value: unknown): value is Task {
	if (!value || typeof value !== "object") return false;
	const t = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(t.id) &&
		typeof t.subject === "string" &&
		TASK_STATUSES.has(t.status) &&
		optional(t.description, isString) &&
		optional(t.activeForm, isString) &&
		optional(t.owner, isString) &&
		optional(t.blockedBy, (v) => Array.isArray(v) && v.every((id) => Number.isSafeInteger(id))) &&
		optional(t.metadata, (v) => typeof v === "object" && v !== null)
	);
}

/**
 * Discriminator for `details` envelopes that match the persisted `TaskDetails`
 * shape, down to every task. Defensive — a snapshot from an older or corrupt
 * session (e.g. a `tasks[]` another extension truncated with a marker string)
 * is skipped whole, so replay keeps the last valid one.
 */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && v.tasks.every(isTask) && Number.isSafeInteger(v.nextId);
}

/** Fresh `TaskState` from a persisted snapshot — copies each task so replay never aliases branch data. */
function stateOf(details: TaskDetails): TaskState {
	return { tasks: details.tasks.map((t) => ({ ...t })), nextId: details.nextId };
}

/**
 * Walk the current branch in chronological order and return the last persisted
 * snapshot (last-write-wins). Two sources carry the same `TaskDetails` shape:
 *
 * - `custom` entries of type `"rpiv-todo-state"` (mirrors `STATE_ENTRY_TYPE` in
 *   `tool/types.ts` — a literal here, like `"todo"`, so `state/` keeps no value
 *   import of the Pi-aware tool layer). Written by `todo.ts` for EVERY
 *   state-changing call, including calls made through another tool
 *   (`ctx.executeTool`, e.g. codemode) that never land as a `toolResult`.
 * - `toolResult` messages with `toolName === "todo"` — the `details` envelope.
 *
 * Once the branch carries any state entry, state entries are authoritative:
 * they are appended at commit time for every change, so a `toolResult`
 * snapshot can only repeat or predate them. Branches with no state entry
 * (sessions written before entries existed) replay from `toolResult` snapshots.
 * When neither exists, returns `EMPTY_STATE`.
 *
 * Pure of module state — `index.ts` writes the returned snapshot into the
 * store after this returns. The function explicitly does NOT touch the store
 * cell.
 */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let fromEntries: TaskState | undefined;
	let fromToolResults: TaskState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as {
			type?: string;
			customType?: string;
			data?: unknown;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		if (e.type === "custom") {
			if (e.customType === "rpiv-todo-state" && isTaskDetails(e.data)) fromEntries = stateOf(e.data);
			continue;
		}
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		if (!isTaskDetails(msg.details)) continue;
		fromToolResults = stateOf(msg.details);
	}
	return fromEntries ?? fromToolResults ?? { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

/**
 * Whether the model can still SEE the current list in its own context.
 *
 * Two things are distinguished here on purpose, because conflating them was a
 * real over-injection bug (a plain `pi -c` resumed a complete transcript and
 * still got a redundant list appended on every start):
 *
 * - `custom` entries (`rpiv-todo-state`) are never projected into the model's
 *   messages — they only feed replay — so they never count as visible.
 * - A `todo` `toolResult` IS visible, but a compaction replaces the messages
 *   before its boundary with a summary, so such a result stops being visible
 *   the moment a later compaction entry exists. The boundary can appear either
 *   as a raw `compaction` entry or, on a reopened session, as a projected
 *   `compactionSummary` message — both must be recognised, or a resumed
 *   compacted session looks like a complete one.
 *
 * A session restored with a complete transcript therefore needs nothing; one
 * restored from behind a compaction boundary (or one whose list was only ever
 * written by a nested call such as codemode, which leaves no `toolResult`) does.
 */
export function isTodoStateVisibleToModel(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): boolean {
	const entries = [...ctx.sessionManager.getBranch()].map(
		(entry) =>
			entry as {
				id?: string;
				type?: string;
				customType?: string;
				firstKeptEntryId?: string;
				message?: { role?: string; toolName?: string };
			},
	);

	// The newest compaction boundary plus the first entry it kept. `getBranch()`
	// may already be compaction-aware (older entries omitted) or the raw path, so
	// both readings are handled: the kept range starts at `firstKeptEntryId` when
	// that entry is present, otherwise right after the boundary.
	let boundaryIndex = -1;
	let firstKeptId: string | undefined;
	entries.forEach((e, i) => {
		const isBoundary = e.type === "compaction" || e.message?.role === "compactionSummary";
		if (!isBoundary) return;
		boundaryIndex = i;
		firstKeptId = e.firstKeptEntryId;
	});

	let visibleFrom = 0;
	if (boundaryIndex >= 0) {
		const keptIndex = firstKeptId ? entries.findIndex((e) => e.id === firstKeptId) : -1;
		// A compaction keeps entries that precede it on the branch; a missing id
		// means the list is already projected, leaving only what follows.
		visibleFrom = keptIndex >= 0 ? keptIndex : boundaryIndex + 1;
	}

	// The newest state source decides. A `todo` toolResult IS visible, but a
	// nested call (codemode's `ctx.executeTool`) only appends the `custom`
	// snapshot — it leaves no toolResult behind. When that snapshot is newer than
	// the last visible result, the model is looking at an older list, so the
	// presence of some earlier result must not be read as "in sync".
	let lastStateSource = -1;
	let lastToolResult = -1;
	entries.forEach((e, i) => {
		if (e.type === "custom" && e.customType === "rpiv-todo-state") lastStateSource = i;
		else if (e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "todo") {
			lastToolResult = i;
		}
	});

	// The newest source is the custom snapshot: nothing in the model's context
	// carries it, so the list must be re-stated regardless of older results.
	if (lastStateSource > lastToolResult) return false;

	return lastToolResult >= 0 && lastToolResult >= visibleFrom;
}
