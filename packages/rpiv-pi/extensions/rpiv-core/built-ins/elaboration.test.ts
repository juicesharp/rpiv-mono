import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fs as fsHandle, type ParseContext } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { elaborationOutcome, elaborationParser, elaborationStructure } from "./elaboration.js";
import { openFenceLine } from "./markdown-fence.js";

// A balanced elaboration: one phase heading, fenced code closed by a bare ```.
const BALANCED = [
	"---",
	"phase_n: 1",
	"status: ready",
	"---",
	"",
	"## Phase 1: First",
	"#### `x.ts`",
	"```ts",
	"## Phase 9: fixture text inside a fence",
	"```",
	"",
].join("\n");

// The embed that leaks: a markdown file with its own ``` blocks wrapped in a
// three-backtick fence — the inner closer ends the outer fence at line 10 and the
// intended outer closer at line 13 opens one that never closes.
const LEAKED = [
	"---",
	"phase_n: 1",
	"status: ready",
	"---",
	"",
	"## Phase 1: First",
	"```markdown",
	"# guide",
	"```ts",
	"```",
	"prose",
	"```",
	"",
].join("\n");

describe("openFenceLine", () => {
	it("is undefined for balanced fences and names the opener line otherwise", () => {
		expect(openFenceLine(BALANCED)).toBeUndefined();
		expect(openFenceLine(LEAKED)).toBe(12);
		expect(
			openFenceLine(LEAKED.replace("```markdown", "````markdown").replace("prose\n```", "prose\n````")),
		).toBeUndefined();
	});
});

describe("elaborationStructure", () => {
	it("reports a balanced walk and the single out-of-fence phase heading", () => {
		expect(elaborationStructure(BALANCED)).toEqual({ fence_walk: "balanced", phase_headings: 1 });
	});

	it("carries the opener line and the four-backtick fix in the fence_walk value", () => {
		const { fence_walk, phase_headings } = elaborationStructure(LEAKED);
		expect(fence_walk).toMatch(/^open from line 12 /);
		expect(fence_walk).toContain("four backticks");
		expect(phase_headings).toBe(1);
	});

	it("counts a second heading as a splice-anchor violation", () => {
		expect(elaborationStructure(`${BALANCED}\n## Phase 2: Second\n`).phase_headings).toBe(2);
	});
});

describe("elaborationParser", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "rpiv-elaboration-"));
		mkdirSync(join(cwd, ".rpiv", "artifacts", "elaborations"), { recursive: true });
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	const parse = (content: string) => {
		const rel = ".rpiv/artifacts/elaborations/demo__phase-1.md";
		writeFileSync(join(cwd, rel), content);
		return elaborationParser.parse({
			cwd,
			skill: "elaborate",
			artifacts: [{ handle: fsHandle(rel), role: "primary" }],
		} as unknown as ParseContext<undefined>);
	};

	it("merges the derived structure beside the frontmatter", async () => {
		const result = await parse(BALANCED);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.payload.data).toMatchObject({ status: "ready", fence_walk: "balanced", phase_headings: 1 });
	});

	it("lets the derived value win over an authored fence_walk", async () => {
		const result = await parse(LEAKED.replace("status: ready", "status: ready\nfence_walk: balanced"));
		if (result.kind !== "ok") throw new Error(result.message);
		expect(result.payload.data.fence_walk).toMatch(/^open from line 13 /);
	});

	it("keeps the frontmatter parser's fatal when the announced file is missing", async () => {
		const result = await elaborationParser.parse({
			cwd,
			skill: "elaborate",
			artifacts: [{ handle: fsHandle(".rpiv/artifacts/elaborations/absent.md"), role: "primary" }],
		} as unknown as ParseContext<undefined>);
		expect(result.kind).toBe("fatal");
	});
});

describe("elaborationOutcome", () => {
	it("publishes on the elaborations channel with the structural parser", () => {
		expect(elaborationOutcome.name).toBe("elaborations");
		expect(elaborationOutcome.parser).toBe(elaborationParser);
	});
});
