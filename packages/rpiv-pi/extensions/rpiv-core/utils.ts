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
 * True for a Node module-resolution failure (the sibling isn't installed).
 *
 * Walks the `cause` chain: a clean `await import(...)` of a missing package
 * rejects with `code === "ERR_MODULE_NOT_FOUND"` directly, but ESM loaders and
 * tooling (vitest's mock layer, some bundlers) wrap that error, nesting the
 * real code under `.cause`. Bounded against pathological self-referential
 * chains.
 */
export function isModuleNotFound(err: unknown): boolean {
	for (
		let cur: unknown = err, depth = 0;
		cur != null && depth < 16;
		cur = (cur as { cause?: unknown }).cause, depth++
	) {
		if (typeof cur === "object" && (cur as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND") {
			return true;
		}
	}
	return false;
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
