/**
 * rpiv-config — shared config I/O utilities for rpiv-mono sibling packages.
 *
 * Provides JSON config load/save with crash-resistant defaults, path resolution,
 * guidance-field validation, env-var fallback, and TypeBox-driven schema validation.
 * Stateless — no module-level singletons, no globalThis caches, no side effects.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { type Static, type TObject, Type } from "typebox";
import { Value } from "typebox/value";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` to the user's home directory. Mirrors Pi's
 * `expandTildePath`. Uses `join` (not string concatenation) so the path
 * separator is correct on every platform.
 *
 * Contract: only bare `~` and `~/…` expand. A `~user` form is returned
 * unchanged (the XDG spec defines no `~user` expansion), so it fails the
 * downstream `isAbsolute` check and routes to the default config dir.
 */
function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

/** Default config directory: `~/.config`. Single source of the `.config` literal. */
function defaultConfigDir(): string {
	return join(homedir(), ".config");
}

/**
 * Resolve the config directory honoring `XDG_CONFIG_HOME`.
 *
 * Boundary: `XDG_CONFIG_HOME` governs the rpiv-* sibling config layer only.
 * Pi-native paths (`~/.pi/…`, driven by `PI_CODING_AGENT_DIR`) are a separate,
 * orthogonal concern and are intentionally NOT unified here.
 *
 * XDG spec compliance:
 *   - unset / empty-after-trim / whitespace-only → default (`~/.config`)
 *   - relative path → default (XDG mandates absolute)
 *   - `"~"` or `"~/…"` → expand the tilde, then require absolute
 *   - `"~user…"` → NOT expanded (XDG defines no `~user` form); silently
 *     routes to the default like any other relative path
 *   - absolute → used verbatim
 */
function resolveConfigDir(): string {
	const xdg = readEnvVar("XDG_CONFIG_HOME");
	if (!xdg) return defaultConfigDir();
	const expanded = expandTilde(xdg);
	return isAbsolute(expanded) ? expanded : defaultConfigDir();
}

/**
 * Always-legacy config path under `~/.config`. Used by the legacy-fallback
 * reader so a pre-XDG config file is still discovered after an operator sets
 * `XDG_CONFIG_HOME`. Ignores `XDG_CONFIG_HOME` by design.
 */
function legacyConfigPath(name: string, file: string = "config.json"): string {
	return join(defaultConfigDir(), name, file);
}

/**
 * Resolve a config file path under the XDG-aware config directory.
 *
 * `<resolveConfigDir()>/<name>/<file>` — defaults to `~/.config/<name>/config.json`
 * when `XDG_CONFIG_HOME` is unset / empty / whitespace / relative.
 *
 * Boundary: `XDG_CONFIG_HOME` governs the rpiv-* sibling config layer only;
 * Pi-native paths (`~/.pi/…`, via `PI_CODING_AGENT_DIR`) are orthogonal and
 * not unified here.
 *
 * @param name — package directory name (e.g. "rpiv-todo")
 * @param file — config filename (defaults to "config.json")
 * @returns absolute path to the config file
 */
export function configPath(name: string, file: string = "config.json"): string {
	return join(resolveConfigDir(), name, file);
}

// ---------------------------------------------------------------------------
// JSON config load — Variant A (with typeof guard) universally
// ---------------------------------------------------------------------------

/**
 * Load and parse a JSON config file.
 *
 * Returns `{}` for missing files, malformed JSON, or non-plain-object values.
 * The typeof guard fixes a latent bug where valid non-object JSON
 * (e.g. `"hello"`, `42`, `null`) passes through the cast. Arrays are also
 * rejected — `typeof [] === "object"` in JavaScript, but config files are
 * always plain objects.
 */
export function loadJsonConfig<T>(path: string): T {
	if (!existsSync(path)) return {} as T;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {} as T;
		return parsed as T;
	} catch (err) {
		// Diagnostic for malformed-JSON path. Silent save + silent load otherwise
		// produce identical user-visible symptoms (state reverts on next start)
		// with zero diagnostic surface — the user cannot tell "never saved" from
		// "saved-but-unreadable." Warning is owner-only since the file lives in
		// the user's HOME.
		console.warn(`rpiv-config: invalid JSON at ${path}, using default ({}) — ${(err as Error).message}`);
		return {} as T;
	}
}

/**
 * Load a JSON config, preferring the XDG-resolved path and falling back to the
 * legacy `~/.config/<name>/<file>` location only when the XDG path is missing.
 *
 * - XDG file present (valid or malformed) → its parse result wins. A malformed
 *   XDG file warns and returns `{}` but does NOT silently fall back to legacy —
 *   corruption is surfaced, not masked.
 * - XDG file missing → read the legacy path (which returns `{}` if also missing,
 *   or warns + `{}` if malformed).
 * - Both missing → `{}`.
 *
 * @param name — package directory name (e.g. "rpiv-todo")
 * @param file — config filename (defaults to "config.json")
 */
export function loadJsonConfigWithLegacyFallback<T>(name: string, file: string = "config.json"): T {
	const xdgPath = configPath(name, file);
	if (existsSync(xdgPath)) {
		return loadJsonConfig<T>(xdgPath);
	}
	return loadJsonConfig<T>(legacyConfigPath(name, file));
}

// ---------------------------------------------------------------------------
// JSON config save — best-effort void
// ---------------------------------------------------------------------------

/** File mode for config files (user read/write only). */
const CONFIG_FILE_MODE = 0o600;

/**
 * Persist a config object as formatted JSON. Returns `true` on successful
 * mkdir+write, `false` on filesystem failure (disk full, EACCES, EROFS, …).
 *
 * Every current rpiv-* save call site is user-initiated and shows a
 * "Saved …" notification — callers MUST guard the success notification on
 * the boolean return so a silent disk failure can't make the success message
 * lie on disk-full / EACCES.
 *
 * The chmod step is best-effort and never affects the return value: some
 * filesystems (tmpfs, network mounts, Windows-style perms) silently ignore
 * chmod and there is no portable way to enforce 0600 perms across platforms.
 * Callers that genuinely don't care about persistence outcome can discard
 * the return — TypeScript does not warn on ignored `boolean`.
 */
export function saveJsonConfig(path: string, data: unknown): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	} catch {
		return false;
	}
	try {
		chmodSync(path, CONFIG_FILE_MODE);
	} catch {
		// chmod may fail on some filesystems — best effort only, never gates success
	}
	return true;
}

// ---------------------------------------------------------------------------
// GuidanceFields — extracted from 4 byte-identical copies
// ---------------------------------------------------------------------------

export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

// TypeBox form of GuidanceFields. Mirrors the interface 1:1 — same fields,
// same optionality. `additionalProperties: true` lets consumers compose
// wrappers that may carry sibling-specific keys without those leaking back
// into rpiv-config. The runtime invariants (non-empty string, non-empty
// array of non-empty strings) are still enforced by `validateGuidanceFields`;
// the schema is a structural type-narrowing aid for callers that bake
// guidance into a larger TypeBox-validated config object.
export const GuidanceFieldsSchema = Type.Object(
	{
		promptSnippet: Type.Optional(Type.String()),
		promptGuidelines: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: true },
);

/**
 * Validate and extract guidance fields from an unknown value.
 *
 * Returns a clean `GuidanceFields` object with only valid entries.
 * Byte-identical logic previously in rpiv-todo, rpiv-ask-user-question,
 * rpiv-advisor, and rpiv-web-tools.
 */
export function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!fields || typeof fields !== "object") return {};
	const g = fields as Record<string, unknown>;
	const result: GuidanceFields = {};
	if (typeof g.promptSnippet === "string" && g.promptSnippet.length > 0) {
		result.promptSnippet = g.promptSnippet;
	}
	if (
		Array.isArray(g.promptGuidelines) &&
		g.promptGuidelines.length > 0 &&
		g.promptGuidelines.every((s) => typeof s === "string" && s.length > 0)
	) {
		result.promptGuidelines = g.promptGuidelines;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Model key codec — provider:id string ↔ { provider, modelId } object.
// ---------------------------------------------------------------------------

/**
 * Parse a model key string into its components.
 *
 * Accepts EITHER separator on read:
 *   - "provider/modelId" — canonical form (emitted by modelKey and persisted
 *     by post-slash-canonical-migration consumers).
 *   - "provider:modelId" — legacy form (persisted by released rpiv-advisor
 *     1.16+ before the migration). Auto-rewritten on the next save by any
 *     consumer that re-serialises via modelKey.
 *
 * Slash is preferred when present — a key like "provider:foo/bar" splits on
 * `/`, so the modelId is "bar" rather than re-introducing the legacy
 * interpretation. No current model id contains a `/` so this asymmetry has
 * no real-world ambiguity.
 */
export function parseModelKey(key: string): { provider: string; modelId: string } | undefined {
	const slashIdx = key.indexOf("/");
	if (slashIdx >= 1) return { provider: key.slice(0, slashIdx), modelId: key.slice(slashIdx + 1) };
	const colonIdx = key.indexOf(":");
	if (colonIdx >= 1) return { provider: key.slice(0, colonIdx), modelId: key.slice(colonIdx + 1) };
	return undefined;
}

/**
 * Compose the canonical "provider/modelId" string from provider and modelId
 * components. Slash-only emission; paired with parseModelKey's tolerant read,
 * legacy colon-form persisted values auto-migrate the next time any consumer
 * re-serialises through this codec.
 */
export function modelKey(m: { provider: string; id: string }): string {
	return `${m.provider}/${m.id}`;
}

// ---------------------------------------------------------------------------
// Env-var fallback
// ---------------------------------------------------------------------------

/**
 * Read an environment variable with optional fallback.
 *
 * Trims whitespace from the env value. Returns `fallback` (or `undefined`)
 * when the variable is unset or empty after trimming.
 */
export function readEnvVar(key: string, fallback?: string): string | undefined {
	return process.env[key]?.trim() || fallback;
}

// ---------------------------------------------------------------------------
// TypeBox-driven schema validation
// ---------------------------------------------------------------------------

/**
 * Validate and clean a config value against a TypeBox schema.
 *
 * 1. Guards against non-plain-object input (returns `{}` for primitives, arrays).
 * 2. Clones the input (Value.Clean mutates).
 * 3. Strips unknown properties via `Value.Clean`.
 * 4. Applies schema defaults via `Value.Create` (spread merge: defaults
 *    provide base, cleaned value overrides).
 * 5. Returns the validated, cleaned object typed as the schema's static type.
 *
 * Falls back to `{}` on any failure — same fail-soft contract as `loadJsonConfig`.
 */
export function validateConfig<T extends TObject>(schema: T, value: unknown): Static<T> {
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return {} as Static<T>;
		const cleaned = Value.Clean(schema, Value.Clone(value));
		const defaults = Value.Create(schema);
		// Merge: defaults as base, cleaned values override.
		// Both are plain objects from TypeBox operations — safe spread via Record cast.
		return { ...(defaults as Record<string, unknown>), ...(cleaned as Record<string, unknown>) } as Static<T>;
	} catch {
		return {} as Static<T>;
	}
}
