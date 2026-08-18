/**
 * Single typed reader/writer for ~/.config/rpiv-web-tools/config.json.
 *
 * Owns the canonical WebToolsConfigSchema. All schema fields are optional and
 * unknown keys pass through (additionalProperties: true) so existing configs
 * carrying legacy/unrelated fields keep working — required for the
 * `otherField: "keep"` preservation contract the released `/web-tools`
 * legacy-apiKey migration depends on.
 *
 * Validation is fail-soft (matching `loadJsonConfig` and `validateConfig` in
 * rpiv-config): malformed JSON and EISDIR degrade to `{}`; a schema violation
 * degrades per field — only the offending paths are dropped, `{}` remains the
 * floor when nothing salvageable is left. The orchestrator never has to
 * handle "config blew up at startup."
 */

import {
	configPath,
	GuidanceFieldsSchema,
	loadJsonConfigWithLegacyFallback,
	saveJsonConfig,
} from "@juicesharp/rpiv-config";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// The web_search / web_fetch tool-namespace wrapper is web-tools' concept, not
// rpiv-config's. The leaf schema (`GuidanceFieldsSchema`) is sibling-agnostic
// and lives in rpiv-config; this file only composes the tool-namespaced shell
// around it.
const WebToolsGuidanceSchema = Type.Object(
	{
		web_search: Type.Optional(GuidanceFieldsSchema),
		web_fetch: Type.Optional(GuidanceFieldsSchema),
	},
	{ additionalProperties: true },
);

const GitHubInterceptorOptionsSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		maxRepoSizeMB: Type.Optional(Type.Number()),
		cloneTimeoutSeconds: Type.Optional(Type.Number()),
		clonePath: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);

const InterceptorsConfigSchema = Type.Object(
	{
		// Boolean shorthand or per-field overrides. `enabled: false` inside the
		// object form is allowed but redundant — use the top-level `false`.
		github: Type.Optional(Type.Union([Type.Boolean(), GitHubInterceptorOptionsSchema])),
	},
	{ additionalProperties: true },
);

export const WebToolsConfigSchema = Type.Object(
	{
		provider: Type.Optional(Type.String()),
		apiKeys: Type.Optional(Type.Record(Type.String(), Type.String())),
		baseUrls: Type.Optional(Type.Record(Type.String(), Type.String())),
		// Legacy top-level Brave key. Auto-migrated to `apiKeys.brave` by the
		// /web-tools save path — kept here for the load+rewrite round-trip.
		apiKey: Type.Optional(Type.String()),
		guidance: Type.Optional(WebToolsGuidanceSchema),
		interceptors: Type.Optional(InterceptorsConfigSchema),
	},
	{ additionalProperties: true },
);

export type WebToolsConfig = Static<typeof WebToolsConfigSchema>;

const CONFIG_PATH = configPath("rpiv-web-tools");

export function getConfigPath(): string {
	return CONFIG_PATH;
}

/** JSON-pointer segments of a `Value.Errors` `instancePath` (`~1` ⇒ `/`, `~0` ⇒ `~`). */
const pointerSegments = (instancePath: string): string[] =>
	instancePath === ""
		? []
		: instancePath
				.split("/")
				.slice(1)
				.map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));

/**
 * Delete the value at `segs` from `root`, widening to the nearest containing
 * FIELD when the path descends into an array (deleting one element would leave
 * a sparse hole that still fails validation — the whole array field falls back
 * instead). Returns false when the path is already gone (a prior deletion took
 * an ancestor).
 */
const deleteAtPointer = (root: Record<string, unknown>, segs: string[]): boolean => {
	let parent: Record<string, unknown> = root;
	for (let i = 0; i < segs.length - 1; i++) {
		const next = parent[segs[i] as string];
		if (next === null || typeof next !== "object") return false;
		if (Array.isArray(next)) {
			delete parent[segs[i] as string];
			return true;
		}
		parent = next as Record<string, unknown>;
	}
	const leaf = segs[segs.length - 1] as string;
	if (!(leaf in parent)) return false;
	delete parent[leaf];
	return true;
};

/**
 * Per-field salvage of a config that fails the whole-schema check: drop
 * exactly the offending paths `Value.Errors` reports and keep everything else,
 * so one wrong-typed leaf (e.g. `guidance.web_search.description: 123`) costs
 * that field alone — not provider, apiKeys, baseUrls, interceptors and both
 * guidance subtrees for the session, with the `/web-tools` save path then
 * persisting the wipe. Unknown keys are untouched (`additionalProperties:
 * true` reports no errors for them), preserving the `otherField` pass-through
 * contract. Deletions are schema-driven, so a future shared-`GuidanceFields`
 * field addition cannot re-open the whole-file cliff. The pass loop is belt
 * and braces for cascading reports (e.g. a union error at the field alongside
 * its nested cause); a round that deletes nothing, or a config still failing
 * after the bounded passes, degrades to `{}` exactly as before.
 */
const salvageConfig = (raw: object): WebToolsConfig | undefined => {
	const cfg = structuredClone(raw) as Record<string, unknown>;
	for (let pass = 0; pass < 5; pass++) {
		const errors = [...Value.Errors(WebToolsConfigSchema, cfg)];
		if (errors.length === 0) return cfg as WebToolsConfig;
		let deleted = false;
		for (const e of errors) {
			const segs = pointerSegments(e.instancePath);
			if (segs.length === 0) return undefined; // root itself invalid — unsalvageable
			if (deleteAtPointer(cfg, segs)) deleted = true;
		}
		if (!deleted) return undefined;
	}
	return Value.Check(WebToolsConfigSchema, cfg) ? (cfg as WebToolsConfig) : undefined;
};

// Tolerant read: loadJsonConfig already swallows JSON parse failures + EISDIR
// into `{}`; a schema violation then degrades PER FIELD via `salvageConfig`
// (whole-file `{}` only when nothing salvageable remains). Validation uses
// `Value.Check`/`Value.Errors` (no mutation) rather than `Value.Clean` (would
// strip unknown fields like the released `otherField` pass-through contract).
export function readConfig(): WebToolsConfig {
	const raw = loadJsonConfigWithLegacyFallback<unknown>("rpiv-web-tools");
	if (Value.Check(WebToolsConfigSchema, raw)) return raw as WebToolsConfig;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {} as WebToolsConfig;
	return salvageConfig(raw) ?? ({} as WebToolsConfig);
}

export function writeConfig(c: WebToolsConfig): boolean {
	return saveJsonConfig(CONFIG_PATH, c);
}

// Plan-surface no-op. Phase 4 omits the in-memory cache the plan sketched —
// the tests' direct-writeFileSync pattern makes per-test invalidation a
// rewrite-the-suite job for marginal perf gain. Kept exported so that
// consumers writing against the plan's API can call it without breaking.
export function invalidateConfigCache(): void {
	// no-op
}
