/**
 * Shared utilities for rpiv-core.
 *
 * Pure functions — no ExtensionAPI, no side effects, fail-soft.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// PI Agent Settings path
// ---------------------------------------------------------------------------

/** Default Pi agent settings path when PI_CODING_AGENT_DIR is not configured. */
export const PI_AGENT_SETTINGS = join(homedir(), ".pi", "agent", "settings.json");

/**
 * Resolve the active Pi agent settings file. Delegates the agent-dir lookup to
 * Pi's `getAgentDir()` so PI_CODING_AGENT_DIR handling (including tilde
 * expansion) stays in one place across rpiv-pi and Pi itself.
 */
export function getPiAgentSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Runtime type guard for plain objects (not null, not array). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/**
 * Safely convert a caught value to an error message string.
 * Optional fallback overrides String(e) for non-Error values.
 */
export function toErrorMessage(e: unknown, fallback?: string): string {
	if (e instanceof Error) return e.message;
	return fallback ?? String(e);
}

// ---------------------------------------------------------------------------
// Error guards
// ---------------------------------------------------------------------------

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

/**
 * True for a stale extension ctx/pi error thrown by pi-core's ExtensionRunner
 * after session replacement or reload. Matches the stable substring so genuine
 * errors still propagate.
 *
 * Fragile by necessity: pi-core exposes no error code for this condition
 * (unlike the robust `isModuleNotFound` code-match above). A phrase-pinning
 * test in utils.test.ts guards against silent drift.
 */
export function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

// ---------------------------------------------------------------------------
// Settings reader
// ---------------------------------------------------------------------------

/** Parsed result from reading Pi agent settings. */
interface PiAgentSettingsResult {
	settings: Record<string, unknown>;
	packages: unknown[];
}

/**
 * Read and parse the active Pi agent settings file.
 * Returns undefined if the file is missing, has invalid JSON, or is not a plain object
 * with a packages array. Fail-soft — never throws.
 */
export function readPiAgentSettings(): PiAgentSettingsResult | undefined {
	const settingsPath = getPiAgentSettingsPath();
	if (!existsSync(settingsPath)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		return undefined;
	}
	if (!isPlainObject(parsed)) return undefined;
	const settings = parsed;
	if (!Array.isArray(settings.packages)) return undefined;
	return { settings, packages: settings.packages as unknown[] };
}
