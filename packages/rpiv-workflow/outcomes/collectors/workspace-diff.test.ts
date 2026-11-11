import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPECTED_VCS_STATUS_ENTRIES, hasJj, seedJjStatusWorkspace } from "@juicesharp/rpiv-test-utils/vcs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CollectContext, SnapshotContext } from "../../output-spec.ts";
import { parsePorcelain, type WorkspaceDiffSnapshot, workspaceDiffCollector } from "./workspace-diff.ts";

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

const snapshotCtxOf = (cwd: string): SnapshotContext => ({
	cwd,
	runId: "test",
	stageIndex: 0,
	state: {} as never,
});

const collectCtxOf = (
	cwd: string,
	snapshot: WorkspaceDiffSnapshot | undefined,
): CollectContext<WorkspaceDiffSnapshot | undefined> => ({
	...snapshotCtxOf(cwd),
	branch: [],
	branchOffset: undefined,
	snapshot,
	skill: "test",
});

describe("parsePorcelain", () => {
	it("keys plain lines by path, keeping the full two-char code including a leading space", () => {
		const map = parsePorcelain(" M a.txt\nMM b.txt\n?? c.md");
		expect(map.get("a.txt")).toBe(" M");
		expect(map.get("b.txt")).toBe("MM");
		expect(map.get("c.md")).toBe("??");
	});

	it("normalises rename records to the new path", () => {
		const map = parsePorcelain("R  old-name.txt -> new-name.txt");
		expect(map.has("old-name.txt")).toBe(false);
		expect(map.get("new-name.txt")).toBe("R ");
	});

	it("strips wrapping quotes from cquote-escaped paths", () => {
		const map = parsePorcelain('?? "quoted name.txt"');
		expect(map.get("quoted name.txt")).toBe("??");
	});

	it("decodes a cquote-escaped path to its on-disk spelling", () => {
		const map = parsePorcelain('?? "caf\\303\\251.ts"');
		expect(map.get("café.ts")).toBe("??");
	});

	it("splits the rename arrow before stripping quotes (a quoted rename keys the unquoted new path)", () => {
		const map = parsePorcelain('R  "old n.txt" -> "new n.txt"');
		expect(map.get("new n.txt")).toBe("R ");
	});

	it("skips lines shorter than code + separator + one path char (blank lines; the 3-char boundary)", () => {
		const map = parsePorcelain("\n\n M ok.txt\n?? \nabc");
		expect(map.size).toBe(1);
		expect(map.get("ok.txt")).toBe(" M");
	});
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

	it("collects a file a stage created inside a pre-existing untracked directory", async () => {
		initRepo(tmpDir);
		mkdirSync(join(tmpDir, "nested"), { recursive: true });
		writeFileSync(join(tmpDir, "nested/preexisting.txt"), "x");
		const collector = workspaceDiffCollector();
		const snapshot = await collector.snapshot?.(snapshotCtxOf(tmpDir));
		writeFileSync(join(tmpDir, "nested/created.txt"), "y");

		const result = await collector.collect(collectCtxOf(tmpDir, snapshot));
		expect(
			result.kind === "ok" && result.artifacts.map((a) => (a.handle.kind === "fs" ? a.handle.path : "")),
		).toEqual(["nested/created.txt"]);
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

	it("fatal when git worked at snapshot time but fails after the stage — no fabricated 'no changes'", async () => {
		initRepo(tmpDir);
		const collector = workspaceDiffCollector();
		const snapshot = await collector.snapshot?.(snapshotCtxOf(tmpDir));
		expect(snapshot).toBeDefined();
		// Simulate the environment breaking mid-stage: the repo (and cwd)
		// vanish between snapshot and collect.
		rmSync(tmpDir, { recursive: true, force: true });
		const result = await collector.collect(collectCtxOf(tmpDir, snapshot));
		expect(result.kind).toBe("fatal");
		expect(result.kind === "fatal" && result.message).toMatch(/git status worked at snapshot time but failed after/);
	});
});

describe.runIf(hasJj())("workspaceDiffCollector — jj workspace parity", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-wd-jj-"));
		seedJjStatusWorkspace(tmpDir);
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("collects the seeded working-copy entries with the same XY codes git produces", async () => {
		// Rewind the seeded working copy (back to its baseline commit) so the
		// snapshot sees a clean tree, then re-apply the fixture's edits as
		// "the stage" — the collected delta is exactly the seeded entry set.
		execSync("jj restore", { cwd: tmpDir, stdio: "ignore" });
		const collector = workspaceDiffCollector();
		const snapshot = await collector.snapshot?.(snapshotCtxOf(tmpDir));
		writeFileSync(join(tmpDir, "modified.ts"), "two\n");
		rmSync(join(tmpDir, "deleted.ts"));
		rmSync(join(tmpDir, "old.ts"));
		writeFileSync(join(tmpDir, "new.ts"), "renamed\n");
		writeFileSync(join(tmpDir, "added.ts"), "new\n");

		const result = await collector.collect(collectCtxOf(tmpDir, snapshot));
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		const entries = result.artifacts
			.map((a) => ({
				path: a.handle.kind === "fs" ? a.handle.path : "",
				xy: (a.meta?.gitStatus as string) ?? "",
			}))
			.sort((a, b) => a.path.localeCompare(b.path));
		expect(entries).toEqual([...EXPECTED_VCS_STATUS_ENTRIES].sort((a, b) => a.path.localeCompare(b.path)));
	});
});
