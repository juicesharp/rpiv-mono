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

import { configPath, loadJsonConfigWithLegacyFallback, validateConfig } from "@juicesharp/rpiv-config";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Thinking levels.
//
// The host's setThinkingLevel (pi-agent-core ThinkingLevel) AND agent
// frontmatter both accept "off" — "off" is a first-class level meaning "no
// reasoning" (it's even the session default). models.json therefore persists
// all SIX values. Note the distinction from ABSENCE: a missing `thinking`
// field means "inherit the session/baseline level"; an explicit "off" means
// "disable reasoning". THINKING_LEVEL_VALUES (the 5 reasoning levels) is kept
// for surfaces that list only the graded levels (e.g. the picker).
// ---------------------------------------------------------------------------

/** The 5 graded reasoning levels (excludes "off"). */
export const THINKING_LEVEL_VALUES = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevelValue = (typeof THINKING_LEVEL_VALUES)[number];

/** All 6 persistable thinking values, including the explicit "off" (disable reasoning). */
export const MODEL_THINKING_LEVEL_VALUES = ["off", ...THINKING_LEVEL_VALUES] as const;
export type ModelThinkingLevelValue = (typeof MODEL_THINKING_LEVEL_VALUES)[number];

// ---------------------------------------------------------------------------
// TypeBox schemas
// ---------------------------------------------------------------------------

const ThinkingLevelSchema = Type.Union(
	[
		Type.Literal("off"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
	] as const,
	{ description: "Effort/thinking level: off | minimal | low | medium | high | xhigh" },
);

// Guard: schema literals must stay in lockstep with MODEL_THINKING_LEVEL_VALUES.
// If either drifts, the bidirectional extends check fails and this won't compile.
type _ThinkingLevelsInSync =
	Static<typeof ThinkingLevelSchema> extends ModelThinkingLevelValue
		? ModelThinkingLevelValue extends Static<typeof ThinkingLevelSchema>
			? true
			: never
		: never;
const _thinkingLevelsInSync: _ThinkingLevelsInSync = true;

/**
 * Model config leaf: either a bare model string ("provider/modelId")
 * or an object with optional thinking level. Slash is canonical; legacy
 * colon-form ("provider:modelId") is still accepted on read by parseModelKey.
 */
const ModelEntrySchema = Type.Union(
	[
		Type.String({ description: 'Model shorthand: "provider/modelId" (colon-form accepted for back-compat)' }),
		Type.Object(
			{
				model: Type.Optional(
					Type.String({
						description: 'Model in "provider/modelId" format (colon-form accepted for back-compat)',
					}),
				),
				thinking: Type.Optional(ThinkingLevelSchema),
			},
			{ additionalProperties: false },
		),
	],
	{ description: "Model config: string shorthand or { model?, thinking? } object" },
);

/**
 * Per-preset block: stages-only. Per-preset agent overrides are
 * a non-goal — the agent-sync seam at `agents.ts:processSourceEntries` has no
 * workflow context at frontmatter-injection time. `additionalProperties: false`
 * rejects per-preset `defaults` or `agents` blocks at validation.
 */
const PresetSchema = Type.Object(
	{
		stages: Type.Optional(Type.Record(Type.String(), ModelEntrySchema)),
	},
	{ additionalProperties: false },
);

/**
 * Top-level models.json schema.
 *
 * `defaults` cascades into agents, stages, skills, and preset-stage entries.
 * `agents` keys match bundled-agent filenames (sans .md).
 * `stages` keys match workflow stage names (the graph key, not skill).
 * `skills` keys match the post-alias skill name (StageRef.skill on the
 * workflow path; the parsed name on the standalone-skill bracket path).
 * `presets` keys match workflow names; inner `stages` keys match stage
 * names within that workflow.
 *
 * `Type.Record(Type.String(), …)` wrappers are structurally dynamic and cannot
 * stamp `additionalProperties: false` — record-key typos (`presets.shipp`,
 * `skills.committ`) pass schema validation by design and fall through to the
 * defaults cascade at lookup. `findUnknownModelKeys` (wired into session_start
 * by models-config-validate.ts) is the runtime warn-on-miss safety net.
 */
const ModelsConfigSchema = Type.Object(
	{
		defaults: Type.Optional(ModelEntrySchema),
		agents: Type.Optional(Type.Record(Type.String(), ModelEntrySchema)),
		stages: Type.Optional(Type.Record(Type.String(), ModelEntrySchema)),
		skills: Type.Optional(Type.Record(Type.String(), ModelEntrySchema)),
		presets: Type.Optional(Type.Record(Type.String(), PresetSchema)),
	},
	{ additionalProperties: false },
);

export type ModelsConfigSchema = Static<typeof ModelsConfigSchema>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Resolved model config entry — after schema validation and cascade. */
export interface ResolvedModelConfig {
	model?: string;
	/** Explicit level incl. "off" (disable). Absent ⇒ inherit session/baseline. */
	thinking?: ModelThinkingLevelValue;
}

/** The resolved config shape returned by loadModelsConfig. */
export interface ModelsConfig {
	defaults?: ResolvedModelConfig;
	agents?: Record<string, ResolvedModelConfig>;
	stages?: Record<string, ResolvedModelConfig>;
	skills?: Record<string, ResolvedModelConfig>;
	presets?: Record<string, { stages?: Record<string, ResolvedModelConfig> }>;
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
			if (MODEL_THINKING_LEVEL_VALUES.includes(obj.thinking as ModelThinkingLevelValue)) {
				result.thinking = obj.thinking as ModelThinkingLevelValue;
			} else {
				console.warn(
					`[rpiv-pi] models.json: unknown thinking level "${obj.thinking}" — valid values: ${MODEL_THINKING_LEVEL_VALUES.join(", ")}`,
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

export const CONFIG_PATH = configPath("rpiv-pi", "models.json");

/** Session-scoped cache — populated on first call, cleared by invalidateModelsConfigCache(). */
let modelsConfigCache: ModelsConfig | undefined;

/** Load, validate, and resolve models.json. Returns empty config on any failure. */
export function loadModelsConfig(): ModelsConfig {
	if (modelsConfigCache !== undefined) return modelsConfigCache;

	const raw = loadJsonConfigWithLegacyFallback<ModelsConfigSchema>("rpiv-pi", "models.json");
	const validated = validateConfig(ModelsConfigSchema, raw);

	const defaults = resolvedEntry(validated.defaults);
	const agents: Record<string, ResolvedModelConfig> = {};
	const stages: Record<string, ResolvedModelConfig> = {};
	const skills: Record<string, ResolvedModelConfig> = {};
	const presets: Record<string, { stages?: Record<string, ResolvedModelConfig> }> = {};

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

	if (validated.skills && typeof validated.skills === "object") {
		for (const [name, entry] of Object.entries(validated.skills)) {
			skills[name] = resolvedEntryWithCascade(entry, defaults);
		}
	}

	if (validated.presets && typeof validated.presets === "object") {
		for (const [wf, presetBlock] of Object.entries(validated.presets)) {
			if (!presetBlock || typeof presetBlock !== "object") continue;
			const presetStages: Record<string, ResolvedModelConfig> = {};
			if (presetBlock.stages && typeof presetBlock.stages === "object") {
				for (const [stageName, entry] of Object.entries(presetBlock.stages)) {
					presetStages[stageName] = resolvedEntryWithCascade(entry, defaults);
				}
			}
			if (Object.keys(presetStages).length > 0) {
				presets[wf] = { stages: presetStages };
			}
		}
	}

	const result: ModelsConfig = {
		defaults,
		agents: Object.keys(agents).length > 0 ? agents : undefined,
		stages: Object.keys(stages).length > 0 ? stages : undefined,
		skills: Object.keys(skills).length > 0 ? skills : undefined,
		presets: Object.keys(presets).length > 0 ? presets : undefined,
	};
	modelsConfigCache = result;
	return result;
}

/** Invalidate the session-scoped models.json cache. Called in production by
 *  /rpiv-update-agents and /rpiv-models after config mutations, and in tests
 *  via test/setup.ts beforeEach. */
export function invalidateModelsConfigCache(): void {
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

/**
 * Per-stage cascade lookup, used by the workflow lifecycle path and the
 * standalone-skill bracket. Object-arg shape supersedes positional widening
 * as new axes land (positional `(config, stage, workflow?, skill?)` doesn't
 * scale).
 *
 * Cascade (most-specific first):
 *   1. presets[workflow].stages[stage]   — preset-stage authored
 *   2. stages[stage]                     — per-stage
 *   3. skills[skill]                     — per-skill (post-alias target)
 *   4. defaults                          — fallback
 *
 * Each layer was already composed against `defaults` at load time
 * (`resolvedEntryWithCascade`), so falling through layers never loses a field.
 * Two configured layers do NOT per-field merge with each other — whole-entry
 * replace at lookup (same asymmetry as today, documented at
 * models-config.test.ts:226-230).
 *
 * Pass `workflow: undefined` to skip the preset rung (e.g. standalone-skill
 * bracket, agent-sync path); pass `skill: undefined` to skip the skill rung
 * (e.g. script stages with no skill); pass `stage: undefined` to skip the
 * stage rung. All missing → returns `config.defaults`.
 */
export function resolveStageModel(
	config: ModelsConfig,
	args: { workflow?: string; stage?: string; skill?: string },
): ResolvedModelConfig | undefined {
	const { workflow, stage, skill } = args;
	if (workflow && stage) {
		const presetStage = config.presets?.[workflow]?.stages?.[stage];
		if (presetStage) return presetStage;
	}
	if (stage) {
		const flatStage = config.stages?.[stage];
		if (flatStage) return flatStage;
	}
	if (skill) {
		const perSkill = config.skills?.[skill];
		if (perSkill) return perSkill;
	}
	return config.defaults;
}

// ---------------------------------------------------------------------------
// Warn-on-miss — surface record-key typos that schema validation can't catch.
// ---------------------------------------------------------------------------

/**
 * Known valid keys per axis, supplied by the call site that can determine them
 * (bundled-agent readdir, skill registry, workflow loader). An axis whose list
 * is `undefined` is SKIPPED — its key universe couldn't be determined (e.g.
 * rpiv-workflow absent → `stages`/`workflows` unknown), so its configured keys
 * are never falsely reported as unknown.
 */
export interface KnownModelKeys {
	agents?: readonly string[];
	stages?: readonly string[];
	skills?: readonly string[];
	workflows?: readonly string[];
	stagesByWorkflow?: Record<string, readonly string[]>;
}

/**
 * Return dotted paths of configured models.json keys that match no known key —
 * e.g. `skills.committ`, `agents.codebase-analzyer`, `presets.shipp`,
 * `presets.ship.stages.plann`. Record-key typos pass TypeBox validation
 * (records are structurally dynamic) and silently fall through to the defaults
 * cascade; this surfaces them. Axes with an `undefined` known-list are skipped;
 * an unknown preset workflow short-circuits (its inner stages aren't validated
 * against an absent stage list).
 */
export function findUnknownModelKeys(config: ModelsConfig, known: KnownModelKeys): string[] {
	const unknown: string[] = [];
	const check = (
		obj: Record<string, unknown> | undefined,
		valid: readonly string[] | undefined,
		prefix: string,
	): void => {
		if (!obj || !valid) return;
		const set = new Set(valid);
		for (const key of Object.keys(obj)) {
			if (!set.has(key)) unknown.push(`${prefix}.${key}`);
		}
	};

	check(config.agents, known.agents, "agents");
	check(config.stages, known.stages, "stages");
	check(config.skills, known.skills, "skills");

	if (config.presets && known.workflows) {
		const wfSet = new Set(known.workflows);
		for (const [wf, block] of Object.entries(config.presets)) {
			if (!wfSet.has(wf)) {
				unknown.push(`presets.${wf}`);
				continue; // unknown workflow — can't validate its inner stages
			}
			check(block.stages, known.stagesByWorkflow?.[wf], `presets.${wf}.stages`);
		}
	}

	return unknown;
}
