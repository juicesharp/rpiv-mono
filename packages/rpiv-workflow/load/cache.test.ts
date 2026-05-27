/**
 * Direct tests for the mtime-keyed jiti import cache. Exercises both the
 * cache-miss path (fresh `jiti.import`) and the cache-hit path (returns
 * the stored parsed value without re-evaluating top-level code).
 *
 * `loadWorkflows` integration tests cover the cache miss every time
 * (each `loadWorkflows` call hits the file once); the cache-hit branch
 * only fires when the same path is imported twice within one
 * `__resetLoadCache()` boundary, which `test/setup.ts:beforeEach`
 * normally prevents. These tests opt out of the global reset by calling
 * `cachedImport` directly.
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetLoadCache, cachedImport } from "./cache.js";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "rpiv-workflow-cache-"));

beforeEach(() => {
	__resetLoadCache();
});

afterEach(() => {
	__resetLoadCache();
});

// One-shot cleanup so we don't leak the tmp directory.
process.on("exit", () => {
	rmSync(TMP_ROOT, { recursive: true, force: true });
});

const writeFixture = (name: string, body: string): string => {
	const path = join(TMP_ROOT, name);
	writeFileSync(path, body, "utf-8");
	return path;
};

describe("cachedImport", () => {
	it("returns the parsed default export on first call (cache miss)", async () => {
		const path = writeFixture("miss.ts", "export default 'first';\n");
		const value = await cachedImport(path);
		expect(value).toBe("first");
	});

	it("returns the cached value when mtime is unchanged (cache hit)", async () => {
		const path = writeFixture("hit.ts", "export default { v: 1 };\n");
		const first = await cachedImport(path);
		const second = await cachedImport(path);
		// Same reference — proves the second call short-circuited via the cache
		// (a re-evaluated `jiti.import` would return a freshly-allocated object).
		expect(second).toBe(first);
	});

	it("re-imports when mtime advances (edit invalidates the cache)", async () => {
		const path = writeFixture("edit.ts", "export default 'v1';\n");
		const first = await cachedImport(path);
		expect(first).toBe("v1");

		// Rewrite + bump mtime far enough that the cache key changes even on
		// coarse-mtime filesystems.
		writeFileSync(path, "export default 'v2';\n", "utf-8");
		const future = new Date(Date.now() + 60_000);
		utimesSync(path, future, future);

		const second = await cachedImport(path);
		expect(second).toBe("v2");
	});

	it("__resetLoadCache forces a fresh re-import on the next call", async () => {
		const path = writeFixture("reset.ts", "export default { tag: 'x' };\n");
		const first = await cachedImport(path);
		__resetLoadCache();
		const second = await cachedImport(path);
		// Different references prove the reset cleared the entry — jiti returned
		// a freshly-evaluated object.
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
	});
});
