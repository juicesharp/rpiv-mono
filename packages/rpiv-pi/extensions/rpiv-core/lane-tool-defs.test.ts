/**
 * lane-tool-defs tests — the shared tool-definition harvest cache backing the
 * disk-jsonl transcript fallback's per-tool renderers.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { __resetLaneToolDefs, getCachedToolDef, harvestToolDefs } from "./lane-tool-defs.js";

beforeEach(() => {
	__resetLaneToolDefs();
});

/** A minimal harvest source over a name → def record. */
function sourceOf(defs: Record<string, unknown>) {
	return {
		getAllTools: () => Object.keys(defs).map((name) => ({ name })),
		getToolDefinition: (name: string) => defs[name],
	};
}

describe("harvestToolDefs", () => {
	it("caches every definition the session resolves, retrievable by name", () => {
		const todo = { name: "todo", renderCall: () => undefined };
		const auq = { name: "ask_user_question" };
		harvestToolDefs(sourceOf({ todo, ask_user_question: auq }));
		expect(getCachedToolDef("todo")).toBe(todo);
		expect(getCachedToolDef("ask_user_question")).toBe(auq);
		expect(getCachedToolDef("never-harvested")).toBeUndefined();
	});

	it("last writer wins across harvests (a /reload refresh on the next spawn)", () => {
		const v1 = { name: "todo", v: 1 };
		const v2 = { name: "todo", v: 2 };
		harvestToolDefs(sourceOf({ todo: v1 }));
		harvestToolDefs(sourceOf({ todo: v2 }));
		expect(getCachedToolDef("todo")).toBe(v2);
	});

	it("skips undefined definitions instead of caching them", () => {
		harvestToolDefs({
			getAllTools: () => [{ name: "ghost" }],
			getToolDefinition: () => undefined,
		});
		expect(getCachedToolDef("ghost")).toBeUndefined();
	});

	it("is a no-op on a session without getAllTools (older/stub sessions)", () => {
		expect(() => harvestToolDefs({ getToolDefinition: () => ({}) })).not.toThrow();
		expect(getCachedToolDef("anything")).toBeUndefined();
	});

	it("is fail-soft on throwing accessors and malformed tool lists", () => {
		expect(() =>
			harvestToolDefs({
				getAllTools: () => {
					throw new Error("boom");
				},
				getToolDefinition: () => ({}),
			}),
		).not.toThrow();
		// Non-array tool list → no-op.
		harvestToolDefs({ getAllTools: () => "nope", getToolDefinition: () => ({}) });
		// A per-tool throw skips that tool but keeps harvesting the rest.
		const kept = { name: "kept" };
		harvestToolDefs({
			getAllTools: () => [{ name: "explodes" }, { noName: true }, { name: "kept" }],
			getToolDefinition: (name: string) => {
				if (name === "explodes") throw new Error("boom");
				return name === "kept" ? kept : undefined;
			},
		});
		expect(getCachedToolDef("explodes")).toBeUndefined();
		expect(getCachedToolDef("kept")).toBe(kept);
	});

	it("__resetLaneToolDefs clears the cache", () => {
		harvestToolDefs(sourceOf({ todo: { name: "todo" } }));
		__resetLaneToolDefs();
		expect(getCachedToolDef("todo")).toBeUndefined();
	});
});
