import { describe, expect, it } from "vitest";
import { formatTokens, type LaneUsage, toLaneUsage } from "./lane-usage.js";

describe("formatTokens (footer.js thresholds, verbatim)", () => {
	it.each([
		[0, "0"],
		[1, "1"],
		[999, "999"],
		[1000, "1.0k"],
		[1500, "1.5k"],
		[9999, "10.0k"],
		[10000, "10k"],
		[12000, "12k"],
		[999999, "1000k"],
		[1000000, "1.0M"],
		[1500000, "1.5M"],
		[9999999, "10.0M"],
		[10000000, "10M"],
		[12345678, "12M"],
	])("%d → %s", (count, expected) => {
		expect(formatTokens(count)).toBe(expected);
	});
});

describe("toLaneUsage", () => {
	it("maps a well-formed SessionStats into a LaneUsage (cost + percent threaded)", () => {
		const stats = {
			tokens: { input: 1500, output: 800, cacheRead: 500, cacheWrite: 200, total: 3000 },
			cost: 0.05,
			contextUsage: { percent: 45.2 },
		};
		const usage = toLaneUsage(stats);
		expect(usage).toEqual<LaneUsage>({
			input: 1500,
			output: 800,
			cacheRead: 500,
			cacheWrite: 200,
			total: 3000,
			cost: 0.05,
			percent: 45.2,
		});
	});

	it("threads a null percent (unknown post-compaction)", () => {
		const usage = toLaneUsage({
			tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
			contextUsage: { percent: null },
		});
		expect(usage?.percent).toBeNull();
	});

	it("omits cost / percent when absent", () => {
		const usage = toLaneUsage({ tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } });
		expect(usage).toBeDefined();
		expect(usage).not.toHaveProperty("cost");
		expect(usage).not.toHaveProperty("percent");
	});

	it("recomputes total from the four parts when the source total is malformed", () => {
		const usage = toLaneUsage({
			tokens: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400, total: "nope" },
		});
		expect(usage?.total).toBe(1000); // 100 + 200 + 300 + 400
	});

	it("recomputes total when the source total is absent", () => {
		const usage = toLaneUsage({ tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } });
		expect(usage?.total).toBe(4);
	});

	it("returns undefined on a missing tokens object", () => {
		expect(toLaneUsage({ cost: 1 })).toBeUndefined();
	});

	it("returns undefined on a malformed tokens object", () => {
		expect(toLaneUsage({ tokens: "oops" })).toBeUndefined();
	});

	it("returns undefined on a partial tokens object (non-finite field)", () => {
		expect(toLaneUsage({ tokens: { input: 1, output: 2, cacheRead: "x", cacheWrite: 4 } })).toBeUndefined();
		expect(toLaneUsage({ tokens: { input: NaN, output: 2, cacheRead: 3, cacheWrite: 4 } })).toBeUndefined();
	});

	it("returns undefined on a non-object", () => {
		expect(toLaneUsage(undefined)).toBeUndefined();
		expect(toLaneUsage(null)).toBeUndefined();
		expect(toLaneUsage("stats")).toBeUndefined();
		expect(toLaneUsage(42)).toBeUndefined();
	});

	it("ignores a malformed cost (does not thread it)", () => {
		const usage = toLaneUsage({
			tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
			cost: "free",
		});
		expect(usage).toBeDefined();
		expect(usage).not.toHaveProperty("cost");
	});

	it("ignores a malformed percent (does not thread it)", () => {
		const usage = toLaneUsage({
			tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
			contextUsage: { percent: "full" },
		});
		expect(usage).toBeDefined();
		expect(usage).not.toHaveProperty("percent");
	});
});
