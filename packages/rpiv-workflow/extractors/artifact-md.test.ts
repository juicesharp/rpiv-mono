/**
 * Tests for the artifact-md extractor — covers the I/O surface
 * (`readFileSync` on agent-announced path) including the existsSync gate,
 * the announced-but-missing-path case, and frontmatter parsing edge
 * cases. The extractor sits on the artifact-emit success path — its
 * fatal contract drives whether the runner halts or proceeds.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractorCtx } from "../manifest.js";
import { artifactMdExtractor } from "./artifact-md.js";

const branchWithText = (text: string) => [
	{
		type: "message" as const,
		message: {
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
			stopReason: "stop" as const,
		},
	},
];

const ctxOf = (cwd: string, branch: unknown): ExtractorCtx => ({
	cwd,
	runId: "test-run",
	stageIndex: 0,
	state: {
		originalInput: "",
		fallbackArtifactPath: undefined,
		manifest: undefined,
		stagesCompleted: 0,
		lastAllocatedStageNumber: 0,
		telemetry: {
			backwardJumps: 0,
			droppedRoutingRows: [],
		},
		termination: {
			success: false,
			error: undefined,
		},
	},
	branch: branch as ExtractorCtx["branch"],
	branchOffset: undefined,
	snapshot: undefined,
	skill: "research",
});

describe("artifactMdExtractor", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-md-ext-"));
		mkdirSync(join(tmpDir, ".rpiv", "artifacts", "research"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns fatal when no artifact path appears in the transcript", async () => {
		const ctx = ctxOf(tmpDir, branchWithText("I did not announce a path"));
		const result = await artifactMdExtractor.extract(ctx);
		expect(result.fatal).toMatch(/finished without producing a \.rpiv\/artifacts/);
		expect(result.payload).toBeUndefined();
	});

	it("returns fatal when the announced path does not exist on disk", async () => {
		const text = "Done: .rpiv/artifacts/research/missing.md";
		const ctx = ctxOf(tmpDir, branchWithText(text));
		const result = await artifactMdExtractor.extract(ctx);
		expect(result.fatal).toMatch(/file does not exist on disk/);
	});

	it("parses YAML frontmatter into payload.data and surfaces the artifact path", async () => {
		const rel = ".rpiv/artifacts/research/r.md";
		writeFileSync(join(tmpDir, rel), "---\nstatus: ok\nblockers_count: 0\n---\n\n# body\n");
		const ctx = ctxOf(tmpDir, branchWithText(`Wrote ${rel}`));
		const result = await artifactMdExtractor.extract(ctx);
		expect(result.fatal).toBeUndefined();
		expect(result.payload?.kind).toBe("artifact-md");
		expect(result.payload?.artifact_path).toBe(rel);
		expect(result.payload?.data).toMatchObject({ status: "ok", blockers_count: 0 });
	});

	it("returns empty data when the file exists but has no frontmatter", async () => {
		const rel = ".rpiv/artifacts/research/no-fm.md";
		writeFileSync(join(tmpDir, rel), "# no frontmatter here\n\nbody only\n");
		const ctx = ctxOf(tmpDir, branchWithText(`Wrote ${rel}`));
		const result = await artifactMdExtractor.extract(ctx);
		expect(result.fatal).toBeUndefined();
		expect(result.payload?.data).toEqual({});
	});

	it("returns the relative .rpiv/artifacts path even when the announcement embeds an absolute prefix", async () => {
		// ARTIFACT_PATH_REGEX matches only the `.rpiv/artifacts/...` substring,
		// so an announcement like `/abs/path/.rpiv/artifacts/.../x.md` yields
		// the relative tail. The extractor then joins it against `ctx.cwd`,
		// which is what every downstream consumer expects.
		const rel = ".rpiv/artifacts/research/abs.md";
		writeFileSync(join(tmpDir, rel), "---\nfoo: 1\n---\n");
		const abs = join(tmpDir, rel);
		const ctx = ctxOf(tmpDir, branchWithText(`Wrote ${abs}`));
		const result = await artifactMdExtractor.extract(ctx);
		expect(result.payload?.artifact_path).toBe(rel);
		expect(result.payload?.data).toMatchObject({ foo: 1 });
	});
});
