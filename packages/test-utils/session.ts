import type { AssistantMessage, JsonObject, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export function makeUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

export interface AssistantMessageInput {
	text?: string;
	toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

export function makeAssistantMessage(input: AssistantMessageInput): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (input.text) content.push({ type: "text", text: input.text });
	for (const tc of input.toolCalls ?? []) {
		content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments as JsonObject });
	}
	return { role: "assistant", content, timestamp: Date.now() } as unknown as AssistantMessage;
}

export interface ToolResultInput {
	toolCallId?: string;
	toolName: string;
	text?: string;
	details?: unknown;
	isError?: boolean;
}

export function makeToolResult(input: ToolResultInput): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: input.toolCallId ?? `call-${input.toolName}-${Date.now()}`,
		toolName: input.toolName,
		content: input.text ? [{ type: "text", text: input.text }] : [],
		details: input.details,
		isError: input.isError ?? false,
		timestamp: Date.now(),
	} as unknown as ToolResultMessage;
}

export function makeMessageEntry(message: Message): SessionEntry {
	return { type: "message", message } as unknown as SessionEntry;
}

/** A `custom` session entry, as `pi.appendEntry(customType, data)` persists it (never sent to the LLM). */
export function makeCustomEntry(customType: string, data: unknown): SessionEntry {
	return { type: "custom", customType, data } as unknown as SessionEntry;
}

/** A root→leaf branch of message entries, chained by `id`/`parentId` like a real
 *  session path, so Pi's path-walking builders (`buildSessionContext`) traverse it. */
export function buildSessionEntries(messages: Message[]): SessionEntry[] {
	return messages.map(
		(message, i) =>
			({
				type: "message",
				id: `entry-${i}`,
				parentId: i === 0 ? null : `entry-${i - 1}`,
				message,
			}) as unknown as SessionEntry,
	);
}

export function buildLlmMessages(messages: Message[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}

export function makeTodoToolResult(details: unknown, text = "ok"): ToolResultMessage {
	return makeToolResult({ toolName: "todo", text, details });
}

export function makeInflightAdvisorAssistant(): AssistantMessage {
	return makeAssistantMessage({
		toolCalls: [{ id: "advisor-inflight", name: "advisor", arguments: {} }],
	});
}
