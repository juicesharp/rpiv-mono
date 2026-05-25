/**
 * Tests for the git-commit outcome — covers the collector + parser pair
 * on the success path, when git isn't on PATH, and when the working
 * tree isn't a git repo.
 *
 * The outcome is fail-soft by contract: every git error path collapses
 * to a `noOp: true` payload so the workflow keeps moving. These tests
 * pin that contract — a regression that converts a failure into a throw
 * would surface here as an unhandled rejection.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CollectCtx, ParseCtx, SnapshotCtx } from "../manifest.js";
import {
	type GitHeadSnapshot,
	gitCommitCollector,
	gitCommitOutcome,
	gitCommitParser,
	gitHeadSnapshot,
} from "./git-commit.js";

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
		primaryArtifact: undefined,
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

const collectCtx = (cwd: string, snapshot: GitHeadSnapshot | undefined): CollectCtx<GitHeadSnapshot | undefined> => ({
	...snapshotCtx(cwd),
	branch: [],
	branchOffset: undefined,
	snapshot,
	skill: "commit",
});

/**
 * Run the full outcome (collector → parser) end-to-end, returning the
 * commit data the parser produced. Mirrors what `produceAndValidateManifest`
 * does in the runner.
 */
const runOutcome = async (cwd: string, snapshot: GitHeadSnapshot | undefined) => {
	const ctx = collectCtx(cwd, snapshot);
	const collected = await gitCommitOutcome.collector.collect(ctx);
	if (collected.kind === "fatal") return collected;
	const parseCtx: ParseCtx<GitHeadSnapshot | undefined> = { ...ctx, artifacts: collected.artifacts };
	return gitCommitOutcome.parser!.parse(parseCtx);
};

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

describe.runIf(hasGit)("gitCommitOutcome end-to-end", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-git-ext-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("emits a real commit payload when HEAD moved between snapshot and collect", async () => {
		initRepo(tmpDir);
		const snap = await gitHeadSnapshot(snapshotCtx(tmpDir));
		expect(snap?.baselineSha).toMatch(/^[0-9a-f]{40}$/);

		writeFileSync(join(tmpDir, "a.txt"), "hello\n");
		execSync("git add a.txt", { cwd: tmpDir });
		execSync('git commit -q -m "add a"', { cwd: tmpDir });

		const result = await runOutcome(tmpDir, snap);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.payload.kind).toBe("git-commit");
		const data = result.payload.data;
		expect(data.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(data.prevSha).toBe(snap?.baselineSha);
		expect(data.subject).toBe("add a");
		expect(data.filesChanged).toBe(1);
		expect(data.noOp).toBeUndefined();
	});

	it("emits noOp payload when HEAD did not move", async () => {
		initRepo(tmpDir);
		const snap = await gitHeadSnapshot(snapshotCtx(tmpDir));
		const result = await runOutcome(tmpDir, snap);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.payload.data.noOp).toBe(true);
		expect(result.payload.data.prevSha).toBe(snap?.baselineSha);
	});

	it("emits noOp payload when snapshot is undefined (snapshot failure upstream)", async () => {
		const result = await runOutcome(tmpDir, undefined);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.payload.data.noOp).toBe(true);
	});

	it("emits noOp payload when cwd is not a git repo (collectCommitData returns null)", async () => {
		// Synthesize a snapshot with a fake baseline; collect runs in a non-repo cwd.
		const result = await runOutcome(tmpDir, { baselineSha: "deadbeef" });
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.payload.data.noOp).toBe(true);
	});
});

describe("gitCommitCollector always emits one artifact (the commit handle)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-git-res-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("emits role:'commit' opaque handle with the post-stage SHA (or empty when unavailable)", async () => {
		const collected = await gitCommitCollector.collect(collectCtx(tmpDir, { baselineSha: "abc" }));
		expect(collected.kind).toBe("ok");
		if (collected.kind !== "ok") return;
		expect(collected.artifacts).toHaveLength(1);
		expect(collected.artifacts[0]?.role).toBe("commit");
		expect(collected.artifacts[0]?.handle.kind).toBe("opaque");
	});
});

// Suppress unused-import lint when this file runs without git on PATH.
void existsSync;
void gitCommitParser;
