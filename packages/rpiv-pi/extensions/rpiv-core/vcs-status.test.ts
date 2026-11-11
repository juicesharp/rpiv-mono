import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPECTED_VCS_STATUS_ENTRIES, hasJj, seedJjStatusWorkspace } from "@juicesharp/rpiv-test-utils/vcs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectVcs, jjSummaryToEntries, vcsCommittedPaths, vcsDiffText, vcsStatusEntries } from "./vcs-status.ts";

const gitIn = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });

const jjIn = (cwd: string, ...args: string[]) =>
	execFileSync("jj", ["--no-pager", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });

const initRepo = (cwd: string) => {
	gitIn(cwd, "init", "-q");
	gitIn(cwd, "config", "user.email", "test@example.com");
	gitIn(cwd, "config", "user.name", "Test User");
	gitIn(cwd, "config", "commit.gpgsign", "false");
};

describe("jjSummaryToEntries", () => {
	it("maps every jj summary letter into the XY grammar", () => {
		expect(jjSummaryToEntries("M a.ts\nA b.ts\nD c.ts\nR {old.ts => new.ts}")).toEqual([
			{ xy: " M", path: "a.ts" },
			{ xy: "??", path: "b.ts" },
			{ xy: " D", path: "c.ts" },
			{ xy: " R", path: "new.ts" },
		]);
	});
});

describe("vcsStatusEntries — git", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rpiv-vcs-status-git-"));
		initRepo(dir);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("enumerates untracked files individually, never a collapsed directory", () => {
		mkdirSync(join(dir, "nested"), { recursive: true });
		writeFileSync(join(dir, "nested/a.ts"), "a\n");
		writeFileSync(join(dir, "nested/b.ts"), "b\n");
		expect(
			vcsStatusEntries(dir)
				.map((e) => e.path)
				.sort(),
		).toEqual(["nested/a.ts", "nested/b.ts"]);
	});

	it("decodes a cquote-escaped path to its on-disk spelling", () => {
		writeFileSync(join(dir, "café.ts"), "x\n");
		expect(vcsStatusEntries(dir).map((e) => e.path)).toContain("café.ts");
	});

	it("removes bookkeeping paths from the universe", () => {
		mkdirSync(join(dir, ".rpiv/artifacts"), { recursive: true });
		writeFileSync(join(dir, ".rpiv/artifacts/report.md"), "r\n");
		mkdirSync(join(dir, "thoughts"), { recursive: true });
		writeFileSync(join(dir, "thoughts/note.md"), "n\n");
		writeFileSync(join(dir, "src.ts"), "s\n");
		expect(vcsStatusEntries(dir).map((e) => e.path)).toEqual(["src.ts"]);
	});

	it("accepts a captured backend and skips the probe", () => {
		writeFileSync(join(dir, "src.ts"), "s\n");
		expect(vcsStatusEntries(dir, "git").map((e) => e.path)).toEqual(["src.ts"]);
		expect(vcsStatusEntries(dir, "none")).toEqual([]);
	});
});

describe("vcsDiffText — git", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rpiv-vcs-diff-git-"));
		initRepo(dir);
		writeFileSync(join(dir, "src.ts"), "one\n");
		gitIn(dir, "add", ".");
		gitIn(dir, "commit", "-q", "-m", "seed");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("keeps a code hunk and drops a bookkeeping hunk", () => {
		writeFileSync(join(dir, "src.ts"), "two\n");
		mkdirSync(join(dir, ".rpiv/artifacts"), { recursive: true });
		writeFileSync(join(dir, ".rpiv/artifacts/report.md"), "r\n");
		// `-f`: a developer machine may carry a global `.rpiv/` ignore entry, and
		// the strip must be exercised whether or not the repo ignores the tree.
		gitIn(dir, "add", "-A", "-f");
		const patch = vcsDiffText(dir);
		expect(patch).toContain("src.ts");
		expect(patch).not.toContain(".rpiv/");
	});

	it("returns an empty string when no backend answers", () => {
		const none = mkdtempSync(join(tmpdir(), "rpiv-vcs-diff-none-"));
		try {
			expect(vcsDiffText(none)).toBe("");
		} finally {
			rmSync(none, { recursive: true, force: true });
		}
	});
});

describe("vcsCommittedPaths — git", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rpiv-vcs-committed-git-"));
		initRepo(dir);
		writeFileSync(join(dir, "a.ts"), "a\n");
		gitIn(dir, "add", ".");
		gitIn(dir, "commit", "-q", "-m", "seed");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("names every path a commit in the range touched", () => {
		const since = gitIn(dir, "rev-parse", "HEAD").toString().trim();
		writeFileSync(join(dir, "b.ts"), "b\n");
		gitIn(dir, "add", ".");
		gitIn(dir, "commit", "-q", "-m", "second");
		expect(vcsCommittedPaths(dir, since)).toEqual(["b.ts"]);
	});

	it("returns nothing for an empty range or an empty `since`", () => {
		const since = gitIn(dir, "rev-parse", "HEAD").toString().trim();
		expect(vcsCommittedPaths(dir, since)).toEqual([]);
		expect(vcsCommittedPaths(dir, "")).toEqual([]);
	});
});

describe.runIf(hasJj())("vcs-status under jj", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rpiv-vcs-status-jj-"));
		seedJjStatusWorkspace(dir);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("detects jj and reports the shared expected entries", () => {
		expect(detectVcs(dir)).toBe("jj");
		expect(vcsStatusEntries(dir).sort((a, b) => a.path.localeCompare(b.path))).toEqual(
			[...EXPECTED_VCS_STATUS_ENTRIES].sort((a, b) => a.path.localeCompare(b.path)),
		);
	});

	it("removes bookkeeping paths from the universe", () => {
		mkdirSync(join(dir, ".rpiv/artifacts"), { recursive: true });
		writeFileSync(join(dir, ".rpiv/artifacts/report.md"), "r\n");
		expect(vcsStatusEntries(dir).map((e) => e.path)).not.toContain(".rpiv/artifacts/report.md");
	});

	it("drops a bookkeeping hunk from the diff text", () => {
		mkdirSync(join(dir, ".rpiv/artifacts"), { recursive: true });
		writeFileSync(join(dir, ".rpiv/artifacts/report.md"), "r\n");
		const patch = vcsDiffText(dir);
		expect(patch).toContain("modified.ts");
		expect(patch).not.toContain(".rpiv/");
	});

	it("names the paths a commit in the range touched", () => {
		const since = jjIn(dir, "log", "-r", "@-", "--no-graph", "-T", "commit_id").trim();
		jjIn(dir, "split", "modified.ts", "-m", "run work");
		expect(vcsCommittedPaths(dir, since)).toEqual(["modified.ts"]);
	});
});
