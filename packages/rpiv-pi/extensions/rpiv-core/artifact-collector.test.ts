import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BranchEntry, fs as fsHandle, opaque, type ParseContext } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { frontmatterParser, rpivArtifactCollector, rpivBucketCollector } from "./artifact-collector.js";

const ctxOf = (cwd: string, artifacts: ParseContext<undefined>["artifacts"]): ParseContext<undefined> => ({
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

const asst = (text: string): BranchEntry => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

const collectCtxOf = (branch: BranchEntry[]) => ({
	cwd: "/tmp",
	runId: "test",
	stageIndex: 0,
	state: {} as never,
	branch,
	branchOffset: undefined,
	snapshot: undefined,
	skill: "elaborate",
});

// Regression: run 2026-08-20_18-10-39-17e7, code (phase 5/9). The agent
// announced its real artifact, then referred to a SIBLING phase's artifact with
// a prose ellipsis ("`.rpiv/artifacts/elaborations/...__phase-4.md`") — a valid
// [\w.-]+ string under the old pattern, so the last-match scan collected the
// elided path and fataled the stage on a file that never existed, silently
// dropping the real 30KB elaboration. The tempered pattern refuses ".." in any
// segment, so the elided mention no longer outranks the real announcement.
describe("rpivArtifactCollector — ellipsis-proof pattern", () => {
	const REAL = ".rpiv/artifacts/elaborations/2026-08-20_20-58-43_review-remediation__phase-5.md";

	it("still collects a normal timestamped artifact path", async () => {
		const result = await rpivArtifactCollector.collect(collectCtxOf([asst(`**Path:** \`${REAL}\``)]));
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({ kind: "fs", path: REAL });
	});

	it("ignores an elided sibling path mentioned after the real announcement", async () => {
		const text = `**Path:** \`${REAL}\`\n\nAnchored against Phase 4's landed artifact (\`.rpiv/artifacts/elaborations/...__phase-4.md\`).`;
		const result = await rpivArtifactCollector.collect(collectCtxOf([asst(text)]));
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({ kind: "fs", path: REAL });
	});

	it("ignores a mid-path elision (timestamp elided) too", async () => {
		const text = `**Path:** \`${REAL}\`\n\nDeltas vs \`.rpiv/artifacts/elaborations/2026-...-remediation__phase-4.md\`.`;
		const result = await rpivArtifactCollector.collect(collectCtxOf([asst(text)]));
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({ kind: "fs", path: REAL });
	});

	it("fatals (no match) when only elided paths appear — never collects one", async () => {
		const result = await rpivArtifactCollector.collect(
			collectCtxOf([asst("see `.rpiv/artifacts/elaborations/...__phase-4.md`")]),
		);
		expect(result.kind).toBe("fatal");
	});

	it("rpivBucketCollector applies the same tempered filename segment", async () => {
		const text = `**Path:** \`${REAL}\`\n\n(vs \`.rpiv/artifacts/elaborations/...__phase-4.md\`)`;
		const result = await rpivBucketCollector("elaborations").collect(collectCtxOf([asst(text)]));
		expect(result.kind === "ok" && result.artifacts[0]?.handle).toEqual({ kind: "fs", path: REAL });
	});
});
