/**
 * models-config — TypeBox schema, loader, and codec for
 * ~/.config/rpiv-pi/models.json.
 *
 * Per-agent and per-stage model/effort overrides. Fail-soft: missing or
 * malformed JSON degrades to empty config (no overrides). Unknown model
 * strings pass through to modelRegistry.find — the host rejects what it
 * doesn't recognise.
 *
 * Follows the rpiv-telemetry/config.ts pattern: TypeBox schema → validateConfig →
 * per-field defaults. The config is cached after the first call (session-scoped) so edits
 * take effect on the next session start or /rpiv-update-agents.
 */

import { configPath, loadJsonConfig, validateConfig } from "@juicesharp/rpiv-config";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// ThinkingLevel — 5 values only (pi-ai/dist/types.d.ts:12).
// "off" belongs to ModelThinkingLevel, not ThinkingLevel, and is rejected
// by both the frontmatter seam and setThinkingLevel.
// ---------------------------------------------------------------------------

/** The 5 valid ThinkingLevel values accepted by models.json. */
export const THINKING_LEVEL_VALUES = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevelValue = (typeof THINKING_LEVEL_VALUES)[number];

// ---------------------------------------------------------------------------
// TypeBox schemas
// ---------------------------------------------------------------------------

const ThinkingLevelSchema = Type.Union(
	THINKING_LEVEL_VALUES.map((v) => Type.Literal(v)),
	{ description: "Effort/thinking level: minimal | low | medium | high | xhigh" },
);

/**
 * Model config leaf: either a bare model string ("provider:modelId")
 * or an object with optional thinking level.
 */
const ModelEntrySchema = Type.Union(
	[
		Type.String({ description: 'Model shorthand: "provider:modelId"' }),
		Type.Object(
			{
				model: Type.Optional(Type.String({ description: "Model in provider:modelId format" })),
				thinking: Type.Optional(ThinkingLevelSchema),
			},
			{ additionalProperties: false },
		),
	],
	{ description: "Model config: string shorthand or { model?, thinking? } object" },
);

/**
 * Top-level models.json schema.
 *
 * `defaults` cascades into both unconfigured agents and stages.
 * `agents` keys match bundled-agent filenames (sans .md).
 * `stages` keys match workflow stage names (the graph key, not skill).
 */
const ModelsConfigSchema = Type.Object(
	{
		defaults: Type.Optional(ModelEntrySchema),
		agents: Type.Optional(Type.Record(Type.String(), ModelEntrySchema)),
		stages: Type.Optional(Type.Record(Type.String(), ModelEntrySchema)),
	},
	{ additionalProperties: false },
);

type ModelsConfigSchema = Static<typeof ModelsConfigSchema>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Resolved model config entry — after schema validation and cascade. */
export interface ResolvedModelConfig {
	model?: string;
	thinking?: ThinkingLevelValue;
}

/** The resolved config shape returned by loadModelsConfig. */
export interface ModelsConfig {
	defaults?: ResolvedModelConfig;
	agents?: Record<string, ResolvedModelConfig>;
	stages?: Record<string, ResolvedModelConfig>;
}

// ---------------------------------------------------------------------------
// Helper — resolve a ModelEntry (string or object) to ResolvedModelConfig.
// ---------------------------------------------------------------------------

/** Resolve a raw ModelEntry value to a ResolvedModelConfig. */
function resolveModelEntry(entry: unknown): ResolvedModelConfig {
	if (typeof entry === "string") {
		return { model: entry };
	}
	if (typeof entry === "object" && entry !== null) {
		const obj = entry as Record<string, unknown>;
		const result: ResolvedModelConfig = {};
		if (typeof obj.model === "string") {
			result.model = obj.model;
		}
		if (typeof obj.thinking === "string") {
			if (THINKING_LEVEL_VALUES.includes(obj.thinking as ThinkingLevelValue)) {
				result.thinking = obj.thinking as ThinkingLevelValue;
			} else {
				console.warn(
					`[rpiv-pi] models.json: unknown thinking level "${obj.thinking}" — valid values: ${THINKING_LEVEL_VALUES.join(", ")}`,
				);
			}
		}
		return result;
	}
	return {};
}

// ---------------------------------------------------------------------------
// Config load — fail-soft, validate, cascade defaults
// ---------------------------------------------------------------------------

const CONFIG_PATH = configPath("rpiv-pi", "models.json");

/** Session-scoped cache — populated on first call, cleared by __resetModelsConfigCache(). */
let modelsConfigCache: ModelsConfig | undefined;

/** Load, validate, and resolve models.json. Returns empty config on any failure. */
export function loadModelsConfig(): ModelsConfig {
	if (modelsConfigCache !== undefined) return modelsConfigCache;

	const raw = loadJsonConfig<ModelsConfigSchema>(CONFIG_PATH);
	const validated = validateConfig(ModelsConfigSchema, raw);

	const defaults = resolvedEntry(validated.defaults);
	const agents: Record<string, ResolvedModelConfig> = {};
	const stages: Record<string, ResolvedModelConfig> = {};

	if (validated.agents && typeof validated.agents === "object") {
		for (const [name, entry] of Object.entries(validated.agents)) {
			agents[name] = resolvedEntryWithCascade(entry, defaults);
		}
	}

	if (validated.stages && typeof validated.stages === "object") {
		for (const [name, entry] of Object.entries(validated.stages)) {
			stages[name] = resolvedEntryWithCascade(entry, defaults);
		}
	}

	const result: ModelsConfig = {
		defaults,
		agents: Object.keys(agents).length > 0 ? agents : undefined,
		stages: Object.keys(stages).length > 0 ? stages : undefined,
	};
	modelsConfigCache = result;
	return result;
}

/** Test-only reset — wired into test/setup.ts beforeEach. */
export function __resetModelsConfigCache(): void {
	modelsConfigCache = undefined;
}

/** Resolve a single entry (no cascade). */
function resolvedEntry(entry: unknown): ResolvedModelConfig | undefined {
	if (entry === undefined || entry === null) return undefined;
	const resolved = resolveModelEntry(entry);
	if (Object.keys(resolved).length === 0) return undefined;
	return resolved;
}

/** Resolve with cascade: object fields override defaults. */
function resolvedEntryWithCascade(entry: unknown, defaults?: ResolvedModelConfig): ResolvedModelConfig {
	const resolved = resolveModelEntry(entry);
	return {
		...defaults,
		...resolved,
	};
}

// ---------------------------------------------------------------------------
// Query helpers — used by sync engine and lifecycle listener
// ---------------------------------------------------------------------------

/** Look up a per-agent override, falling back to defaults. */
export function getAgentModelConfig(config: ModelsConfig, agentName: string): ResolvedModelConfig | undefined {
	return config.agents?.[agentName] ?? config.defaults;
}

/** Look up a per-stage override, falling back to defaults. */
export function getStageModelConfig(config: ModelsConfig, stageName: string): ResolvedModelConfig | undefined {
	return config.stages?.[stageName] ?? config.defaults;
}
