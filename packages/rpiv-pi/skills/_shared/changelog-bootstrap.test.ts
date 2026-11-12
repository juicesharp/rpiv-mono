import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasJj } from "@juicesharp/rpiv-test-utils/vcs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./changelog-bootstrap.mjs", import.meta.url));

const run = (cwd: string) =>
	execFileSync("node", [SCRIPT], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });

const gitIn = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });

const initRepo = (cwd: string) => {
	gitIn(cwd, "init", "-q");
	gitIn(cwd, "config", "user.email", "test@example.com");
	gitIn(cwd, "config", "user.name", "Test User");
	gitIn(cwd, "config", "commit.gpgsign", "false");
	writeFileSync(join(cwd, "CHANGELOG.md"), "# log\n");
	gitIn(cwd, "add", ".");
	gitIn(cwd, "commit", "-q", "-m", "init");
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rpiv-changelog-bootstrap-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("changelog-bootstrap.mjs", () => {
	it("reports not-in-a-repo outside any repository", () => {
		expect(run(dir)).toContain("last_tag: (not in a version-control repo)");
	});

	it("reports (no tags) for a repo with no tag", () => {
		initRepo(dir);
		expect(run(dir)).toContain("last_tag: (no tags)");
	});

	it("reports the nearest tag", () => {
		initRepo(dir);
		gitIn(dir, "tag", "v1.0.0");
		expect(run(dir)).toContain("last_tag: v1.0.0");
	});

	it("lists the tracked CHANGELOG.md", () => {
		initRepo(dir);
		expect(run(dir)).toContain("CHANGELOG.md");
	});

	describe.runIf(hasJj())("jj workspace", () => {
		it("reports one stable tag name when a commit carries several", () => {
			const jj = (...args: string[]) => execFileSync("jj", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
			jj("git", "init");
			// Repo-level identity: `jj describe` must resolve without user config.
			jj("config", "set", "--repo", "user.name", "Test User");
			jj("config", "set", "--repo", "user.email", "test@example.com");
			writeFileSync(join(dir, "CHANGELOG.md"), "# log\n");
			jj("describe", "-m", "init");
			// The first `tag set` makes `@` immutable and opens a new empty `@`, so
			// `@-` is the tagged commit — the second tag lands on the SAME commit.
			jj("tag", "set", "v2.0.0");
			jj("tag", "set", "v1.9.0", "-r", "@-");
			// Both tags sit on one commit; the pick is sorted, so it is stable.
			expect(run(dir)).toContain("last_tag: v1.9.0");
		});
	});
});
