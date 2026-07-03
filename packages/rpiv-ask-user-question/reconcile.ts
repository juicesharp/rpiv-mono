/**
 * reconcile — mid-session lifecycle reconciliation for ask_user_question.
 *
 * Strips or re-adds the tool to the active set so it is invisible to the LLM
 * in non-interactive runs (no UI, or an RPC host that cannot render the
 * questionnaire) and present in interactive ones. Mirrors the advisor's
 * reconcileAdvisorTool / registerAdvisorBeforeAgentStart pattern
 * (packages/rpiv-advisor/advisor/handlers.ts), simplified: ask_user_question's
 * gating signals are ctx.hasUI + ctx.mode (no model or executor blocklist), so
 * it reads the flags directly and omits the notify.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASK_USER_QUESTION_TOOL_NAME } from "./ask-user-question.js";

/**
 * True when the questionnaire can actually render. Two disqualifiers:
 * - `!hasUI` — print/headless runs (`pi -p`).
 * - `mode === "rpc"` — ACP hosts (Zed, Paseo). RPC mode reports `hasUI: true`
 *   because the dialog sub-protocol (select/confirm/input) works, but
 *   `ui.custom()` — the only primitive this tool renders with — resolves
 *   `undefined` without ever showing anything. `mode` is read structurally:
 *   the pinned peer types (pi 0.74) predate the field, so on older hosts it is
 *   `undefined` and the in-handler undefined-result backstop covers RPC instead.
 */
function isInteractive(ctx: ExtensionContext): boolean {
	return ctx.hasUI && (ctx as ExtensionContext & { mode?: string }).mode !== "rpc";
}

/**
 * Strip-or-restore `ask_user_question` to match `isInteractive(ctx)`. Reads
 * the active tool list itself. Idempotent: when the tool is already in the
 * right state it leaves the active set (and sibling tools) untouched.
 */
export function reconcileAskUserQuestionTool(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const active = pi.getActiveTools();
	const hasTool = active.includes(ASK_USER_QUESTION_TOOL_NAME);
	// Non-interactive → strip so the tool never reaches the LLM's tool list;
	// interactive → restore. The in-handler guards in ask-user-question.ts
	// (!hasUI, and `custom()` resolving undefined) remain as one-turn backstops
	// if a future Pi change reorders the tool-list snapshot ahead of
	// before_agent_start, or the host is an RPC build that predates ctx.mode.
	if (!isInteractive(ctx) && hasTool) {
		pi.setActiveTools(active.filter((n) => n !== ASK_USER_QUESTION_TOOL_NAME));
	} else if (isInteractive(ctx) && !hasTool) {
		pi.setActiveTools([...active, ASK_USER_QUESTION_TOOL_NAME]);
	}
}

/**
 * Attach the reconciler to `before_agent_start` so the active set is fixed up
 * before each turn's tool-list snapshot is read. Safe to call once at load.
 */
export function registerAskUserQuestionReconciler(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (_event, ctx) => reconcileAskUserQuestionTool(pi, ctx));
}
