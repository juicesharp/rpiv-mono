/**
 * progress-markers.test.ts — prose guard for the research skill's SKILL.md
 * progress-marker discipline, moved verbatim from
 * extensions/rpiv-core/built-in-workflows.test.ts (it reads the bundled skill
 * body, so it lives beside its subject under skills/research/).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_SKILLS_DIR } from "../../extensions/rpiv-core/paths.js";

describe("research skill progress markers (prose guard)", () => {
	const body = readFileSync(join(BUNDLED_SKILLS_DIR, "research", "SKILL.md"), "utf-8");

	it("keeps the frontmatter, the dispatch shape, and the existing path-safe lines intact", () => {
		expect(body).toContain("name: research");
		expect(body).toContain("disable-model-invocation: true");
		expect(body).toContain("**single assistant message with multiple Agent calls**");
		expect(body).toContain("[Scoped]:");
		expect(body).toContain("Research document written to:");
	});

	it("carries the four markers in questions → dispatch → wait → synthesize order", () => {
		const step1 = body.indexOf("### Step 1: Input Handling");
		const step2 = body.indexOf("### Step 2: Dispatch Analysis Agents");
		const step3 = body.indexOf("### Step 3: Synthesize and Checkpoint");
		expect(step1).toBeGreaterThan(-1);
		expect(step2).toBeGreaterThan(step1);
		expect(step3).toBeGreaterThan(step2);
		// Questions fires at Step 1's parse point, before any dispatch — the
		// goal's first marker moment; item 7's [Scoped] report stays the
		// separate grouped-status summary it already is.
		const questions = body.indexOf("[Questions]:");
		expect(questions).toBeGreaterThan(step1);
		expect(questions).toBeLessThan(step2);
		expect(body).toContain(
			"[Questions]: {N} research questions formulated. Reading shared files and grouping before dispatch.",
		);
		const dispatched = body.indexOf("[Dispatched]:");
		expect(dispatched).toBeGreaterThan(step2);
		expect(dispatched).toBeLessThan(step3);
		expect(body).toContain(
			"[Dispatched]: {N} analysis agents in one batch{ + precedent sweep}. Waiting for returns.",
		);
		expect(body).toContain("[Returned]: {N}/{N} agents returned. Proceeding to synthesis.");
		expect(body).toContain("[Synthesizing]: compiling {N} agent reports.");
		// Returned fires only after the wait barrier closes the batch; the
		// synthesizing marker follows at Step 3.
		const wait = body.indexOf("**Wait for ALL agents to complete**");
		const returned = body.indexOf("[Returned]:");
		const synthesizing = body.indexOf("[Synthesizing]:");
		expect(wait).toBeGreaterThan(-1);
		expect(returned).toBeGreaterThan(wait);
		expect(synthesizing).toBeGreaterThan(returned);
	});

	it("keeps every marker line path-free and pins the transcript-only discipline bullet", () => {
		for (const line of body.split("\n")) {
			if (
				line.includes("[Questions]:") ||
				line.includes("[Dispatched]:") ||
				line.includes("[Returned]:") ||
				line.includes("[Synthesizing]:")
			) {
				expect(line).not.toContain(".rpiv/artifacts/");
			}
		}
		const notes = body.slice(body.indexOf("## Important Notes"));
		expect(notes).toContain("never artifact content");
		expect(notes).toContain("before the file is written");
	});
});

// ---------------------------------------------------------------------------
// implement reads wiring — every implement stage declares reads: ["plans"]
// and validates clean with contracts threaded in.
// ---------------------------------------------------------------------------
