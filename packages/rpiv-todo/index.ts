/**
 * rpiv-todo — Pi extension
 *
 * Registers the `todo` tool, `/todos` slash command, and the five lifecycle
 * hooks that manage branch-replay state reconstruction and the TodoOverlay
 * persistent widget.
 *
 * Extracted from rpiv-pi@7525a5d. Tool name "todo" and widget key
 * "rpiv-todos" preserved verbatim so existing session history replays
 * correctly after upgrade.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { replayFromBranch } from "./state/replay.js";
import { replaceState } from "./state/store.js";
import { registerTodosCommand, registerTodoTool, TOOL_NAME } from "./todo.js";
import { TodoOverlay } from "./todo-overlay.js";

export default function (pi: ExtensionAPI) {
	// Todo overlay widget — constructed lazily at the first session_start with UI.
	let todoOverlay: TodoOverlay | undefined;

	registerTodoTool(pi);
	registerTodosCommand(pi);

	pi.on("session_start", async (_event, ctx) => {
		replaceState(replayFromBranch(ctx));
		if (ctx.hasUI) {
			todoOverlay ??= new TodoOverlay();
			todoOverlay.setUICtx(ctx.ui);
			todoOverlay.update();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		replaceState(replayFromBranch(ctx));
		todoOverlay?.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		replaceState(replayFromBranch(ctx));
		todoOverlay?.update();
	});

	pi.on("session_shutdown", async () => {
		todoOverlay?.dispose();
		todoOverlay = undefined;
	});

	// Reads getTodos() at render time; do NOT call replayFromBranch here
	// (branch is stale — message_end runs after tool_execution_end).
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		todoOverlay?.update();
	});
}
