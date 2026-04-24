import { describe, expect, it } from "vitest";
import { describeActivity, formatDuration, formatTokens, formatToolCall, formatTurns } from "./activity.js";
import type { SingleResult } from "./types.js";

function makeResult(messages: unknown[]): SingleResult {
	return {
		agent: "a",
		agentSource: "user",
		task: "t",
		exitCode: 0,
		messages: messages as unknown as SingleResult["messages"],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

describe("formatToolCall", () => {
	it("formats bash with command preview", () => {
		expect(formatToolCall("bash", { command: "npm test" })).toBe("running npm test");
	});

	it("truncates long bash commands at 40 chars", () => {
		const cmd = "a".repeat(100);
		const result = formatToolCall("bash", { command: cmd });
		expect(result.startsWith("running ")).toBe(true);
		expect(result.endsWith("…")).toBe(true);
	});

	it("shortens home path with ~ for read", () => {
		const home = process.env.HOME ?? "";
		const result = formatToolCall("read", { file_path: `${home}/src/foo.ts` });
		expect(result).toBe("reading ~/src/foo.ts");
	});

	it("formats grep with /pattern/", () => {
		expect(formatToolCall("grep", { pattern: "foo.*bar" })).toBe("searching /foo.*bar/");
	});

	it("falls back to JSON preview for unknown tools", () => {
		const result = formatToolCall("custom_tool", { a: 1 });
		expect(result.startsWith("custom_tool ")).toBe(true);
	});
});

describe("describeActivity", () => {
	it("returns 'thinking…' for undefined result", () => {
		expect(describeActivity(undefined)).toBe("thinking…");
	});

	it("returns 'thinking…' for empty messages", () => {
		expect(describeActivity(makeResult([]))).toBe("thinking…");
	});

	it("prefers the last toolCall in the last assistant message", () => {
		const result = makeResult([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me check." },
					{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
				],
			},
		]);
		expect(describeActivity(result)).toBe("running ls");
	});

	it("falls back to text when last assistant part is text", () => {
		const result = makeResult([{ role: "assistant", content: [{ type: "text", text: "I see the problem." }] }]);
		expect(describeActivity(result)).toBe("I see the problem.");
	});

	it("skips non-assistant messages", () => {
		const result = makeResult([
			{ role: "user", content: [{ type: "text", text: "ignored" }] },
			{ role: "assistant", content: [{ type: "text", text: "kept" }] },
		]);
		expect(describeActivity(result)).toBe("kept");
	});

	it("truncates long text to 60 chars + ellipsis", () => {
		const long = "a".repeat(100);
		const result = makeResult([{ role: "assistant", content: [{ type: "text", text: long }] }]);
		expect(describeActivity(result).endsWith("…")).toBe(true);
	});

	it("returns first non-empty line from multi-line text", () => {
		const result = makeResult([{ role: "assistant", content: [{ type: "text", text: "\n\nfirst line\nsecond" }] }]);
		expect(describeActivity(result)).toBe("first line");
	});
});

describe("formatTokens", () => {
	it("formats M for millions", () => {
		expect(formatTokens(1_234_567)).toBe("1.2M");
	});

	it("formats k for thousands", () => {
		expect(formatTokens(33_800)).toBe("33.8k");
	});

	it("returns plain count below 1000", () => {
		expect(formatTokens(42)).toBe("42");
	});
});

describe("formatDuration", () => {
	it("marks running when completedAt omitted", () => {
		expect(formatDuration(Date.now() - 1000)).toMatch(/\(running\)$/);
	});

	it("omits (running) when completedAt set", () => {
		const start = Date.now();
		expect(formatDuration(start, start + 1000)).toBe("1.0s");
	});
});

describe("formatTurns", () => {
	it("formats ⟳N without max", () => {
		expect(formatTurns(5)).toBe("⟳5");
	});

	it("formats ⟳N≤M with max", () => {
		expect(formatTurns(5, 30)).toBe("⟳5≤30");
	});
});
