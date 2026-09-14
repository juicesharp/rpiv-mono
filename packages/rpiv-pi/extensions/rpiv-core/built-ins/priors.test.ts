import { describe, expect, it } from "vitest";
import { sectionDiff } from "./priors.js";

// The diff is per-section on purpose: a document-wide LCS table is O(n·m)
// MEMORY over the whole plan, and a stitched build plan runs to ~43k lines
// (1.8e9 cells, ~14 GiB) — past the V8 heap, which kills the process instead
// of throwing where the surgical-fix guard could fail closed. The large-pair
// case below is that regression pin; the rest pin the semantics.
describe("sectionDiff", () => {
	const doc = (body: Record<string, string[]>) =>
		Object.entries(body)
			.flatMap(([heading, lines]) => [`## ${heading}`, ...lines])
			.join("\n");

	it("reports nothing touched when the documents are identical", () => {
		const d = doc({ "Phase 1": ["a", "b"], "Phase 2": ["c"] });
		expect(sectionDiff(d, d)).toEqual({ touchedSections: new Set(), changedLines: 0 });
	});

	it("attributes an edited line to its own section only", () => {
		const prior = doc({ "Phase 1": ["a", "b"], "Phase 2": ["c", "d"] });
		const current = doc({ "Phase 1": ["a", "b"], "Phase 2": ["c", "D!"] });
		expect(sectionDiff(prior, current)).toEqual({ touchedSections: new Set(["phase 2"]), changedLines: 2 });
	});

	it("stays insertion-tolerant: one inserted line is one changed line", () => {
		const prior = doc({ "Phase 1": ["a", "b", "c"], "Phase 2": ["d"] });
		const current = doc({ "Phase 1": ["a", "new", "b", "c"], "Phase 2": ["d"] });
		expect(sectionDiff(prior, current)).toEqual({ touchedSections: new Set(["phase 1"]), changedLines: 1 });
	});

	it("counts a line moved across sections in both sections (fail-closed)", () => {
		const prior = doc({ "Phase 1": ["a", "moved"], "Phase 2": ["b"] });
		const current = doc({ "Phase 1": ["a"], "Phase 2": ["moved", "b"] });
		expect(sectionDiff(prior, current)).toEqual({
			touchedSections: new Set(["phase 1", "phase 2"]),
			changedLines: 2,
		});
	});

	it("diffs a 43k-line stitched plan within a bounded heap", () => {
		const body: Record<string, string[]> = {};
		for (let p = 1; p <= 30; p++) {
			body[`Phase ${p}`] = Array.from({ length: 1_400 }, (_, i) => `phase ${p} line ${i}`);
		}
		const prior = doc(body);
		body["Phase 7"] = [...body["Phase 7"].slice(0, 500), "edited", ...body["Phase 7"].slice(501)];
		const current = doc(body);

		const before = process.memoryUsage().heapUsed;
		const result = sectionDiff(prior, current);
		const grew = process.memoryUsage().heapUsed - before;

		expect(result.touchedSections).toEqual(new Set(["phase 7"]));
		expect(result.changedLines).toBe(2);
		expect(grew).toBeLessThan(256 * 1024 * 1024);
	});
});
