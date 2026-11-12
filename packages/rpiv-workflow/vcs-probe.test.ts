/**
 * Tests for the jj probe — a PURE table test over the summary normaliser:
 * jj's `diff --summary` letters, brace renames, blank lines and unseen
 * letters all collapse into the `XY <path>` grammar `parsePorcelain`
 * already consumes. No subprocess runs here.
 */

import { describe, expect, it } from "vitest";
import { jjSummaryPath, jjSummaryToPorcelain, unquoteGitPath } from "./vcs-probe.ts";

describe("jjSummaryToPorcelain", () => {
	it("maps every jj summary letter into the XY grammar", () => {
		expect(jjSummaryToPorcelain("M a.ts\nA b.ts\nD c.ts\nR d.ts\nC e.ts\nT f.ts")).toBe(
			[" M a.ts", "?? b.ts", " D c.ts", " R d.ts", "?? e.ts", " M f.ts"].join("\n"),
		);
	});

	it("keeps a brace rename on the new side, with the shared directory prefix", () => {
		expect(jjSummaryToPorcelain("R {old.ts => new.ts}\nR dir/{x.ts => y.ts}")).toBe(
			[" R new.ts", " R dir/y.ts"].join("\n"),
		);
	});

	it("drops blank lines", () => {
		expect(jjSummaryToPorcelain("\nM a.ts\n\n")).toBe(" M a.ts");
	});

	it("degrades an unseen letter to ` M`", () => {
		expect(jjSummaryToPorcelain("Q weird.ts")).toBe(" M weird.ts");
	});
});

describe("jjSummaryPath", () => {
	it("projects the new side of the braces and trims the separator", () => {
		expect(jjSummaryPath(" {old.ts => new.ts}")).toBe("new.ts");
		expect(jjSummaryPath(" dir/{a.ts => b.ts}")).toBe("dir/b.ts");
	});

	it("passes an unbraced path through untouched", () => {
		expect(jjSummaryPath(" plain.ts")).toBe("plain.ts");
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

	it("leaves a malformed escape verbatim instead of throwing", () => {
		expect(unquoteGitPath('"a\\zb"')).toBe("a\\zb");
	});
});
