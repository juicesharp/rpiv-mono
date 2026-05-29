import type { SelectItem } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { filterItems, fuzzyScore, isBackspace, isPrintable } from "./fuzzy.js";

const advisorItems: SelectItem[] = [
	{ label: "Claude Opus", value: "anthropic:claude-opus-4-7" },
	{ label: "Claude Sonnet", value: "anthropic:claude-sonnet-4-6" },
	{ label: "Claude Haiku", value: "anthropic:claude-haiku-4-5" },
	{ label: "GPT-5", value: "openai:gpt-5" },
	{ label: "GLM-4.6", value: "zai:glm-4-6" },
	{ label: "No advisor", value: "__none__" },
];

describe("fuzzyScore", () => {
	it("returns 0 for an empty query (matches everything)", () => {
		expect(fuzzyScore("", "anything")).toBe(0);
	});

	it("returns null when the query is not a subsequence", () => {
		expect(fuzzyScore("xyz", "claude opus")).toBeNull();
	});

	it("matches a subsequence regardless of contiguity", () => {
		expect(fuzzyScore("cop", "claude opus")).not.toBeNull();
	});

	it("is case-insensitive", () => {
		expect(fuzzyScore("OPUS", "claude opus")).not.toBeNull();
	});

	it("scores a contiguous run higher than a scattered match", () => {
		const contiguous = fuzzyScore("opus", "claude opus") as number;
		const scattered = fuzzyScore("clop", "claude opus") as number;
		expect(contiguous).toBeGreaterThan(scattered);
	});

	it("rewards word-boundary matches", () => {
		const boundary = fuzzyScore("o", "claude opus") as number; // matches the 'o' at a space boundary
		const midword = fuzzyScore("d", "claude opus") as number; // matches 'd' mid-word
		expect(boundary).toBeGreaterThan(midword);
	});
});

describe("filterItems", () => {
	it("returns the original list (same order) for an empty query", () => {
		expect(filterItems(advisorItems, "")).toEqual(advisorItems);
	});

	it("matches against the value, not just the label", () => {
		const result = filterItems(advisorItems, "gpt-5");
		expect(result.map((i) => i.value)).toContain("openai:gpt-5");
	});

	it("matches a label substring that is not a prefix of the value", () => {
		// "opus" is not a prefix of "anthropic:claude-opus-4-7" — the built-in
		// SelectList.setFilter would miss this; fuzzy matching catches it.
		const result = filterItems(advisorItems, "opus");
		expect(result[0]?.value).toBe("anthropic:claude-opus-4-7");
	});

	it("drops items that do not match", () => {
		const result = filterItems(advisorItems, "glm");
		expect(result).toHaveLength(1);
		expect(result[0]?.value).toBe("zai:glm-4-6");
	});

	it("returns an empty list when nothing matches", () => {
		expect(filterItems(advisorItems, "zzzzzz")).toEqual([]);
	});
});

describe("isBackspace", () => {
	it("recognizes DEL (0x7f) and the backspace escape", () => {
		expect(isBackspace(String.fromCharCode(0x7f))).toBe(true);
		expect(isBackspace("\b")).toBe(true);
	});

	it("rejects ordinary characters", () => {
		expect(isBackspace("a")).toBe(false);
	});
});

describe("isPrintable", () => {
	it("accepts a single printable character", () => {
		expect(isPrintable("a")).toBe(true);
	});

	it("rejects control bytes, empty, and multi-char input", () => {
		expect(isPrintable(String.fromCharCode(0x7f))).toBe(false);
		expect(isPrintable("")).toBe(false);
		expect(isPrintable("ab")).toBe(false);
	});
});
