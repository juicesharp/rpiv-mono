/**
 * context — branch-message massaging for the advisor side-call. Strips the
 * executor's in-flight advisor() toolCall from the tail (orphan toolCalls are
 * rejected by providers) and guarantees a user-role tail (some providers reject
 * an assistant-prefill tail).
 */

import type { Message } from "@earendil-works/pi-ai";
import { ADVISOR_TOOL_NAME, MSG_ADVISOR_NUDGE } from "./messages.js";

const CONTEXT_PRUNE_SUMMARY_TYPE = "context-prune-summary";

/**
 * Read pi-context-prune's persisted summary metadata without depending on that
 * optional extension. Missing or legacy metadata is intentionally a no-op.
 */
export function getPruneCoveredToolCallIds(entries: readonly unknown[]): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: unknown; customType?: unknown; details?: unknown };
		if (
			(candidate.type !== "custom_message" && candidate.type !== "custom") ||
			candidate.customType !== CONTEXT_PRUNE_SUMMARY_TYPE
		) {
			continue;
		}
		if (!candidate.details || typeof candidate.details !== "object") continue;
		const details = candidate.details as { toolCallRefs?: unknown; toolCallIds?: unknown };
		if (Array.isArray(details.toolCallRefs)) {
			for (const ref of details.toolCallRefs) {
				if (!ref || typeof ref !== "object") continue;
				const toolCallId = (ref as { toolCallId?: unknown }).toolCallId;
				if (typeof toolCallId === "string" && toolCallId.length > 0) ids.add(toolCallId);
			}
		}
		if (Array.isArray(details.toolCallIds)) {
			for (const toolCallId of details.toolCallIds) {
				if (typeof toolCallId === "string" && toolCallId.length > 0) ids.add(toolCallId);
			}
		}
	}
	return ids;
}

// Strip the executor's in-flight advisor() toolCall from the tail assistant
// message. That call is what invoked *us* — there is no matching toolResult
// yet, and providers (Anthropic, GLM/zai, OpenAI) reject payloads with orphan
// toolCalls. Name-targeted to leave any other trailing toolCalls visible.
export function stripInflightAdvisorCall(messages: Message[]): Message[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant") return messages;
	const filtered = last.content.filter((c) => !(c.type === "toolCall" && c.name === ADVISOR_TOOL_NAME));
	if (filtered.length === last.content.length) return messages;
	if (filtered.length === 0) return messages.slice(0, -1);
	return [...messages.slice(0, -1), { ...last, content: filtered }];
}

// Some providers (recent Anthropic Claude models) reject payloads ending on an
// assistant turn ("This model does not support assistant message prefill. The
// conversation must end with a user message."). After stripInflightAdvisorCall
// the tail can be assistant (e.g. the executor wrote thinking text before
// calling advisor). Append a minimal user-role nudge to guarantee user-tail.
export function ensureUserTailForAdvisor(messages: Message[]): Message[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant") return messages;
	const nudge: Message = {
		role: "user",
		content: [{ type: "text", text: MSG_ADVISOR_NUDGE }],
		timestamp: Date.now(),
	};
	return [...messages, nudge];
}
