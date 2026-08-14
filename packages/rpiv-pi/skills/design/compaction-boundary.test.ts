import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skill = readFileSync(fileURLToPath(new URL("./SKILL.md", import.meta.url)), "utf8");

describe("design skill compaction boundary", () => {
	it("supports artifact-authoritative resume", () => {
		expect(skill).toContain("--resume <path-to-.rpiv/artifacts/designs/*.md>");
		expect(skill).toContain("never reconstruct them from conversation or a compaction summary");
		expect(skill).toContain("Enter Step 6 at the pending slice");
	});

	it("stops after one approved non-final slice", () => {
		expect(skill).toContain("**STOP THE AGENT RUN**");
		expect(skill).toContain("/skill:design --resume <design-path>");
		expect(skill).toContain("Never carry multiple verifier-heavy slices in one agent run");
	});

	it("requires one exact persisted slice entry before stopping", () => {
		expect(skill).toContain("Fill the slice's existing `## Slices` entry");
		expect(skill).toContain("Never add a second Slice N heading");
		expect(skill).toContain("verify they byte-match the approved payload");
		expect(skill).toContain("The persisted artifact is the handoff");
	});
});
