import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { getBlockingTools } from "./config.js";
import {
	buildPromptSubmitPayload,
	buildQuestionAskedPayload,
	buildSessionStartPayload,
	buildStopPayload,
	buildToolCompletePayload,
	serializePayload,
	type WarpPayload,
} from "./payload.js";
import { detectWarpEnvironment } from "./protocol.js";
import { startSpinner, stopSpinner } from "./title-spinner.js";
import { writeOSC777 } from "./warp-notify.js";

const TITLE = "warp://cli-agent";

function emit(payload: WarpPayload): void {
	writeOSC777(TITLE, serializePayload(payload));
}

function readBranch(ctx: ExtensionContext): SessionEntry[] {
	return ctx.sessionManager.getBranch() as SessionEntry[];
}

// Mirror Pi's startup tab title `<mascot> - <repo>`. We only own the first
// character (the spinner glyph during animation); push/pop restores Pi's
// mascot verbatim on stop.
function titleSuffix(ctx: ExtensionContext): string {
	return ` - ${basename(ctx.cwd)}`;
}

export default function (pi: ExtensionAPI): void {
	const warp = detectWarpEnvironment();
	if (!warp.isWarp || !warp.supportsStructured) return;

	const blockingTools = getBlockingTools();

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		emit(buildSessionStartPayload(ctx));
	});

	pi.on("agent_start", async (_event, ctx) => {
		emit(buildPromptSubmitPayload(ctx));
		startSpinner(titleSuffix(ctx));
	});

	pi.on("agent_end", async (_event, ctx) => {
		emit(buildStopPayload(ctx, readBranch(ctx)));
		stopSpinner();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!blockingTools.has(event.toolName)) return;
		emit(buildQuestionAskedPayload(ctx));
		stopSpinner();
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!blockingTools.has(event.toolName)) return;
		emit(buildToolCompletePayload(ctx, event.toolName));
		startSpinner(titleSuffix(ctx));
	});
}
