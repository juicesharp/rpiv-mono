import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GIT_CHANGES_MJS = fileURLToPath(new URL("./git-changes.mjs", import.meta.url));

const run = (cwd: string) =>
	execFileSync("node", [GIT_CHANGES_MJS], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	});

const gitIn = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });

const initRepo = (cwd: string) => {
	gitIn(cwd, "init", "--initial-branch=main", "-q");
	gitIn(cwd, "config", "user.email", "test@example.com");
	gitIn(cwd, "config", "user.name", "Test User");
	gitIn(cwd, "config", "commit.gpgsign", "false");
};

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rpiv-git-changes-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("git-changes.mjs", () => {
	it("emits `in_repo: no` and exits when cwd is not a git repo", () => {
		const out = run(dir);
		expect(out).toContain("in_repo: no");
		expect(out).not.toContain("---status---");
		expect(out).not.toContain("---diffstat---");
	});

	it("emits no-HEAD fallback for an initialized repo with zero commits", () => {
		initRepo(dir);
		writeFileSync(join(dir, "f.txt"), "hi");
		gitIn(dir, "add", "f.txt");
		const out = run(dir);
		expect(out).toContain("in_repo: yes");
		expect(out).toContain("---status---");
		expect(out).toMatch(/^A\s+f\.txt$/m);
		expect(out).toContain("---diffstat---");
		expect(out).toContain("(no HEAD yet");
	});

	it("emits `(working tree clean)` when status is empty against HEAD", () => {
		initRepo(dir);
		writeFileSync(join(dir, "f.txt"), "hi");
		gitIn(dir, "add", "f.txt");
		gitIn(dir, "commit", "-m", "init", "-q");
		const out = run(dir);
		expect(out).toContain("---status---\n(working tree clean)");
		expect(out).toContain("---diffstat---");
		expect(out).toContain("(no changes against HEAD)");
	});

	it("emits diffstat lines when there are committed-tree differences", () => {
		initRepo(dir);
		writeFileSync(join(dir, "f.txt"), "hi");
		gitIn(dir, "add", "f.txt");
		gitIn(dir, "commit", "-m", "init", "-q");
		writeFileSync(join(dir, "f.txt"), "hi\nworld\n");
		const out = run(dir);
		const diffstatBlock = out.slice(out.indexOf("---diffstat---"));
		expect(diffstatBlock).toMatch(/f\.txt\s*\|\s*\d+/);
	});

	it("caps status at 200 files with `(... N more files truncated ...)` footer", () => {
		initRepo(dir);
		writeFileSync(join(dir, ".gitignore"), "");
		gitIn(dir, "add", ".gitignore");
		gitIn(dir, "commit", "-m", "init", "-q");
		// Create 250 untracked files — `git status --short` lists each as `?? path`.
		for (let i = 0; i < 250; i++) writeFileSync(join(dir, `f${i}.txt`), "");
		const out = run(dir);
		const statusBlock = out.slice(out.indexOf("---status---"), out.indexOf("---diffstat---"));
		const statusLines = statusBlock.split("\n").filter((l) => l.startsWith("??"));
		expect(statusLines).toHaveLength(200);
		expect(statusBlock).toContain("(... 50 more files truncated ...)");
	});

	it("caps diffstat at 200 lines with truncation footer (I4 — symmetry with status cap)", () => {
		initRepo(dir);
		// Seed 250 files committed at HEAD, then modify all of them so
		// `git diff HEAD --stat` produces 250+ lines (one per file + summary).
		writeFileSync(join(dir, ".gitignore"), "");
		gitIn(dir, "add", ".gitignore");
		for (let i = 0; i < 250; i++) writeFileSync(join(dir, `f${i}.txt`), "a\n");
		gitIn(dir, "add", "-A");
		gitIn(dir, "commit", "-m", "seed", "-q");
		for (let i = 0; i < 250; i++) writeFileSync(join(dir, `f${i}.txt`), "b\nc\n");
		const out = run(dir);
		const diffstatBlock = out.slice(out.indexOf("---diffstat---"));
		expect(diffstatBlock).toContain("more files truncated ...)");
	});

	// Finding 9 — a workflow must commit only the work it produced. Files that were
	// ALREADY dirty before the run (recorded in the run-start baseline) are fenced
	// out of the in-scope status so the commit skill never sweeps them into a commit.
	it("excludes a pre-existing (baseline-recorded) file from ---status--- and fences it off", () => {
		initRepo(dir);
		writeFileSync(join(dir, ".gitignore"), "");
		gitIn(dir, "add", ".gitignore");
		gitIn(dir, "commit", "-m", "init", "-q");
		// `blog.md` was dirty BEFORE the run; `src.ts` is the run's own work.
		writeFileSync(join(dir, "blog.md"), "unrelated edit\n");
		writeFileSync(join(dir, "src.ts"), "the run's own change\n");
		mkdirSync(join(dir, ".rpiv/artifacts"), { recursive: true });
		writeFileSync(join(dir, ".rpiv/artifacts/commit-baseline.json"), JSON.stringify({ paths: ["blog.md"] }));

		const out = run(dir);
		const statusBlock = out.slice(out.indexOf("---status---"), out.indexOf("---pre-existing"));
		// In-scope status carries the run's own file, NOT the pre-existing one.
		expect(statusBlock).toMatch(/src\.ts/);
		expect(statusBlock).not.toMatch(/blog\.md/);
		// The pre-existing file is surfaced under a fenced "do NOT commit" section.
		expect(out).toContain("---pre-existing (do NOT commit");
		const preBlock = out.slice(out.indexOf("---pre-existing"));
		expect(preBlock).toMatch(/blog\.md/);
	});

	it("without a baseline file, behaves exactly as before (no pre-existing section)", () => {
		initRepo(dir);
		writeFileSync(join(dir, ".gitignore"), "");
		gitIn(dir, "add", ".gitignore");
		gitIn(dir, "commit", "-m", "init", "-q");
		writeFileSync(join(dir, "src.ts"), "x\n");
		const out = run(dir);
		expect(out).not.toContain("---pre-existing");
		expect(out.slice(out.indexOf("---status---"))).toMatch(/src\.ts/);
	});
});
