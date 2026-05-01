/**
 * rpiv-warp — Pi extension entry.
 *
 * Subscribes to four Pi lifecycle events and emits Warp's structured
 * OSC 777 escape sequence to /dev/tty. Outside Warp (or on a broken
 * Warp build) no handlers are registered — the extension is a complete
 * no-op rather than a noisy-but-skipping one.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import {
	buildIdlePromptPayload,
	buildPromptSubmitPayload,
	buildSessionStartPayload,
	buildStopPayload,
	buildToolCompletePayload,
	serializePayload,
	type WarpPayload,
} from "./payload.js";
import { detectWarpEnvironment } from "./protocol.js";
import { writeOSC777 } from "./warp-notify.js";

// ---------------------------------------------------------------------------
// Constants — single edit site for v1 tunables
// ---------------------------------------------------------------------------

/** Title field for every structured emission — Warp's CLI-agent URI. */
const TITLE = "warp://cli-agent";

/** Static body string for `idle_prompt` events — bash plugin parity. */
const IDLE_SUMMARY = "Input needed";

/**
 * Pi's `idle_prompt` registry. Matches Claude Code's `Notification(idle_prompt)`
 * concept — the agent is blocked awaiting user input. v1 entry is the only Pi
 * tool that semantically blocks for input today; permission-gate tools (Phase 2)
 * land here too.
 */
const NOTIFY_TOOL_NAMES = new Set<string>(["ask_user_question"]);

// ---------------------------------------------------------------------------
// Composition primitives — each is one verb-phrase
// ---------------------------------------------------------------------------

function emit(payload: WarpPayload): void {
	writeOSC777(TITLE, serializePayload(payload));
}

function readBranch(ctx: ExtensionContext): SessionEntry[] {
	return ctx.sessionManager.getBranch() as SessionEntry[];
}

function lastToolName(toolResults: ReadonlyArray<{ toolName: string }>): string {
	return toolResults.at(-1)?.toolName ?? "";
}

// ---------------------------------------------------------------------------
// Default export — registers four handlers iff inside a working Warp
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	const warp = detectWarpEnvironment();
	if (!warp.isWarp || !warp.supportsStructured) return;

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		emit(buildSessionStartPayload(ctx));
	});

	pi.on("agent_start", async (_event, ctx) => {
		emit(buildPromptSubmitPayload(ctx));
	});

	pi.on("agent_end", async (_event, ctx) => {
		emit(buildStopPayload(ctx, readBranch(ctx)));
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!NOTIFY_TOOL_NAMES.has(event.toolName)) return;
		emit(buildIdlePromptPayload(ctx, IDLE_SUMMARY));
	});

	pi.on("turn_end", async (event, ctx) => {
		emit(buildToolCompletePayload(ctx, lastToolName(event.toolResults)));
	});
}
