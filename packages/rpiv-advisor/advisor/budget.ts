import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";

const CHARS_PER_TOKEN = 3;
const TOKEN_SAFETY_FACTOR = 1.15;
const DEFAULT_CONTEXT_WINDOW = 32_000;
const MIN_INPUT_TOKENS = 1_024;
const TRUNCATION_MARKER = "\n[advisor context truncated]";
const OMITTED_MARKER = "[earlier advisor context omitted to fit the reviewer's context window]";

export interface AdvisorContextBudgetOptions {
	maxInputTokens: number;
	keepFirst: number;
	keepLast: number;
	toolResultMaxChars: number;
}

export interface AdvisorContextBudgetResult {
	messages: Message[];
	dropped: number;
	estimatedTokens: number;
}

/** Conservative, provider-independent token estimate for context budgeting. */
// This deliberately errs higher than Pi's general chars/4 helper: advisor payloads are
// dense with tool arguments, code, and serialized metadata, where under-counting can
// recreate the context-window failure this budget is meant to prevent.
export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil((text.length / CHARS_PER_TOKEN) * TOKEN_SAFETY_FACTOR);
}

/** Estimate the serialized size of one message. */
export function estimateMessageTokens(message: Message): number {
	return estimateTokens(JSON.stringify(message));
}

/**
 * Derive the input budget from the reviewer's context window.
 *
 * Ten percent remains unused as a tokenizer/serialization safety margin. The
 * reserve is capped at half the window so a small configured reserve cannot
 * produce a negative budget.
 */
export function deriveAdvisorBudget(contextWindow: number | undefined, reserveTokens: number): number {
	const window =
		Number.isFinite(contextWindow) && (contextWindow ?? 0) > 0 ? Math.floor(contextWindow!) : DEFAULT_CONTEXT_WINDOW;
	const reserve = Math.min(
		Number.isFinite(reserveTokens) ? Math.max(0, Math.floor(reserveTokens)) : 0,
		Math.floor(window / 2),
	);
	const margin = Math.floor(window * 0.1);
	return Math.max(MIN_INPUT_TOKENS, window - reserve - margin);
}

/**
 * Remove summarized tool results without mutating the session messages.
 *
 * pi-context-prune keeps the persisted summary and marks covered tool-call IDs
 * in custom-message details. The caller supplies those IDs because the summary
 * metadata is intentionally not part of LLM Message.
 */
export function dropPruneCoveredToolResults(
	messages: Message[],
	summarizedToolCallIds: ReadonlySet<string>,
): Message[] {
	if (summarizedToolCallIds.size === 0) return messages;
	return messages.filter((message) => message.role !== "toolResult" || !summarizedToolCallIds.has(message.toolCallId));
}

/**
 * Repair tool-call/result pairing after context filtering or truncation.
 *
 * Providers reject both orphan results and dangling tool calls. The operation is
 * non-mutating and idempotent.
 */
export function repairToolPairing(messages: Message[]): Message[] {
	const presentCallIds = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && typeof block.id === "string") presentCallIds.add(block.id);
		}
	}

	const resolvedCallIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && presentCallIds.has(message.toolCallId)) {
			resolvedCallIds.add(message.toolCallId);
		}
	}

	const repaired: Message[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") {
			if (presentCallIds.has(message.toolCallId)) repaired.push(message);
			continue;
		}

		if (message.role === "assistant") {
			const content = message.content.filter(
				(block) => block.type !== "toolCall" || !block.id || resolvedCallIds.has(block.id),
			);
			if (content.length === 0) continue;
			if (content.length !== message.content.length) repaired.push({ ...message, content });
			else repaired.push(message);
			continue;
		}

		repaired.push(message);
	}
	return repaired;
}

function textContent(message: Message): string {
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
	if (message.role === "toolResult") {
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
	return "";
}

function isProtectedSummary(message: Message): boolean {
	if (message.role !== "user") return false;
	const text = textContent(message).trim();
	return (
		text.startsWith("The conversation history before this point was compacted into the following summary:") ||
		text.startsWith("The following is a summary of a branch that this conversation came back from:") ||
		text.startsWith("<context-prune-summary>")
	);
}

function capToolResult(message: ToolResultMessage, maxChars: number): ToolResultMessage {
	const limit = Math.max(1, Math.floor(maxChars));
	let remaining = limit;
	let truncated = false;
	const content = [] as ToolResultMessage["content"];

	for (const block of message.content) {
		if (block.type !== "text") {
			content.push(block);
			continue;
		}
		if (remaining <= 0) {
			truncated = true;
			continue;
		}
		if (block.text.length <= remaining) {
			content.push(block);
			remaining -= block.text.length;
			continue;
		}

		const keepChars = Math.max(0, remaining - TRUNCATION_MARKER.length);
		content.push({ ...block, text: `${block.text.slice(0, keepChars).trimEnd()}${TRUNCATION_MARKER}` });
		remaining = 0;
		truncated = true;
	}

	if (content.length === 0) {
		content.push({ type: "text", text: truncated ? TRUNCATION_MARKER.trim() : "[empty tool result]" });
	}
	return { ...message, content };
}

function prepareMessages(messages: Message[], toolResultMaxChars: number): Message[] {
	const cloned = structuredClone(messages);
	return cloned.map((message) =>
		message.role === "toolResult" ? capToolResult(message, toolResultMaxChars) : message,
	);
}

function omittedMarker(): Message {
	return {
		role: "user",
		content: OMITTED_MARKER,
		timestamp: Date.now(),
	};
}

function selectedMessages(
	source: Message[],
	selected: ReadonlySet<number>,
	omitted: number,
	includeMarker: boolean,
): Message[] {
	const chronological = [...selected]
		.sort((a, b) => a - b)
		.map((index) => source[index])
		.filter((message): message is Message => message !== undefined);
	const repaired = repairToolPairing(chronological);
	return includeMarker && omitted > 0 ? [omittedMarker(), ...repaired] : repaired;
}

function findRemovableIndex(
	selected: ReadonlySet<number>,
	protectedIndexes: ReadonlySet<number>,
	length: number,
	keepFirst: number,
	keepLast: number,
): number | undefined {
	const headEnd = Math.min(length, Math.max(0, keepFirst));
	const tailStart = Math.max(0, length - Math.max(0, keepLast));
	const candidates = [...selected].filter((index) => !protectedIndexes.has(index));
	const middle = candidates.filter((index) => index >= headEnd && index < tailStart).sort((a, b) => a - b);
	const tail = candidates.filter((index) => index >= tailStart).sort((a, b) => a - b);
	const head = candidates.filter((index) => index < headEnd).sort((a, b) => b - a);
	return [...middle, ...tail, ...head][0];
}

/**
 * Fit a branch to a conservative token budget while preserving summary messages.
 *
 * The function copies before capping, drops oldest non-summary context first, and
 * repairs tool pairing after every candidate rebuild. It never changes session
 * entries and is deterministic apart from timestamps on omission markers.
 */
export function applyContextBudget(messages: Message[], opts: AdvisorContextBudgetOptions): AdvisorContextBudgetResult {
	if (messages.length === 0) return { messages: [], dropped: 0, estimatedTokens: 0 };

	const prepared = prepareMessages(messages, opts.toolResultMaxChars);
	const maxInputTokens = Math.max(0, Math.floor(opts.maxInputTokens));
	const preparedEstimate = estimateMessages(prepared);
	if (preparedEstimate <= maxInputTokens) {
		const repaired = repairToolPairing(prepared);
		return {
			messages: repaired,
			dropped: Math.max(0, prepared.length - repaired.length),
			estimatedTokens: estimateMessages(repaired),
		};
	}
	const protectedIndexes = new Set<number>();
	for (let index = 0; index < prepared.length; index++) {
		if (isProtectedSummary(prepared[index])) protectedIndexes.add(index);
	}

	const selected = new Set<number>(protectedIndexes);
	const keepFirst = Math.max(0, Math.floor(opts.keepFirst));
	const keepLast = Math.max(0, Math.floor(opts.keepLast));
	for (let index = 0; index < Math.min(keepFirst, prepared.length); index++) selected.add(index);
	for (let index = Math.max(0, prepared.length - keepLast); index < prepared.length; index++) selected.add(index);

	let dropped = prepared.length - selected.size;
	let includeMarker = dropped > 0;
	let candidate = selectedMessages(prepared, selected, dropped, includeMarker);

	while (estimateMessages(candidate) > maxInputTokens) {
		if (includeMarker) {
			includeMarker = false;
			candidate = selectedMessages(prepared, selected, dropped, false);
			continue;
		}

		const removable = findRemovableIndex(selected, protectedIndexes, prepared.length, keepFirst, keepLast);
		if (removable === undefined) break;
		selected.delete(removable);
		dropped++;
		includeMarker = true;
		candidate = selectedMessages(prepared, selected, dropped, includeMarker);
	}

	const repaired = repairToolPairing(candidate);
	return {
		messages: repaired,
		dropped: Math.max(dropped, prepared.length - repaired.length),
		estimatedTokens: estimateMessages(repaired),
	};
}

function estimateMessages(messages: Message[]): number {
	return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}
