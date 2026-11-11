import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasJj, seedJjStatusWorkspace } from "@juicesharp/rpiv-test-utils/vcs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GIT_CONTEXT_MJS = fileURLToPath(new URL("./git-context.mjs", import.meta.url));

// Spawn git-context.mjs with `cwd` overridden so the helper resolves the
// passed tmpdir (not the test runner's repo root).
const runIn = (cwd: string) =>
	execFileSync("node", [GIT_CONTEXT_MJS], {
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
	dir = mkdtempSync(join(tmpdir(), "rpiv-git-context-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("git-context.mjs", () => {
	it("emits seven labeled lines for a fresh repo with one commit", () => {
		initRepo(dir);
		writeFileSync(join(dir, "f.txt"), "hello");
		gitIn(dir, "add", "f.txt");
		gitIn(dir, "commit", "-m", "init", "-q");

		const out = runIn(dir);
		const lines = out.split("\n");
		// macOS `mkdtempSync` returns `/var/folders/...` but `git rev-parse
		// --show-toplevel` normalises symlinks to `/private/var/folders/...`.
		// Compare against realpath so the test is platform-stable.
		const realDir = realpathSync(dir);
		expect(lines).toContain("vcs: git");
		expect(lines).toContain("branch: main");
		expect(lines.some((l) => /^commit: [0-9a-f]{7,}$/.test(l))).toBe(true);
		expect(lines).toContain(`repo: ${basename(realDir)}`);
		expect(lines).toContain(`root: ${realDir}`);
		expect(lines).toContain("in_repo: yes");
		expect(lines).toContain("author: Test User");
	});

	it("falls back gracefully when cwd is not a git repo", () => {
		// No `git init` — `git rev-parse --show-toplevel` fails.
		const out = runIn(dir);
		const lines = out.split("\n");
		expect(lines).toContain("branch: no-branch");
		expect(lines).toContain("commit: no-commit");
		expect(lines).toContain("repo: unknown");
		expect(lines).toContain("root: ");
		expect(lines).toContain("in_repo: no");
		// `author:` may be "unknown" or pulled from global git config — the
		// helper falls back to `unknown` when `git config user.name` errors
		// (which it doesn't when global config is present). Either is OK; the
		// contract is just that the line is emitted.
		expect(lines.some((l) => l.startsWith("author: "))).toBe(true);
	});

	it("exits 0 in both repo and non-repo cwds (never surfaces [Shell error])", () => {
		expect(() => runIn(dir)).not.toThrow();
		initRepo(dir);
		expect(() => runIn(dir)).not.toThrow();
	});

	it("emits a trailing newline so chained helpers parse on their own line", () => {
		initRepo(dir);
		writeFileSync(join(dir, "f.txt"), "hello");
		gitIn(dir, "add", "f.txt");
		gitIn(dir, "commit", "-m", "init", "-q");
		const out = runIn(dir);
		expect(out.endsWith("\n")).toBe(true);
	});

	describe.runIf(hasJj())("jj workspace", () => {
		beforeEach(() => seedJjStatusWorkspace(dir));

		it("reports the jj backend with a real working-copy commit and author", () => {
			const lines = runIn(dir).split("\n");
			expect(lines).toContain("vcs: jj");
			expect(lines).toContain("in_repo: yes");
			expect(lines.some((l) => /^commit: [0-9a-f]{7,}$/.test(l))).toBe(true);
			const author = lines.find((l) => l.startsWith("author: "));
			expect(author).toBeDefined();
			expect(author).not.toBe("author: unknown");
		});
	});
});
