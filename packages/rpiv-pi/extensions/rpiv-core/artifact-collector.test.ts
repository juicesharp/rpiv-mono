import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fs as fsHandle, opaque, type ParseCtx } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { frontmatterParser } from "./artifact-collector.js";

const ctxOf = (cwd: string, artifacts: ParseCtx<undefined>["artifacts"]): ParseCtx<undefined> => ({
	cwd,
	runId: "test",
	stageIndex: 0,
	state: {} as never,
	branch: [],
	branchOffset: undefined,
	snapshot: undefined,
	skill: "architecture-review",
	artifacts,
});

describe("frontmatterParser", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-frontmatter-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("parses well-formed frontmatter into data", async () => {
		writeFileSync(join(tmpDir, "ok.md"), "---\ntarget: packages/rpiv-pi\nlayer_count: 6\n---\n\n# Body\n");
		const ctx = ctxOf(tmpDir, [{ handle: fsHandle("ok.md") }]);
		const result = await frontmatterParser.parse(ctx);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.payload.kind).toBe("artifact-md");
		expect(result.payload.data).toEqual({ target: "packages/rpiv-pi", layer_count: 6 });
	});

	it("degrades to {} for a file with no frontmatter", async () => {
		writeFileSync(join(tmpDir, "plain.md"), "# Just a heading\n\nno frontmatter here\n");
		const ctx = ctxOf(tmpDir, [{ handle: fsHandle("plain.md") }]);
		const result = await frontmatterParser.parse(ctx);
		expect(result.kind === "ok" && result.payload.data).toEqual({});
	});

	// Regression: run 2026-06-19_14-51-17-6508. The architecture-review agent
	// wrote `target: …/ (lane UI: L0–L2) + …` — an unquoted scalar with a bare
	// `: ` that YAML reads as a nested mapping. parseFrontmatter throws on it;
	// the old parser let that throw escape and fatal the whole workflow on its
	// FIRST stage, discarding the entire review. It must now degrade to {}.
	it("degrades to {} instead of throwing on malformed YAML (unquoted ': ' in a scalar)", async () => {
		const malformed = [
			"---",
			"template_version: 1",
			"target: packages/rpiv-pi/extensions/rpiv-core/ (lane UI: L0–L2) + packages/rpiv-workflow/ (runner: L3–L5)",
			"status: ready",
			"---",
			"",
			"# Architecture review",
		].join("\n");
		writeFileSync(join(tmpDir, "bad.md"), malformed);
		const ctx = ctxOf(tmpDir, [{ handle: fsHandle("bad.md") }]);
		const result = await frontmatterParser.parse(ctx);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.payload.data).toEqual({});
	});

	it("fatals when the primary artifact isn't an fs handle", async () => {
		const ctx = ctxOf(tmpDir, [{ handle: opaque("not-fs") }]);
		const result = await frontmatterParser.parse(ctx);
		expect(result.kind).toBe("fatal");
		if (result.kind !== "fatal") return;
		expect(result.message).toMatch(/requires an fs artifact/);
	});

	it("fatals when the announced file doesn't exist on disk", async () => {
		const ctx = ctxOf(tmpDir, [{ handle: fsHandle("missing.md") }]);
		const result = await frontmatterParser.parse(ctx);
		expect(result.kind).toBe("fatal");
		if (result.kind !== "fatal") return;
		expect(result.message).toMatch(/does not exist on disk/);
	});
});
