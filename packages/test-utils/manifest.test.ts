import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyShipManifest } from "./manifest.js";

/**
 * Builds a throwaway package dir: `package.json` with the given `files` array
 * plus every path in `tree` created as an empty file (nested dirs auto-made).
 */
function makePackage(dir: string, files: string[], tree: string[]): void {
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", files }));
	for (const rel of tree) {
		const abs = join(dir, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, "export {};\n");
	}
}

describe("verifyShipManifest", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rpiv-manifest-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("covers nested files via a trailing-slash directory entry", () => {
		makePackage(dir, ["index.ts", "runner/"], ["index.ts", "runner/runner.ts", "runner/step.ts"]);
		expect(verifyShipManifest(dir).missing).toEqual([]);
	});

	it("covers nested files via a BARE directory entry (per the documented contract)", () => {
		makePackage(dir, ["index.ts", "runner"], ["index.ts", "runner/runner.ts", "runner/step.ts"]);
		expect(verifyShipManifest(dir).missing).toEqual([]);
	});

	it("a bare directory entry does not spuriously cover a sibling file with a shared prefix", () => {
		// `"load"` must cover `load/cache.ts` but NOT `loader.ts`.
		makePackage(dir, ["load"], ["load/cache.ts", "loader.ts"]);
		expect(verifyShipManifest(dir).missing).toEqual(["loader.ts"]);
	});

	it("flags a production file omitted from the files array", () => {
		makePackage(dir, ["index.ts"], ["index.ts", "iterate.ts"]);
		expect(verifyShipManifest(dir).missing).toEqual(["iterate.ts"]);
	});

	it("ignores .test.ts and test-fixtures.ts when computing missing files", () => {
		makePackage(dir, ["index.ts"], ["index.ts", "index.test.ts", "test-fixtures.ts"]);
		expect(verifyShipManifest(dir).missing).toEqual([]);
	});

	it("flags `files` entries with no corresponding path on disk as stale", () => {
		makePackage(dir, ["index.ts", "ghost.ts", "phantom/"], ["index.ts"]);
		expect(verifyShipManifest(dir).stale).toEqual(["ghost.ts", "phantom/"]);
	});

	it("non-.ts asset entries (README, dirs) that exist are not stale", () => {
		makePackage(dir, ["index.ts", "README.md", "load"], ["index.ts", "README.md", "load/cache.ts"]);
		expect(verifyShipManifest(dir).stale).toEqual([]);
	});

	it("`!`-prefixed negation entries are not flagged stale and do not cover files", () => {
		makePackage(dir, ["providers/", "!**/*.test.ts"], ["providers/github.ts", "providers/github.test.ts"]);
		const result = verifyShipManifest(dir);
		expect(result.stale).toEqual([]);
		expect(result.missing).toEqual([]);
	});
});
