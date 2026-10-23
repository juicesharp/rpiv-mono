import type { TaskDetails } from "../tool/types.ts";
import { EMPTY_STATE, type TaskState } from "./state.ts";

/**
 * Discriminator for `details` envelopes that match the persisted `TaskDetails`
 * shape. Defensive — branch entries from older or corrupt sessions are
 * skipped silently.
 */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && typeof v.nextId === "number";
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
