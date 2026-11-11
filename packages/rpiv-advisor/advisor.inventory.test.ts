import { describe, expect, it } from "vitest";
import { getInventoryMessage, MAX_INVENTORY_CHARS } from "./advisor/index.ts";

const textOf = (message: NonNullable<ReturnType<typeof getInventoryMessage>>): string =>
	(message.content[0] as { type: "text"; text: string }).text;

describe("getInventoryMessage — active tool names", () => {
	it("returns undefined when no tool is active", () => {
		expect(getInventoryMessage([])).toBeUndefined();
	});
	it("returns undefined when only the advisor itself is active", () => {
		expect(getInventoryMessage(["advisor"])).toBeUndefined();
	});
	it("lists active names only, with no descriptions or parameter schemas", () => {
		const text = textOf(getInventoryMessage(["read"])!);
		expect(text).toContain("active tool names");
		expect(text).toContain("- read");
		expect(text).not.toContain("Parameters");
		expect(text).not.toContain("description");
	});
	it("sorts names so the cache prefix is order-independent", () => {
		const text = textOf(getInventoryMessage(["zeta", "alpha", "read"])!);
		expect(text.indexOf("- alpha")).toBeLessThan(text.indexOf("- read"));
		expect(text.indexOf("- read")).toBeLessThan(text.indexOf("- zeta"));
	});
	it("omits the advisor itself from the inventory", () => {
		const text = textOf(getInventoryMessage(["advisor", "bash"])!);
		expect(text).toContain("- bash");
		expect(text).not.toContain("- advisor");
	});
	it("deduplicates repeated active names", () => {
		const text = textOf(getInventoryMessage(["read", "read", "bash"])!);
		expect(text.split("\n").filter((line) => line === "- read")).toHaveLength(1);
		expect(text).not.toContain("omitted");
	});
});

describe("getInventoryMessage — caching", () => {
	it("returns the same reference on repeated calls with the same active set", () => {
		const first = getInventoryMessage(["a", "b"]);
		const second = getInventoryMessage(["a", "b"]);
		expect(second).toBe(first);
	});
	it("returns the same reference when the active set order changes", () => {
		const first = getInventoryMessage(["a", "b"]);
		const second = getInventoryMessage(["b", "a"]);
		expect(second).toBe(first);
	});
	it("returns a DIFFERENT reference when the active set changes", () => {
		const first = getInventoryMessage(["a"]);
		const second = getInventoryMessage(["a", "b"]);
		expect(second).not.toBe(first);
	});
	it("rebuilds after deleting the globalThis cache", () => {
		const first = getInventoryMessage(["a"]);
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("rpiv-advisor")];
		const second = getInventoryMessage(["a"]);
		expect(second).not.toBe(first);
	});
});

describe("getInventoryMessage — size budget", () => {
	it("caps the name list at MAX_INVENTORY_CHARS on whole-name boundaries and reports the exact omission count", () => {
		const names = Array.from({ length: 623 }, (_, i) => `tool-${String(i).padStart(4, "0")}-${"x".repeat(40)}`);
		const text = textOf(getInventoryMessage(names)!);
		const lines = text.split("\n").filter((line) => line.startsWith("- "));

		expect(lines.length).toBeGreaterThan(0);
		const renderedChars = lines.reduce((total, line) => total + line.length + 1, 0);
		expect(renderedChars).toBeLessThanOrEqual(MAX_INVENTORY_CHARS);
		for (const line of lines) expect(names).toContain(line.slice(2));

		const marker = /\(\+(\d+) more active tool names omitted\)/.exec(text);
		expect(marker).not.toBeNull();
		expect(Number(marker?.[1])).toBe(names.length - lines.length);
	});
	it("omits a single name longer than the budget without exceeding it or cutting the name", () => {
		const oversized = "x".repeat(MAX_INVENTORY_CHARS + 1);
		const text = textOf(getInventoryMessage([oversized, "read"])!);
		expect(text).not.toContain(oversized);
		expect(text).toContain("- read");
		expect(text).toContain("(+1 more active tool names omitted)");
		const lines = text.split("\n").filter((line) => line.startsWith("- "));
		const renderedChars = lines.reduce((total, line) => total + line.length + 1, 0);
		expect(renderedChars).toBeLessThanOrEqual(MAX_INVENTORY_CHARS);
	});
	it("keeps the cached prefix when only already-omitted names change, and rebuilds when the omission count changes", () => {
		const included = Array.from({ length: 10 }, (_, i) => `a-${String(i).padStart(2, "0")}`);
		const longName = (tag: string) => `z-${tag}-${"x".repeat(5000)}`;
		const omitted = ["b", "c", "d", "e", "f"];

		const first = getInventoryMessage([...included, ...omitted.map(longName)]);
		const changed = getInventoryMessage([
			...included,
			longName("b"),
			longName("c"),
			longName("d"),
			longName("replaced"),
			longName("f"),
		]);
		expect(changed).toBe(first);
		const text = textOf(first!);
		expect(text).not.toContain("z-d-");
		expect(text).toContain("(+3 more active tool names omitted)");

		const grown = getInventoryMessage([...included, ...omitted.map(longName), longName("extra")]);
		expect(grown).not.toBe(first);
	});
	it("adds no omission marker when every name fits", () => {
		const text = textOf(getInventoryMessage(["a", "b"])!);
		expect(text).not.toContain("omitted");
	});
});
