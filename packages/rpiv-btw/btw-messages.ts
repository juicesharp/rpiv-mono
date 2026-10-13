/**
 * Cycle-break leaf module.
 *
 * Owns the `BtwTurn` interface and the `userMessageText` / `assistantMessageText`
 * message-text extractors, moved here from `btw.ts` to sever the sole runtime
 * VALUE back-edge `btw-ui.ts → btw.ts`.
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

import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

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
