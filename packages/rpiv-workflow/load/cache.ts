/**
 * mtime-keyed jiti import cache. jiti's own caches are disabled so `/reload`
 * picks up edits without restart; this wrapper layers a stat-driven cache
 * on top so unchanged overlays don't re-evaluate top-level code on every
 * `/wf` invocation.
 *
 * The `jiti` instance lives here so the cache and the underlying importer
 * co-locate. Other loader modules import `cachedImport` — none touches
 * `jiti` directly.
 *
 * The cache does not invalidate on file deletion — a stale entry for a
 * deleted overlay sits dormant (the enumerator never passes it back to
 * `cachedImport`). The cache resets on `__resetLoadCache()` (wired into
 * `test/setup.ts` `beforeEach`) and on process exit.
 */

import { statSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
	// Bypass jiti's module cache so /reload picks up edits without restart.
	moduleCache: false,
	fsCache: false,
});

const overlayCache = new Map<string, { mtimeMs: number; parsed: unknown }>();

export async function cachedImport(path: string): Promise<unknown> {
	const stat = statSync(path);
	const cached = overlayCache.get(path);
	if (cached && cached.mtimeMs === stat.mtimeMs) return cached.parsed;
	const value = await jiti.import(path, { default: true });
	overlayCache.set(path, { mtimeMs: stat.mtimeMs, parsed: value });
	return value;
}

/** Test-only reset. Wired into `test/setup.ts` `beforeEach`. */
export function __resetLoadCache(): void {
	overlayCache.clear();
}
