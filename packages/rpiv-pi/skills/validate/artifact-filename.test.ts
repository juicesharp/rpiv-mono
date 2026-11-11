import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skill = readFileSync(fileURLToPath(new URL("./SKILL.md", import.meta.url)), "utf8");

describe("validate artifact filename", () => {
	it("names the report after the plan file, not the free-form topic", () => {
		expect(skill).toContain("`.rpiv/artifacts/validation/<slug>_<plan-name>.md`");
		expect(skill).toContain("`<plan-name>` is the plan file's basename without its leading timestamp and `.md`");
		expect(skill).not.toContain("<plan-topic-kebab>");
	});
});
