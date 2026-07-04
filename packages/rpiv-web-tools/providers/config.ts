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
 * rpiv-config): malformed JSON, EISDIR, or a hard schema violation all
 * degrade to `{}`. The orchestrator never has to handle "config blew up at
 * startup."
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

// Tolerant read: loadJsonConfig already swallows JSON parse failures + EISDIR
// into `{}`; we then run a schema check that — on hard failure — falls back to
// the same `{}`. Validation uses `Value.Check` (no mutation) rather than
// `Value.Clean` (would strip unknown fields like the released `otherField`
// pass-through contract).
export function readConfig(): WebToolsConfig {
	const raw = loadJsonConfigWithLegacyFallback<unknown>("rpiv-web-tools");
	if (!Value.Check(WebToolsConfigSchema, raw)) {
		return {} as WebToolsConfig;
	}
	return raw as WebToolsConfig;
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
