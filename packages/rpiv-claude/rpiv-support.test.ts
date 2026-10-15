import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflows } from "@juicesharp/rpiv-workflow/registration";
import { describe, expect, it } from "vitest";
import { registerRpivWorkflowSupport, skillFiles } from "./rpiv-support.js";

describe("skillFiles", () => {
	it("names a skill by its frontmatter, falling back to the directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpiv-sf-"));
		const write = (sub: string, body: string) => {
			mkdirSync(join(dir, sub));
			writeFileSync(join(dir, sub, "SKILL.md"), body);
		};
		write("a", "---\nname: alpha\n---\n");
		write("b", "no frontmatter");
		write("c", "---\nname: [unclosed\n---\n");
		mkdirSync(join(dir, "empty"));
		expect(skillFiles(dir).map((s) => s.name)).toEqual(["alpha", "b", "c"]);
		expect(skillFiles(join(dir, "missing"))).toEqual([]);
	});
});

describe("registerRpivWorkflowSupport", () => {
	// The guard for the failure seen live: without the contract and outcome
	// registrations, every built-in fails validation and no run can start.
	it("makes rpiv-pi's built-ins load with zero error-severity issues", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rpiv-sup-"));
		await registerRpivWorkflowSupport(cwd, join(cwd, "config"));
		const loaded = await loadWorkflows(cwd);
		const names = loaded.workflows.map((w) => w.name);
		expect(names).toEqual(expect.arrayContaining(["build", "ship", "vet", "polish"]));
		expect(loaded.issues.filter((i) => i.severity === "error")).toEqual([]);
	});
});
