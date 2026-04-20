import { describe, expect, it } from "vitest";
import { buildMainItems, buildResponse, buildToolResult, itemAt, wrapIndex } from "./ask-user-question.js";
import type { WrappingSelectItem } from "./wrapping-select.js";

describe("buildMainItems", () => {
	it("appends the Type-something sentinel", () => {
		const items = buildMainItems([{ label: "A" }, { label: "B", description: "b-desc" }]);
		expect(items).toEqual([
			{ label: "A", description: undefined },
			{ label: "B", description: "b-desc" },
			{ label: "Type something.", isOther: true },
		]);
	});
	it("returns just the sentinel for empty options", () => {
		const items = buildMainItems([]);
		expect(items).toEqual([{ label: "Type something.", isOther: true }]);
	});
	it("is non-mutating", () => {
		const input = [{ label: "A" }];
		buildMainItems(input);
		expect(input).toEqual([{ label: "A" }]);
	});
});

describe("itemAt", () => {
	const main: WrappingSelectItem[] = [{ label: "m0" }, { label: "m1" }];
	const chat: WrappingSelectItem[] = [{ label: "c0", isChat: true }];
	it("returns main item for in-range index", () => {
		expect(itemAt(0, main, chat)).toEqual({ label: "m0" });
		expect(itemAt(1, main, chat)).toEqual({ label: "m1" });
	});
	it("returns chat item when index beyond main", () => {
		expect(itemAt(2, main, chat)).toEqual({ label: "c0", isChat: true });
	});
	it("returns undefined when out of combined range", () => {
		expect(itemAt(5, main, chat)).toBeUndefined();
	});
});

describe("wrapIndex", () => {
	it("wraps negatives correctly", () => {
		expect(wrapIndex(-1, 3)).toBe(2);
		expect(wrapIndex(-4, 3)).toBe(2);
	});
	it("wraps positives correctly", () => {
		expect(wrapIndex(3, 3)).toBe(0);
		expect(wrapIndex(7, 3)).toBe(1);
	});
	it("returns 0 when total=1", () => {
		expect(wrapIndex(0, 1)).toBe(0);
		expect(wrapIndex(-5, 1)).toBe(0);
		expect(wrapIndex(99, 1)).toBe(0);
	});
});

describe("buildResponse", () => {
	const params = { question: "Q?", options: [{ label: "A" }] };

	it("returns decline envelope for null choice", () => {
		const r = buildResponse(null, params);
		expect(r.content[0]).toEqual({ type: "text", text: "User declined to answer questions" });
		expect(r.details.answer).toBeNull();
	});

	it("returns isOther custom-answer envelope", () => {
		const r = buildResponse({ label: "my answer", isOther: true }, params);
		expect(r.content[0]).toEqual({ type: "text", text: "User answered: my answer" });
		expect(r.details).toMatchObject({ answer: "my answer", wasCustom: true });
	});

	it("returns isOther with (no input) placeholder for empty label", () => {
		const r = buildResponse({ label: "", isOther: true }, params);
		expect(r.content[0]).toEqual({ type: "text", text: "User answered: (no input)" });
		expect(r.details.answer).toBeNull();
	});

	it("returns isChat envelope", () => {
		const r = buildResponse({ label: "Chat about this", isChat: true }, params);
		expect(r.details).toMatchObject({
			answer: "User wants to chat about this",
			wasChat: true,
		});
	});

	it("isOther precedence over isChat (isOther wins)", () => {
		const r = buildResponse({ label: "x", isOther: true, isChat: true }, params);
		expect(r.details).toMatchObject({ wasCustom: true });
		expect(r.details.wasChat).toBeUndefined();
	});

	it("returns plain-selection envelope for regular item", () => {
		const r = buildResponse({ label: "A" }, params);
		expect(r.content[0]).toEqual({ type: "text", text: "User selected: A" });
		expect(r.details).toMatchObject({ answer: "A", wasCustom: false });
	});
});

describe("buildToolResult", () => {
	it("locks the envelope shape", () => {
		const r = buildToolResult("msg", { question: "q", answer: null });
		expect(r).toEqual({
			content: [{ type: "text", text: "msg" }],
			details: { question: "q", answer: null },
		});
	});

	it("passes details reference through (no clone)", () => {
		const details = { question: "q", answer: "a" };
		const r = buildToolResult("msg", details);
		expect(r.details).toBe(details);
	});
});
