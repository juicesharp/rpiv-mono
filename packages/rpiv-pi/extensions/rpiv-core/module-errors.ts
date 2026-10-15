/**
 * Module-resolution error guard. Pi-free on purpose: outcome-derivation.ts needs
 * it and is loaded by hosts that are not Pi (rpiv-claude). utils.ts re-exports it.
 */

/**
 * Error codes that mean "module-resolution failed" (the sibling isn't installed
 * / isn't resolvable). Two distinct codes because two distinct loaders are in
 * play:
 *   - `ERR_MODULE_NOT_FOUND` — Node's native ESM resolver (a plain
 *     `await import(...)` under stock Node).
 *   - `MODULE_NOT_FOUND` — jiti's resolver, which is what Pi ACTUALLY uses to
 *     load `.ts` extensions. A missing nested `import("@juicesharp/rpiv-…")`
 *     inside a jiti-loaded module rejects with this CJS-style code (verified on
 *     jiti 2.7.0, both `tryNative:false` and the native-fallback path). Matching
 *     only the ESM code let these fall through to a logged `[rpiv-core] failed
 *     to register …` instead of the intended silent absent-sibling no-op.
 */
const MODULE_NOT_FOUND_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/**
 * True for a module-resolution failure (the sibling isn't installed / not
 * resolvable from rpiv-pi's location).
 *
 * Walks the `cause` chain: a clean `await import(...)` of a missing package
 * rejects with the resolution code directly, but ESM loaders and tooling
 * (vitest's mock layer, some bundlers) wrap that error, nesting the real code
 * under `.cause`. Bounded against pathological self-referential chains.
 */
export function isModuleNotFound(err: unknown): boolean {
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
