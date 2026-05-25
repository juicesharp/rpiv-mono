import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CollectCtx, SnapshotCtx } from "../../outcome-types.js";
import { type WorkspaceDiffSnapshot, workspaceDiffCollector } from "./workspace-diff.js";

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

const snapshotCtxOf = (cwd: string): SnapshotCtx => ({
	cwd,
	runId: "test",
	stageIndex: 0,
	state: {} as never,
});

const collectCtxOf = (
	cwd: string,
	snapshot: WorkspaceDiffSnapshot | undefined,
): CollectCtx<WorkspaceDiffSnapshot | undefined> => ({
	...snapshotCtxOf(cwd),
	branch: [],
	branchOffset: undefined,
	snapshot,
	skill: "test",
});

describe.runIf(hasGit)("workspaceDiffCollector", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-wd-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("emits one fs artifact per file written during the stage", async () => {
		initRepo(tmpDir);
		const collector = workspaceDiffCollector();
		const snapshot = await collector.snapshot?.(snapshotCtxOf(tmpDir));
		// Write two files post-snapshot.
		writeFileSync(join(tmpDir, "a.txt"), "hello");
		writeFileSync(join(tmpDir, "b.txt"), "world");

		const result = await collector.collect(collectCtxOf(tmpDir, snapshot));
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		const paths = result.artifacts.map((a) => (a.handle.kind === "fs" ? a.handle.path : "")).sort();
		expect(paths).toEqual(["a.txt", "b.txt"]);
		// Every artifact's role and meta hint come from the collector, not the user.
		expect(result.artifacts[0]?.role).toBe("changed");
		expect(result.artifacts[0]?.meta?.gitStatus).toBe("??");
	});

	it("skips files whose status was unchanged from snapshot (untouched files don't count)", async () => {
		initRepo(tmpDir);
		// Pre-snapshot file — already untracked.
		writeFileSync(join(tmpDir, "preexisting.txt"), "x");
		const collector = workspaceDiffCollector();
		const snapshot = await collector.snapshot?.(snapshotCtxOf(tmpDir));

		// Write a NEW file during the "stage."
		writeFileSync(join(tmpDir, "new.txt"), "y");

		const result = await collector.collect(collectCtxOf(tmpDir, snapshot));
		expect(
			result.kind === "ok" && result.artifacts.map((a) => (a.handle.kind === "fs" ? a.handle.path : "")),
		).toEqual(["new.txt"]);
	});

	it("applies the optional filter", async () => {
		initRepo(tmpDir);
		const collector = workspaceDiffCollector({ filter: (p) => p.endsWith(".md") });
		const snapshot = await collector.snapshot?.(snapshotCtxOf(tmpDir));
		writeFileSync(join(tmpDir, "a.txt"), "x");
		writeFileSync(join(tmpDir, "b.md"), "y");

		const result = await collector.collect(collectCtxOf(tmpDir, snapshot));
		expect(
			result.kind === "ok" && result.artifacts.map((a) => (a.handle.kind === "fs" ? a.handle.path : "")),
		).toEqual(["b.md"]);
	});

	it("fail-soft: cwd is not a git repo → snapshot undefined → collect returns empty", async () => {
		const collector = workspaceDiffCollector();
		const snapshot = await collector.snapshot?.(snapshotCtxOf(tmpDir));
		expect(snapshot).toBeUndefined();
		const result = await collector.collect(collectCtxOf(tmpDir, snapshot));
		expect(result.kind === "ok" && result.artifacts).toEqual([]);
	});
});
