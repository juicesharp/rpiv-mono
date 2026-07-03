/**
 * Stage-def read-declaration tests — the `fanin()` builder and the
 * `readName`/`readsAll` normalizers that collapse the `string | spec` union
 * for every `reads:` consumer. The all-entries projection behaviour itself is
 * exercised end-to-end in named-registry.test.ts.
 */

import { describe, expect, it } from "vitest";
import { fanin, readName, readsAll, type StageRead } from "./stage-def.js";

describe("fanin()", () => {
	it("builds an all-entries read spec", () => {
		expect(fanin("plans")).toEqual({ name: "plans", all: true });
	});

	it("throws on an empty name", () => {
		expect(() => fanin("")).toThrow(/non-empty channel name/);
	});

	it("throws on a non-string name", () => {
		// jiti-loaded literals erase types; guard the runtime path.
		expect(() => fanin(undefined as unknown as string)).toThrow(/non-empty channel name/);
	});
});

describe("readName()", () => {
	it("returns a bare string unchanged", () => {
		expect(readName("plans")).toBe("plans");
	});

	it("reads .name off a spec", () => {
		expect(readName({ name: "plans", all: true })).toBe("plans");
		expect(readName(fanin("plans"))).toBe("plans");
	});
});

describe("readsAll()", () => {
	it("is false for a bare string (latest-wins)", () => {
		expect(readsAll("plans")).toBe(false);
	});

	it("is true for a fanin() spec", () => {
		expect(readsAll(fanin("plans"))).toBe(true);
		expect(readsAll({ name: "plans", all: true })).toBe(true);
	});

	it("is false for an explicit all:false spec", () => {
		const read: StageRead = { name: "plans", all: false };
		expect(readsAll(read)).toBe(false);
	});

	it("is false for a spec with no all flag", () => {
		expect(readsAll({ name: "plans" })).toBe(false);
	});
});
