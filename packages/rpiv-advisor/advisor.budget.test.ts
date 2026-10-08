import { makeAssistantMessage, makeToolResult, makeUserMessage } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import {
	applyContextBudget,
	deriveAdvisorBudget,
	dropPruneCoveredToolResults,
	estimateTokens,
	repairToolPairing,
} from "./advisor/budget.js";
import { ensureUserTailForAdvisor, getPruneCoveredToolCallIds } from "./advisor/context.js";

const BUDGET = {
	keepFirst: 4,
	keepLast: 6,
	toolResultMaxChars: 256,
};

describe("advisor context budget", () => {
	it("uses a conservative token estimate and reserves output plus margin", () => {
		expect(estimateTokens("a".repeat(300))).toBe(115);
		expect(deriveAdvisorBudget(128_000, 4_096)).toBe(128_000 - 4_096 - 12_800);
		expect(deriveAdvisorBudget(undefined, 4_096)).toBe(32_000 - 4_096 - 3_200);
	});

	it("preserves the complete prepared branch when it already fits", () => {
		const messages = Array.from({ length: 12 }, (_, index) => makeUserMessage(`turn ${index}`));
		const result = applyContextBudget(messages, { ...BUDGET, maxInputTokens: 10_000 });
		expect(result.messages).toHaveLength(messages.length);
		expect(result.dropped).toBe(0);
	});

	it("fits a 500k-character transcript within the requested budget", () => {
		const messages = Array.from({ length: 100 }, (_, index) => makeUserMessage(`turn ${index} ${"x".repeat(5_000)}`));
		const result = applyContextBudget(messages, { ...BUDGET, maxInputTokens: 2_000 });
		expect(result.estimatedTokens).toBeLessThanOrEqual(2_000);
		expect(result.dropped).toBeGreaterThan(0);
	});

	it("caps tool-result text before fitting", () => {
		const result = applyContextBudget(
			[
				makeAssistantMessage({ toolCalls: [{ id: "call-1", name: "bash", arguments: {} }] }),
				makeToolResult({ toolName: "bash", toolCallId: "call-1", text: "x".repeat(5_000) }),
			],
			{ ...BUDGET, maxInputTokens: 10_000 },
		);
		const toolResult = result.messages.find((message) => message.role === "toolResult");
		const text =
			toolResult?.role === "toolResult"
				? (toolResult.content.find((block) => block.type === "text")?.text ?? "")
				: "";
		expect(text).toContain("advisor context truncated");
		expect(text.length).toBeLessThan(300);
	});

	it("repairs orphan results and dangling tool calls", () => {
		const assistant = makeAssistantMessage({
			text: "attempted the command",
			toolCalls: [{ id: "call-1", name: "bash", arguments: {} }],
		});
		const result = makeToolResult({ toolName: "bash", toolCallId: "call-1", text: "output" });
		const danglingCall = repairToolPairing([assistant]);
		const orphanResult = repairToolPairing([result]);
		expect(danglingCall[0]?.role).toBe("assistant");
		expect(
			danglingCall[0]?.role === "assistant"
				? danglingCall[0].content.some((block) => block.type === "toolCall")
				: false,
		).toBe(false);
		expect(orphanResult).toEqual([]);
		const paired = repairToolPairing([assistant, result]);
		expect(paired).toHaveLength(2);
	});

	it("is idempotent", () => {
		const messages = [
			makeAssistantMessage({ toolCalls: [{ id: "call-1", name: "bash", arguments: {} }] }),
			makeToolResult({ toolName: "bash", toolCallId: "call-1", text: "output" }),
		];
		const once = repairToolPairing(messages);
		expect(repairToolPairing(once)).toEqual(once);
	});

	it("keeps compaction, branch, and prune summaries verbatim", () => {
		const compaction = makeUserMessage(
			"The conversation history before this point was compacted into the following summary:\n<summary>keep compaction</summary>",
		);
		const branch = makeUserMessage(
			"The following is a summary of a branch that this conversation came back from:\n<summary>keep branch</summary>",
		);
		const prune = makeUserMessage("<context-prune-summary>\nkeep prune\n</context-prune-summary>");
		const messages = [
			compaction,
			...Array.from({ length: 20 }, (_, index) => makeUserMessage(`old ${index} ${"x".repeat(2_000)}`)),
			branch,
			prune,
		];
		const result = applyContextBudget(messages, { ...BUDGET, maxInputTokens: 1_500 });
		const serialized = JSON.stringify(result.messages);
		expect(serialized).toContain("keep compaction");
		expect(serialized).toContain("keep branch");
		expect(serialized).toContain("keep prune");
	});

	it("drops prune-covered results while retaining the summary message", () => {
		const result = makeToolResult({ toolName: "bash", toolCallId: "call-1", text: "raw output" });
		const summary = makeUserMessage("<context-prune-summary>summary</context-prune-summary>");
		const messages = dropPruneCoveredToolResults([summary, result], new Set(["call-1"]));
		expect(messages).toEqual([summary]);
	});

	it("ensures the final message has a user role", () => {
		const result = ensureUserTailForAdvisor([makeUserMessage("question"), makeAssistantMessage({ text: "answer" })]);
		expect(result.at(-1)?.role).toBe("user");
	});

	it("reads pi-context-prune tool references from persisted summary metadata", () => {
		const ids = getPruneCoveredToolCallIds([
			{
				type: "custom_message",
				customType: "context-prune-summary",
				details: { toolCallRefs: [{ shortId: "t1", toolCallId: "call-1" }], toolCallIds: ["call-2"] },
			},
		]);
		expect([...ids]).toEqual(["call-1", "call-2"]);
	});
});
