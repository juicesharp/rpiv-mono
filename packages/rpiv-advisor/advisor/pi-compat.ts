/**
 * Host-version-tolerant loader for pi-ai's `completeSimple`.
 *
 * Pi >= 0.80.1 moved the global dispatch API (`completeSimple` et al.) to the
 * "@earendil-works/pi-ai/compat" entrypoint; hosts <= 0.79.x export it from
 * the package root and have no /compat entrypoint at all. pi-ai resolves at
 * runtime against the HOST's copy (peerDependency "*"), so neither path can
 * be a static import — try /compat first, fall back to the root entrypoint.
 *
 * The fallback is reserved for RESOLUTION failures (the /compat subpath does
 * not exist on this host); any other /compat error — the entrypoint exists but
 * throws at module init — rethrows so the real failure surfaces at the call
 * site instead of being masked by a root import that may lack the export.
 *
 * /compat is documented as temporary (deleted with pi's ModelManager
 * migration); when that lands, this module is the single place to migrate.
 */

type CompleteSimpleFn = typeof import("@earendil-works/pi-ai/compat").completeSimple;

/**
 * Resolve Pi's auth-aware completion facade when the host exposes one.
 *
 * Current Pi hosts keep the canonical `ModelRuntime` behind the extension
 * `ModelRegistry`'s runtime-private `runtime` slot. This structural bridge is
 * intentionally isolated here: calling that facade is what lets Pi apply
 * credential-derived request fields such as GitHub Copilot's OAuth-specific
 * `baseUrl`. Older hosts, and future hosts that move the slot, simply fall
 * through to the legacy global completion path below.
 *
 * The returned method is bound because `ModelRuntime.completeSimple()` calls
 * other runtime methods through `this`.
 */
export function getRuntimeCompleteSimple(modelRegistry: unknown): CompleteSimpleFn | undefined {
	try {
		if (modelRegistry === null || typeof modelRegistry !== "object") return undefined;
		const runtime = (modelRegistry as { runtime?: unknown }).runtime;
		if (runtime === null || typeof runtime !== "object") return undefined;
		const completeSimple = (runtime as { completeSimple?: unknown }).completeSimple;
		return typeof completeSimple === "function" ? (completeSimple.bind(runtime) as CompleteSimpleFn) : undefined;
	} catch {
		// A malformed/private host shape should retain the version-tolerant fallback.
		return undefined;
	}
}

/**
 * Error codes meaning "the /compat entrypoint is not resolvable on this host":
 *   - `ERR_PACKAGE_PATH_NOT_EXPORTED` — Node's ESM resolver when the installed
 *     pi-ai (<= 0.79.x) resolves but has no "./compat" in its `exports` map —
 *     the code an old host actually produces.
 *   - `ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND` — Node's / jiti's resolver
 *     for an unresolvable module (jiti is what Pi loads `.ts` extensions with).
 * Mirrors rpiv-core's `isModuleNotFound` (plus the subpath-export code) —
 * duplicated because siblings never import each other at runtime.
 */
const MODULE_NOT_FOUND_CODES = new Set(["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/** True for a module-resolution failure. Walks the `cause` chain — ESM loaders
 *  and tooling (vitest's mock layer, some bundlers) nest the real code under
 *  `.cause`. Bounded against pathological self-referential chains. */
function isModuleNotFound(err: unknown): boolean {
	for (
		let cur: unknown = err, depth = 0;
		cur != null && depth < 16;
		cur = (cur as { cause?: unknown }).cause, depth++
	) {
		if (typeof cur === "object" && MODULE_NOT_FOUND_CODES.has((cur as { code?: unknown }).code as string)) {
			return true;
		}
	}
	return false;
}

export async function loadCompleteSimple(): Promise<CompleteSimpleFn> {
	let mod: { completeSimple?: CompleteSimpleFn };
	try {
		mod = (await import("@earendil-works/pi-ai/compat")) as { completeSimple?: CompleteSimpleFn };
	} catch (err) {
		if (!isModuleNotFound(err)) throw err; // a real /compat failure must surface, not mask as a fallback
		mod = (await import("@earendil-works/pi-ai")) as { completeSimple?: CompleteSimpleFn };
	}
	const completeSimple = mod.completeSimple;
	if (typeof completeSimple !== "function") {
		throw new Error(
			"pi-ai does not expose completeSimple on /compat or the package root — unsupported host pi-ai version",
		);
	}
	return completeSimple;
}
