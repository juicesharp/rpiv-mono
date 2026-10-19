/**
 * context — branch-message massaging for the advisor side-call. Strips the
 * executor's in-flight advisor() toolCall from the tail (orphan toolCalls are
 * rejected by providers) and guarantees a user-role tail (some providers reject
 * an assistant-prefill tail), and drops the executor's callable tool
 * declarations from copied system messages.
 */

import type { Message } from "@earendil-works/pi-ai";
import { ADVISOR_TOOL_NAME, MSG_ADVISOR_NUDGE } from "./messages.ts";

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

// Always close the branch with a user-role nudge addressed to the advisor.
// Some providers (recent Anthropic Claude models) reject payloads ending on an
// assistant turn ("This model does not support assistant message prefill. The
// conversation must end with a user message."). And when the executor called
// advisor() with no text, stripInflightAdvisorCall drops that whole turn, so the
// tail is the previous toolResult/user message: without the nudge the advisor
// model reads the executor's transcript as its own and continues it as the
// executor (empty reply, or narration like "Calling the advisor:").
export function ensureUserTailForAdvisor(messages: Message[]): Message[] {
	if (messages.length === 0) return messages;
	const nudge: Message = {
		role: "user",
		content: [{ type: "text", text: MSG_ADVISOR_NUDGE }],
		timestamp: Date.now(),
	};
	return [...messages, nudge];
}

// Pi >= 1.0 records the executor's system prompt and tool loadout in the
// transcript as `system` messages, and every provider resolves the request's
// tools from those `toolsAdded`/`toolsRemoved` deltas — so `tools: []` alone
// leaves the executor's tools callable and the advisor can stop on `toolUse`
// with no text (#295). Drop the deltas, keep the prompt text; the inventory
// message already tells the advisor what the executor's tools are.
export function stripToolDeclarations(messages: Message[]): Message[] {
	if (!messages.some((m) => m.role === "system" && (m.toolsAdded || m.toolsRemoved))) return messages;
	return messages.map((m) => {
		if (m.role !== "system" || (!m.toolsAdded && !m.toolsRemoved)) return m;
		const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = m;
		return rest;
	});
}
