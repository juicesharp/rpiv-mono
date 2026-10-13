import { describe, expect, it } from "vitest";
import { CLEANUP_SKIP_REASON, summarizeCleanupSkips } from "./agents-types.js";

// De-nested from the cleanupPerCwdAgents describe of the pre-split
// agents.test.ts: summarizeCleanupSkips is a pure formatter owned by
// agents-types.ts, so its truth table lives beside it.
describe("summarizeCleanupSkips", () => {
	it("returns empty string for no skips", () => {
		expect(summarizeCleanupSkips([])).toBe("");
	});

	it("formats a single reason", () => {
		expect(summarizeCleanupSkips([{ dir: "/a", reason: CLEANUP_SKIP_REASON.DIVERGED }])).toBe("1 with user edits");
	});

	it("aggregates and orders reasons (unmanaged, diverged, custom-files)", () => {
		const skips = [
			{ dir: "/a", reason: CLEANUP_SKIP_REASON.DIVERGED },
			{ dir: "/b", reason: CLEANUP_SKIP_REASON.UNMANAGED },
			{ dir: "/c", reason: CLEANUP_SKIP_REASON.CUSTOM_FILES },
			{ dir: "/d", reason: CLEANUP_SKIP_REASON.DIVERGED },
		];
		expect(summarizeCleanupSkips(skips)).toBe("1 unmanaged, 2 with user edits, 1 with custom files");
	});
});
