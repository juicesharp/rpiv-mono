/**
 * worktree-digest tests — the fail-soft content fingerprint behind the
 * validation-retry gate, against a REAL throwaway git repo (the module's whole
 * job is git-edge behavior: staged vs unstaged content, gitignored artifacts,
 * non-repo degradation, and the failures/ forensic-sidecar exclusion).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeWorktreeDigest, resolveDigest } from "./worktree-digest.ts";

const git = (cwd: string, ...args: string[]): void => {
	execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
};

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "wt-digest-"));
	git(tmp, "init");
	git(tmp, "config", "user.email", "t@example.invalid");
	git(tmp, "config", "user.name", "t");
	git(tmp, "config", "commit.gpgsign", "false");
	// `.rpiv/` gitignored like the real repo — isolates the artifacts-tree hash
	// from the git components (an artifact write leaves status/diff untouched).
	writeFileSync(join(tmp, ".gitignore"), ".rpiv/\n");
	writeFileSync(join(tmp, "a.txt"), "one\n");
	git(tmp, "add", ".gitignore", "a.txt");
	git(tmp, "commit", "-m", "init");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("computeWorktreeDigest — git components", () => {
	it("is defined in a repo and stable across identical trees", () => {
		const d1 = computeWorktreeDigest(tmp);
		const d2 = computeWorktreeDigest(tmp);
		expect(d1).toBeDefined();
		expect(d2).toBe(d1);
	});

	it("an unstaged tracked-file edit changes the digest", () => {
		const before = computeWorktreeDigest(tmp);
		writeFileSync(join(tmp, "a.txt"), "two\n");
		expect(computeWorktreeDigest(tmp)).not.toBe(before);
	});

	it("two different STAGED states of the same file hash differently (diff HEAD, not bare diff)", () => {
		writeFileSync(join(tmp, "a.txt"), "staged-a\n");
		git(tmp, "add", "a.txt");
		const stagedA = computeWorktreeDigest(tmp);
		writeFileSync(join(tmp, "a.txt"), "staged-b\n");
		git(tmp, "add", "a.txt");
		// Porcelain status line and the unstaged diff are identical between the two
		// states — only the staged content differs, which `git diff HEAD` carries.
		expect(computeWorktreeDigest(tmp)).not.toBe(stagedA);
	});

	it("returns undefined for a non-repo cwd (degrade to proceed, never skip)", () => {
		const plain = mkdtempSync(join(tmpdir(), "wt-plain-"));
		try {
			expect(computeWorktreeDigest(plain)).toBeUndefined();
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});

describe("computeWorktreeDigest — artifacts tree", () => {
	it("a gitignored artifact write changes the digest", () => {
		const before = computeWorktreeDigest(tmp);
		mkdirSync(join(tmp, ".rpiv", "artifacts", "plans"), { recursive: true });
		writeFileSync(join(tmp, ".rpiv", "artifacts", "plans", "p.md"), "plan\n");
		expect(computeWorktreeDigest(tmp)).not.toBe(before);
	});

	it("a write under .rpiv/artifacts/failures/ does NOT change the digest (forensic sidecars excluded)", () => {
		mkdirSync(join(tmp, ".rpiv", "artifacts", "failures"), { recursive: true });
		const before = computeWorktreeDigest(tmp);
		writeFileSync(join(tmp, ".rpiv", "artifacts", "failures", "run_1_unit.md"), "death scene\n");
		expect(computeWorktreeDigest(tmp)).toBe(before);
	});

	it("a `failures` directory nested DEEPER than the artifacts root still counts", () => {
		mkdirSync(join(tmp, ".rpiv", "artifacts", "plans", "failures"), { recursive: true });
		const before = computeWorktreeDigest(tmp);
		writeFileSync(join(tmp, ".rpiv", "artifacts", "plans", "failures", "x.md"), "not a sidecar\n");
		expect(computeWorktreeDigest(tmp)).not.toBe(before);
	});
});

describe("resolveDigest — override-wins resolution", () => {
	it("a present override wins, including when it returns undefined", () => {
		expect(resolveDigest(() => "fixed-digest", tmp)).toBe("fixed-digest");
		// An override simulating a non-repo must NOT fall through to the real recipe.
		expect(resolveDigest(() => undefined, tmp)).toBeUndefined();
	});

	it("no override falls back to the built-in recipe", () => {
		expect(resolveDigest(undefined, tmp)).toBe(computeWorktreeDigest(tmp));
	});
});
