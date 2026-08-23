/**
 * Cycle-break leaf module.
 *
 * Owns the `BtwTurn` interface and the `userMessageText` / `assistantMessageText`
 * message-text extractors, moved here from `btw.ts` to sever the sole runtime
 * VALUE back-edge `btw-ui.ts → btw.ts` (the cluster-2 cycle-break, L1-06).
 *
 * This module imports ONLY `type { AssistantMessage, UserMessage }` from
 * `@earendil-works/pi-ai` — it has NO `./btw.js` import, so the leaf introduces
 * no back-edge into `btw.ts`. `btw.ts` re-exports all three symbols so the
 * package surface (and the `*.test.ts` imports from `./btw.js`) is unchanged.
 *
 * The phantom type-only cycle `btw.ts ↔ btw-budget.ts` (`btw-budget.ts:22`
 * `import type { BtwTurn } from "./btw.js"`) is intentionally left in place —
 * it is runtime-inert (erased) and repointing it is owned by no phase in this
 * plan (see plan risk r6).
 */

import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";

// Real messages — no fabrication. userMessage is built at call time; assistantMessage
// is the unmodified completeSimple response. Stable object references across calls →
// byte-identical prompt prefix on subsequent /btw invocations (cache parity).
export interface BtwTurn {
	userMessage: UserMessage;
	assistantMessage: AssistantMessage;
}

// Extract text from a UserMessage's content.
export function userMessageText(msg: UserMessage): string {
	if (typeof msg.content === "string") return msg.content;
	return msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

// Extract text from an AssistantMessage's content (text parts only).
export function assistantMessageText(msg: AssistantMessage): string {
	return msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

// /btw always calls completeSimple with tools: [] — the model has no tools to
// call in a side question. Drop toolResult messages and toolCall content parts
// from the cloned branch before sending it, so a branch that has real tool use
// in it (any normal coding session) never puts a toolUse/toolResult block on
// the wire without a matching toolConfig. Bedrock's Converse API rejects that
// combination outright ("The toolConfig field must be defined when using
// toolUse and toolResult content blocks"), and an orphaned toolCall with no
// toolResult is invalid on most other providers too.
export function stripToolTraffic(messages: Message[]): Message[] {
	return messages.flatMap((m): Message[] => {
		if (m.role === "toolResult") return [];
		if (m.role !== "assistant") return [m];
		const content = m.content.filter((c) => c.type !== "toolCall");
		if (content.length === m.content.length) return [m];
		return content.length > 0 ? [{ ...m, content }] : [];
	});
}
