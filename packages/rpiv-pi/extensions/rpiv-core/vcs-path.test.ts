import { describe, expect, it } from "vitest";
import { BOOKKEEPING_DIRS, isBookkeepingPath, stripBookkeepingHunks, unquoteGitPath } from "./vcs-path.ts";

describe("isBookkeepingPath", () => {
	it("accepts the two engine-owned trees at any depth", () => {
		expect(isBookkeepingPath(".rpiv/artifacts/goal/goal-t.md")).toBe(true);
		expect(isBookkeepingPath(".rpiv")).toBe(true);
		expect(isBookkeepingPath("thoughts/shared/notes.md")).toBe(true);
	});

	it("rejects a path outside them, including a lookalike prefix", () => {
		expect(isBookkeepingPath("src/index.ts")).toBe(false);
		expect(isBookkeepingPath(".rpivx/notes.md")).toBe(false);
		expect(isBookkeepingPath("")).toBe(false);
	});

	it("names exactly the two trees", () => {
		expect([...BOOKKEEPING_DIRS].sort()).toEqual([".rpiv", "thoughts"]);
	});
});

describe("unquoteGitPath", () => {
	it("returns an unquoted path unchanged", () => {
		expect(unquoteGitPath("src/index.ts")).toBe("src/index.ts");
	});

	it("strips the wrapping quotes from a space-bearing path", () => {
		expect(unquoteGitPath('"name with spaces.ts"')).toBe("name with spaces.ts");
	});

	it("decodes a multi-byte UTF-8 character from its octal escapes", () => {
		expect(unquoteGitPath('"caf\\303\\251.ts"')).toBe("café.ts");
	});

	it("decodes the named escapes", () => {
		expect(unquoteGitPath('"a\\tb\\nc"')).toBe("a\tb\nc");
		expect(unquoteGitPath('"quote\\"inside"')).toBe('quote"inside');
		expect(unquoteGitPath('"back\\\\slash"')).toBe("back\\slash");
	});

	it("leaves a malformed escape verbatim instead of throwing", () => {
		expect(unquoteGitPath('"a\\zb"')).toBe("a\\zb");
		expect(unquoteGitPath('"a\\"')).toBe("a\\");
	});

	it("returns a lone quote or an empty pair unchanged", () => {
		expect(unquoteGitPath('"')).toBe('"');
		expect(unquoteGitPath('""')).toBe("");
	});
});

describe("stripBookkeepingHunks", () => {
	const patch = [
		"diff --git a/src.ts b/src.ts",
		"@@ -1 +1 @@",
		"-one",
		"+two",
		'diff --git "a/thoughts/my notes.md" "b/thoughts/my notes.md"',
		"@@ -0,0 +1 @@",
		"+note",
		'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
		"@@ -0,0 +1 @@",
		"+cafe",
		"diff --git a/.rpiv/artifacts/report.md b/.rpiv/artifacts/report.md",
		"@@ -0,0 +1 @@",
		"+report",
	].join("\n");

	it("keeps a code hunk and drops both bookkeeping hunks", () => {
		const out = stripBookkeepingHunks(patch);
		expect(out).toContain("+two");
		expect(out).not.toContain("+note");
		expect(out).not.toContain("+report");
	});

	it("drops a QUOTED bookkeeping header — a path with a space must not defeat the split", () => {
		expect(stripBookkeepingHunks(patch)).not.toContain("thoughts/my notes.md");
	});

	it("keeps a quoted non-bookkeeping header", () => {
		expect(stripBookkeepingHunks(patch)).toContain("caf\\303\\251.ts");
	});

	it("returns a patch with no headers unchanged", () => {
		expect(stripBookkeepingHunks("not a patch\n")).toBe("not a patch\n");
	});
});
