import type { ToolInfo } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { getInventoryMessage, stableStringify } from "./advisor.js";

const tool = (overrides: Partial<ToolInfo>): ToolInfo =>
	({
		name: "t",
		description: "desc",
		parameters: { type: "object", properties: {}, required: [] },
		sourceInfo: { path: "/some/path" },
		...overrides,
	}) as ToolInfo;

describe("stableStringify", () => {
	it("returns JSON.stringify for primitives + null", () => {
		expect(stableStringify(null)).toBe("null");
		expect(stableStringify(42)).toBe("42");
		expect(stableStringify("x")).toBe('"x"');
		expect(stableStringify(true)).toBe("true");
	});
	it("sorts object keys recursively", () => {
		expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
	});
	it("drops undefined properties in objects", () => {
		expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
	});
	it("emits null for undefined in arrays", () => {
		expect(stableStringify([1, undefined, 2])).toBe("[1,null,2]");
	});
	it("produces same string for differently-inserted same-key objects", () => {
		expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
	});
});

describe("getInventoryMessage — caching", () => {
	it("returns undefined when tool list is empty", () => {
		expect(getInventoryMessage([])).toBeUndefined();
	});
	it("returns the same reference on repeated calls with same-name-set", () => {
		const tools = [tool({ name: "a" }), tool({ name: "b" })];
		const first = getInventoryMessage(tools);
		const second = getInventoryMessage(tools);
		expect(second).toBe(first);
	});
	it("returns the same reference when tool order changes", () => {
		const first = getInventoryMessage([tool({ name: "a" }), tool({ name: "b" })]);
		const second = getInventoryMessage([tool({ name: "b" }), tool({ name: "a" })]);
		expect(second).toBe(first);
	});
	it("returns the same reference when sourceInfo differs (per :187-192 omission)", () => {
		const first = getInventoryMessage([tool({ name: "a", sourceInfo: { path: "/p1" } as never })]);
		const second = getInventoryMessage([tool({ name: "a", sourceInfo: { path: "/p2" } as never })]);
		expect(second).toBe(first);
	});
	it("returns the same reference when description differs (name-only signature)", () => {
		const first = getInventoryMessage([tool({ name: "a", description: "d1" })]);
		const second = getInventoryMessage([tool({ name: "a", description: "d2" })]);
		expect(second).toBe(first);
	});
	it("returns a DIFFERENT reference when tool-name set changes", () => {
		const first = getInventoryMessage([tool({ name: "a" })]);
		const second = getInventoryMessage([tool({ name: "a" }), tool({ name: "b" })]);
		expect(second).not.toBe(first);
	});
	it("rebuilds after deleting the globalThis cache", () => {
		const first = getInventoryMessage([tool({ name: "a" })]);
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("rpiv-advisor")];
		const second = getInventoryMessage([tool({ name: "a" })]);
		expect(second).not.toBe(first);
	});
	it("renders inventory body with sorted stableStringified params", () => {
		const m = getInventoryMessage([tool({ name: "b", parameters: { b: 1, a: 2 } as never }), tool({ name: "a" })]);
		const text = (m?.content[0] as { type: "text"; text: string }).text;
		expect(text.indexOf("### a")).toBeLessThan(text.indexOf("### b"));
		expect(text).toContain('{"a":2,"b":1}');
	});
});
