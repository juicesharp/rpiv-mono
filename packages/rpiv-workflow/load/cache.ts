/**
 * mtime-keyed jiti import cache. jiti's MODULE cache is disabled so `/reload`
 * picks up edits without restart; its fs TRANSFORM cache stays on (the
 * default) — entries are content-hash validated, so an edited overlay can
 * never be served stale, and fresh sessions skip the ~70ms/file Babel
 * re-transform. This wrapper layers a stat-driven cache on top so unchanged
 * overlays don't re-evaluate top-level code on every `/wf` invocation.
 *
 * The `jiti` instance lives here so the cache and the underlying importer
 * co-locate. Other loader modules import `cachedImport` — none touches
 * `jiti` directly. It is created on first use with the overlay module map
 * (`overlayVirtualModules`).
 *
 * The cache does not invalidate on file deletion — a stale entry for a
 * deleted overlay sits dormant (the enumerator never passes it back to
 * `cachedImport`). The cache resets on `__resetLoadCache()` (wired into
 * `test/setup.ts` `beforeEach`) and on process exit.
 */

import { statSync } from "node:fs";
import { createJiti } from "jiti";

type Jiti = ReturnType<typeof createJiti>;

/**
 * Bare specifiers an overlay may import, mapped to modules this package already
 * holds — the same `virtualModules` mechanism Pi's extension loader uses for
 * extensions. Overlays live outside any `node_modules` tree (`~/.config/…`,
 * `<cwd>/.rpiv/workflows/`), so plain Node resolution finds neither this package
 * nor `typebox`, which Pi supplies to extensions (a `"*"` peer, often not on disk
 * at all in a compiled Pi) (#298).
 *
 * - `@juicesharp/rpiv-workflow` and its public subpaths → the running package's
 *   own entries: the documented authoring import resolves, and nothing is
 *   re-evaluated (state lives on `globalThis` slots regardless).
 * - `typebox` (+ `/value`, `/compile`) → the copy THIS package received from its
 *   host. Fail-soft per entry: a host that does not provide a subpath simply
 *   leaves it unmapped instead of breaking every overlay.
 *
 * Imported lazily on the first overlay load (during `/wf`), so the thin
 * startup/registration entries never pull the runner graph.
 */
async function overlayVirtualModules(): Promise<Record<string, unknown>> {
	const [root, registration, startup, runner] = await Promise.all([
		import("../index.ts"),
		import("../registration.ts"),
		import("../startup.ts"),
		import("../runner/index.ts"),
	]);
	const modules: Record<string, unknown> = {
		"@juicesharp/rpiv-workflow": root,
		"@juicesharp/rpiv-workflow/registration": registration,
		"@juicesharp/rpiv-workflow/startup": startup,
		"@juicesharp/rpiv-workflow/runner": runner,
	};
	const typebox = await Promise.allSettled([import("typebox"), import("typebox/value"), import("typebox/compile")]);
	(["typebox", "typebox/value", "typebox/compile"] as const).forEach((specifier, i) => {
		const result = typebox[i];
		if (result.status === "fulfilled") modules[specifier] = result.value;
	});
	return modules;
}

let jitiPromise: Promise<Jiti> | undefined;

function getJiti(): Promise<Jiti> {
	jitiPromise ??= overlayVirtualModules().then(
		(virtualModules) =>
			createJiti(import.meta.url, {
				// Module cache OFF so /reload picks up edits without restart. The fs
				// transform cache (default ON) is deliberately kept: it is content-hash
				// validated (edit-safe) and saves ~70ms/file of Babel work per session.
				moduleCache: false,
				virtualModules,
			}),
		(err: unknown) => {
			jitiPromise = undefined; // a failed setup must not poison every later /wf
			throw err;
		},
	);
	return jitiPromise;
}

const overlayCache = new Map<string, { mtimeMs: number; parsed: unknown }>();

export async function cachedImport(path: string): Promise<unknown> {
	const stat = statSync(path);
	const cached = overlayCache.get(path);
	if (cached && cached.mtimeMs === stat.mtimeMs) return cached.parsed;
	const jiti = await getJiti();
	const value = await jiti.import(path, { default: true });
	overlayCache.set(path, { mtimeMs: stat.mtimeMs, parsed: value });
	return value;
}

/** Test-only reset. Wired into `test/setup.ts` `beforeEach`. */
export function __resetLoadCache(): void {
	overlayCache.clear();
}
