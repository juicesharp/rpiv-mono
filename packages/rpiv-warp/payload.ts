/**
 * rpiv-warp — Warp structured-payload composition.
 *
 * Pure data transforms: branch -> text extraction -> envelope -> JSON.
 * No I/O. One small named function per concern; build* composers assemble
 * them at the call sites consumed by `index.ts`.
 */

import { basename } from "node:path";
import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { negotiateProtocolVersion, type WarpEvent } from "./protocol.js";

// ---------------------------------------------------------------------------
// Constants — single definition site for tunables
// ---------------------------------------------------------------------------

/**
 * Warp's `CLIAgent` enum recognizes 12 IDs (warpdotdev/warp:
 * `app/src/terminal/cli_agent.rs`), and `"pi"` is one of them — semantically
 * correct identity for this extension. However, the session listener at
 * `app/src/terminal/cli_agent_sessions/listener/mod.rs:48-57` currently routes
 * only `Claude | OpenCode | Gemini | Auggie | Codex` to a notification handler
 * and drops every other variant (including `Pi` and `Unknown`). So `"pi"`
 * parses correctly but produces no toast in current Warp builds.
 *
 * Workaround options, all bad:
 *   - `agent: "claude"` → toasts render, but tab gets the Claude Code icon &
 *     "Claude" label via `SessionType::CliAgent(CLIAgent::Claude)`. Identity-
 *     misrepresenting; user-visibly wrong.
 *   - any non-allowlisted ID → no toast.
 *
 * Real fix is upstream: PR `warpdotdev/warp` moving `CLIAgent::Pi` into the
 * `DefaultSessionListener` arm + adding `icon()` / `brand_color()` cases
 * (template: `specs/APP-4067/TECH.md` did this for Gemini). Until that ships,
 * we keep the correct identity and accept that Warp won't render the toast.
 */
export const AGENT_ID = "pi";
export const TRUNCATE_LIMIT = 200;

// ---------------------------------------------------------------------------
// Types — base envelope + per-event extras
// ---------------------------------------------------------------------------

export interface WarpPayloadBase {
	readonly v: number;
	readonly agent: string;
	readonly event: WarpEvent;
	readonly session_id: string;
	readonly cwd: string;
	readonly project: string;
}

export interface StopExtras {
	readonly query: string;
	readonly response: string;
}
export interface IdlePromptExtras {
	readonly summary: string;
}
export interface ToolCompleteExtras {
	readonly tool_name: string;
}

export type WarpPayload = WarpPayloadBase & Partial<StopExtras & IdlePromptExtras & ToolCompleteExtras>;

// ---------------------------------------------------------------------------
// Text helpers — small, single-purpose, composable
// ---------------------------------------------------------------------------

export function truncate(s: string, max: number = TRUNCATE_LIMIT): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 3)}...`;
}

export function projectName(cwd: string): string {
	return basename(cwd);
}

/**
 * Extract plain text from a UserMessage.content (string | array) OR an
 * AssistantMessage.content (always array). Filters to TextContent entries.
 */
export function extractMessageText(content: UserMessage["content"] | AssistantMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Branch traversal — reverse-scan filtered branch for last user/assistant text
// ---------------------------------------------------------------------------

function isMessageEntry(entry: SessionEntry): entry is SessionEntry & { type: "message" } {
	return entry.type === "message";
}

function findLastMessageText(branch: SessionEntry[], role: "user" | "assistant"): string {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!isMessageEntry(entry)) continue;
		const message = entry.message;
		if (message.role !== role) continue;
		const text = extractMessageText((message as UserMessage | AssistantMessage).content);
		if (text.length > 0) return truncate(text);
	}
	return "";
}

export function lastUserText(branch: SessionEntry[]): string {
	return findLastMessageText(branch, "user");
}

export function lastAssistantText(branch: SessionEntry[]): string {
	return findLastMessageText(branch, "assistant");
}

// ---------------------------------------------------------------------------
// Envelope — common fields for every Warp event
// ---------------------------------------------------------------------------

export function baseEnvelope(event: WarpEvent, ctx: ExtensionContext): WarpPayloadBase {
	const cwd = ctx.cwd;
	return {
		v: negotiateProtocolVersion(),
		agent: AGENT_ID,
		event,
		session_id: ctx.sessionManager.getSessionId(),
		cwd,
		project: projectName(cwd),
	};
}

// ---------------------------------------------------------------------------
// Builders — one per Warp event; composition is linear and named
// ---------------------------------------------------------------------------

export function buildSessionStartPayload(ctx: ExtensionContext): WarpPayload {
	return baseEnvelope("session_start", ctx);
}

export function buildPromptSubmitPayload(ctx: ExtensionContext): WarpPayload {
	return baseEnvelope("prompt_submit", ctx);
}

export function buildStopPayload(ctx: ExtensionContext, branch: SessionEntry[]): WarpPayload {
	return {
		...baseEnvelope("stop", ctx),
		query: lastUserText(branch),
		response: lastAssistantText(branch),
	};
}

export function buildIdlePromptPayload(ctx: ExtensionContext, summary: string): WarpPayload {
	return {
		...baseEnvelope("idle_prompt", ctx),
		summary,
	};
}

export function buildToolCompletePayload(ctx: ExtensionContext, toolName: string): WarpPayload {
	return {
		...baseEnvelope("tool_complete", ctx),
		tool_name: toolName,
	};
}

// ---------------------------------------------------------------------------
// Serializer — single source of truth so tests can assert on JSON shape
// ---------------------------------------------------------------------------

export function serializePayload(payload: WarpPayload): string {
	return JSON.stringify(payload);
}
