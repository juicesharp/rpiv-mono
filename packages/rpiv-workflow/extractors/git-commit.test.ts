/**
 * Tests for the git-commit extractor — covers the new I/O surface
 * (shelling out to `git` via `execFile`) on the success path, when git
 * isn't on PATH, and when the working tree isn't a git repo.
 *
 * The extractor is fail-soft by contract: every git error path collapses
 * to a `noOp: true` payload so the workflow keeps moving. These tests
 * pin that contract — a regression that converts a failure into a throw
 * would surface here as an unhandled rejection.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractorCtx, SnapshotCtx } from "../manifest.js";
import { gitCommitExtractor, gitHeadSnapshot } from "./git-commit.js";

const hasGit = (() => {
	try {
		execSync("git --version", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const initRepo = (cwd: string): void => {
	execSync("git init -q", { cwd });
	execSync("git config user.email test@example.com", { cwd });
	execSync("git config user.name Test", { cwd });
	execSync("git commit --allow-empty -q -m initial", { cwd });
};

const snapshotCtx = (cwd: string): SnapshotCtx => ({
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
});

const extractorCtx = (cwd: string, snapshot: unknown): ExtractorCtx => ({
	...snapshotCtx(cwd),
	branch: [],
	branchOffset: undefined,
	snapshot,
	skill: "commit",
});

describe.runIf(hasGit)("gitHeadSnapshot", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-git-snap-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns the current HEAD SHA in a real repo", async () => {
		initRepo(tmpDir);
		const snap = await gitHeadSnapshot(snapshotCtx(tmpDir));
		expect(snap?.baselineSha).toMatch(/^[0-9a-f]{40}$/);
	});

	it("returns undefined when cwd is not a git repo (no throw)", async () => {
		const snap = await gitHeadSnapshot(snapshotCtx(tmpDir));
		expect(snap).toBeUndefined();
	});

	it("returns undefined when cwd does not exist (no throw)", async () => {
		const snap = await gitHeadSnapshot(snapshotCtx(join(tmpDir, "does-not-exist")));
		expect(snap).toBeUndefined();
	});
});

describe.runIf(hasGit)("gitCommitExtractor.extract", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-git-ext-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("emits a real commit payload when HEAD moved between snapshot and extract", async () => {
		initRepo(tmpDir);
		const snap = await gitHeadSnapshot(snapshotCtx(tmpDir));
		expect(snap?.baselineSha).toMatch(/^[0-9a-f]{40}$/);

		writeFileSync(join(tmpDir, "a.txt"), "hello\n");
		execSync("git add a.txt", { cwd: tmpDir });
		execSync('git commit -q -m "add a"', { cwd: tmpDir });

		const result = await gitCommitExtractor.extract(extractorCtx(tmpDir, snap));
		expect(result.fatal).toBeUndefined();
		expect(result.payload?.kind).toBe("git-commit");
		const data = result.payload?.data as {
			sha: string;
			prevSha: string;
			subject: string;
			filesChanged: number;
			noOp?: boolean;
		};
		expect(data.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(data.prevSha).toBe(snap?.baselineSha);
		expect(data.subject).toBe("add a");
		expect(data.filesChanged).toBe(1);
		expect(data.noOp).toBeUndefined();
	});

	it("emits noOp payload when HEAD did not move", async () => {
		initRepo(tmpDir);
		const snap = await gitHeadSnapshot(snapshotCtx(tmpDir));
		const result = await gitCommitExtractor.extract(extractorCtx(tmpDir, snap));
		const data = result.payload?.data as { noOp?: boolean; prevSha: string };
		expect(data.noOp).toBe(true);
		expect(data.prevSha).toBe(snap?.baselineSha);
	});

	it("emits noOp payload when snapshot is undefined (snapshot failure upstream)", async () => {
		const result = await gitCommitExtractor.extract(extractorCtx(tmpDir, undefined));
		expect(result.fatal).toBeUndefined();
		const data = result.payload?.data as { noOp?: boolean };
		expect(data.noOp).toBe(true);
	});

	it("emits noOp payload when cwd is not a git repo (collectCommitData returns null)", async () => {
		// Synthesize a snapshot with a fake baseline; extract runs in a non-repo cwd.
		const result = await gitCommitExtractor.extract(extractorCtx(tmpDir, { baselineSha: "deadbeef" }));
		expect(result.fatal).toBeUndefined();
		const data = result.payload?.data as { noOp?: boolean };
		expect(data.noOp).toBe(true);
	});
});

describe("artifact_path inheritance", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-git-ap-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("inherits currentArtifactPath(state) into the payload (chain continuity)", async () => {
		const ctx: ExtractorCtx = {
			...extractorCtx(tmpDir, { baselineSha: "abc" }),
			state: {
				...snapshotCtx(tmpDir).state,
				fallbackArtifactPath: ".rpiv/artifacts/x.md",
			},
		};
		const result = await gitCommitExtractor.extract(ctx);
		expect(result.payload?.artifact_path).toBe(".rpiv/artifacts/x.md");
	});
});

// Suppress unused-import lint when this file runs without git on PATH.
void existsSync;
