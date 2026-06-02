/**
 * rpiv-models-command — /rpiv-models cascade picker.
 *
 * Scope picker → key picker (context-specific) → model picker → effort picker
 * → save (saveJsonConfig) → invalidate cache (__resetModelsConfigCache).
 *
 * Scope coverage matches the ModelsConfig surface widened in Phase 1:
 *   - defaults                       (no key picker)
 *   - agents / <name>                (BUNDLED_AGENTS_DIR readdir)
 *   - stages / <name>                (loadWorkflows().workflows[*].stages keys)
 *   - skills / <name>                (pi.getCommands() filter source==="skill",
 *                                     per Decision 8 — live registry)
 *   - presets / <wf> / stages / <s>  (workflow picker → stage picker per-wf)
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { configPath, loadJsonConfig, modelKey, saveJsonConfig } from "@juicesharp/rpiv-config";
import {
	__resetModelsConfigCache,
	type ModelThinkingLevelValue,
	THINKING_LEVEL_VALUES,
	type ThinkingLevelValue,
} from "./models-config.js";
import { bundledAgentNames, loadWorkflowMap, skillCommandNames } from "./models-config-sources.js";
import { showFilterablePicker } from "./models-picker.js";

const CONFIG_PATH = configPath("rpiv-pi", "models.json");

const SCOPE_DEFAULTS = "defaults";
const SCOPE_AGENTS = "agents";
const SCOPE_STAGES = "stages";
const SCOPE_SKILLS = "skills";
const SCOPE_PRESETS = "presets";
const SCOPE_RESET_ALL = "__reset_all__";
const RESET_VALUE = "__reset__";
const RESET_LABEL = "Reset to default";
// Effort sentinel: "inherit" persists NO thinking field (inherit baseline);
// distinct from the real "off" value, which persists thinking:"off" (disable).
const INHERIT_VALUE = "__inherit__";

/** Suffix appended to a picker label to mark "an override is set here". */
const CHECK = " ✓";
const withCheck = (label: string, has: boolean): string => (has ? `${label}${CHECK}` : label);

/** Stable partition: ✓-marked items float to the front, original order preserved. */
function floatChecked(items: SelectItem[]): SelectItem[] {
	const checked = items.filter((i) => i.label.endsWith(CHECK));
	const rest = items.filter((i) => !i.label.endsWith(CHECK));
	return [...checked, ...rest];
}

/** Build key-picker items: ✓-decorate via `has`, then float the marked ones up. */
function keyItems(names: string[], has: (name: string) => boolean): SelectItem[] {
	return floatChecked(names.map((n) => ({ value: n, label: withCheck(n, has(n)) })));
}

// `thinking` is the 6-value `ModelThinkingLevelValue` union (incl. "off") so the
// picker's persisted output mirrors the schema's runtime validation surface.
type RawModelEntry = string | { model?: string; thinking?: ModelThinkingLevelValue };

interface RawModelsConfig {
	defaults?: RawModelEntry;
	agents?: Record<string, RawModelEntry>;
	stages?: Record<string, RawModelEntry>;
	skills?: Record<string, RawModelEntry>;
	presets?: Record<string, { stages?: Record<string, RawModelEntry> }>;
}

function scopeItems(raw: RawModelsConfig): SelectItem[] {
	return [
		{ value: SCOPE_DEFAULTS, label: withCheck("defaults", scopeHasOverride(raw, SCOPE_DEFAULTS)) },
		{ value: SCOPE_AGENTS, label: withCheck("agents", scopeHasOverride(raw, SCOPE_AGENTS)) },
		{ value: SCOPE_STAGES, label: withCheck("stages", scopeHasOverride(raw, SCOPE_STAGES)) },
		{ value: SCOPE_SKILLS, label: withCheck("skills", scopeHasOverride(raw, SCOPE_SKILLS)) },
		{ value: SCOPE_PRESETS, label: withCheck("presets", scopeHasOverride(raw, SCOPE_PRESETS)) },
		{ value: SCOPE_RESET_ALL, label: "reset all overrides" },
	];
}

function buildModelItems(models: Model<Api>[], currentKey?: string): SelectItem[] {
	const items = models.map((m) => {
		const key = modelKey(m);
		const check = key === currentKey ? CHECK : "";
		return { value: key, label: `${m.name}  (${m.provider})${check}` };
	});
	// Float the current selection to the top (keeps its ✓). RESET_VALUE is
	// appended by the caller after this, so it stays last.
	if (currentKey) {
		const i = items.findIndex((it) => it.value === currentKey);
		if (i > 0) items.unshift(items.splice(i, 1)[0]);
	}
	return items;
}

function buildEffortItems(picked: Model<Api>): SelectItem[] {
	const supported = getSupportedThinkingLevels(picked);
	const levels = supported.filter((l): l is ThinkingLevelValue => THINKING_LEVEL_VALUES.includes(l as never));
	// "inherit" (no override → session baseline) vs the real "off" (disable
	// reasoning) are distinct choices. "off" is offered only when the model
	// supports it (getSupportedThinkingLevels includes it).
	const items: SelectItem[] = [{ value: INHERIT_VALUE, label: "inherit (no override)" }];
	if (supported.includes("off")) items.push({ value: "off", label: "off (disable reasoning)" });
	return [...items, ...levels.map((level) => ({ value: level, label: level }))];
}

function loadRawConfig(): RawModelsConfig {
	return loadJsonConfig<RawModelsConfig>(CONFIG_PATH);
}

/** True if the scope holds ≥1 override. (Post-prune ⇒ non-empty means real.) */
function scopeHasOverride(raw: RawModelsConfig, scope: string): boolean {
	if (scope === SCOPE_DEFAULTS) return raw.defaults !== undefined;
	const map = (raw as Record<string, unknown>)[scope] as Record<string, unknown> | undefined;
	return !!map && Object.keys(map).length > 0;
}

/**
 * True if a specific key under a scope holds an override. For presets, `key` is
 * a workflow name and "has override" means it carries ≥1 stage entry. Checks
 * presence, not `model`, so a thinking-only entry still reads as overridden.
 */
function keyHasOverride(raw: RawModelsConfig, scope: string, key: string): boolean {
	if (scope === SCOPE_PRESETS) {
		const stages = raw.presets?.[key]?.stages;
		return !!stages && Object.keys(stages).length > 0;
	}
	const map = (raw as Record<string, unknown>)[scope] as Record<string, unknown> | undefined;
	return !!map && key in map;
}

/** True if a preset workflow's specific stage holds an override. */
function presetStageHasOverride(raw: RawModelsConfig, wf: string, stage: string): boolean {
	return raw.presets?.[wf]?.stages?.[stage] !== undefined;
}

function getCurrentOverrideKey(scope: string, keyPath: string[]): string | undefined {
	const raw = loadRawConfig();
	if (scope === SCOPE_DEFAULTS) {
		const entry = raw.defaults;
		return typeof entry === "string" ? entry : entry?.model;
	}
	if (scope === SCOPE_AGENTS || scope === SCOPE_STAGES || scope === SCOPE_SKILLS) {
		const map = (raw as Record<string, unknown>)[scope] as Record<string, unknown> | undefined;
		if (!map) return undefined;
		const entry = map[keyPath[0]];
		return typeof entry === "string"
			? entry
			: ((entry as Record<string, unknown> | undefined)?.model as string | undefined);
	}
	if (scope === SCOPE_PRESETS) {
		const [wf, stage] = keyPath;
		const entry = raw.presets?.[wf]?.stages?.[stage];
		return typeof entry === "string" ? entry : entry?.model;
	}
	return undefined;
}

/**
 * Strip one override with cascading empty-container cleanup. Returns the new
 * config AND whether anything was actually removed — the handler branches its
 * notification on `removed` so a reset chosen on a key with no existing
 * override reports honestly instead of a misleading "Removed".
 */
export function removeOverride(
	config: RawModelsConfig,
	scope: string,
	keyPath: string[],
): { next: RawModelsConfig; removed: boolean } {
	const next: RawModelsConfig = { ...config };
	if (scope === SCOPE_DEFAULTS) {
		if (next.defaults === undefined) return { next, removed: false };
		delete next.defaults;
		return { next, removed: true };
	}
	if (scope === SCOPE_AGENTS || scope === SCOPE_STAGES || scope === SCOPE_SKILLS) {
		const map = (next as Record<string, unknown>)[scope] as Record<string, unknown> | undefined;
		if (!map || !(keyPath[0] in map)) return { next, removed: false };
		const updated: Record<string, unknown> = { ...map };
		delete updated[keyPath[0]];
		if (!Object.keys(updated).length) delete (next as Record<string, unknown>)[scope];
		else (next as Record<string, unknown>)[scope] = updated;
		return { next, removed: true };
	}
	if (scope === SCOPE_PRESETS) {
		const [wf, stage] = keyPath;
		if (next.presets?.[wf]?.stages?.[stage] === undefined) return { next, removed: false };
		const presets = { ...next.presets };
		const presetBlock = { ...presets[wf] };
		const stages = { ...presetBlock.stages };
		delete stages[stage];
		if (!Object.keys(stages).length) {
			delete presets[wf];
			if (!Object.keys(presets).length) delete next.presets;
			else next.presets = presets;
		} else {
			presetBlock.stages = stages;
			presets[wf] = presetBlock;
			next.presets = presets;
		}
		return { next, removed: true };
	}
	return { next, removed: false };
}

function applyOverride(
	config: RawModelsConfig,
	scope: string,
	keyPath: string[],
	entry: { model: string; thinking?: ModelThinkingLevelValue },
): RawModelsConfig {
	const next: RawModelsConfig = { ...config };
	if (scope === SCOPE_DEFAULTS) {
		next.defaults = entry.thinking ? { model: entry.model, thinking: entry.thinking } : entry.model;
		return next;
	}
	if (scope === SCOPE_AGENTS || scope === SCOPE_STAGES || scope === SCOPE_SKILLS) {
		const target = (next as Record<string, unknown>)[scope] as Record<string, unknown> | undefined;
		const updated: Record<string, unknown> = { ...(target ?? {}) };
		updated[keyPath[0]] = entry.thinking ? { model: entry.model, thinking: entry.thinking } : entry.model;
		(next as Record<string, unknown>)[scope] = updated;
		return next;
	}
	if (scope === SCOPE_PRESETS) {
		const [wf, stage] = keyPath;
		const presets = { ...(next.presets ?? {}) };
		const presetBlock = { ...(presets[wf] ?? {}) };
		const stages = { ...(presetBlock.stages ?? {}) };
		stages[stage] = entry.thinking ? { model: entry.model, thinking: entry.thinking } : entry.model;
		presetBlock.stages = stages;
		presets[wf] = presetBlock;
		next.presets = presets;
		return next;
	}
	return next;
}

const MSG_REQUIRES_INTERACTIVE = "/rpiv-models requires an interactive UI session.";
const MSG_SAVE_FAILED = "Failed to save models.json (disk error or permissions).";
const MSG_NO_SKILLS = "No skills registered; install or enable an extension that contributes skills.";
const MSG_NO_WORKFLOWS = "No workflows discovered; install rpiv-workflow or define a workflow first.";
const MSG_RESET_ALL = "All model overrides cleared.";
const MSG_RESET_ALL_TITLE = "Reset ALL model overrides?";
const MSG_RESET_ALL_BODY = [
	"This clears every override in `~/.config/rpiv-pi/models.json` (defaults,",
	"agents, stages, skills, presets). This cannot be undone.",
	"",
	"Per-agent overrides already written into agent frontmatter revert on the",
	"next agent sync / session start, not immediately.",
].join("\n");
const MSG_RESET_ALL_CANCELLED = "Reset cancelled.";

export function registerRpivModelsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("rpiv-models", {
		description: "Configure model and reasoning overrides in ~/.config/rpiv-pi/models.json",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
				return;
			}

			// Raw config snapshot for ✓ decoration across the scope + key pickers.
			// Read once; no write happens during the interactive flow.
			const raw = loadRawConfig();
			const scope = await showFilterablePicker(ctx, {
				title: "Model Overrides",
				proseLines: ["Select scope."],
				items: floatChecked(scopeItems(raw)),
			});
			if (!scope) return;

			if (scope === SCOPE_RESET_ALL) {
				// Destructive + irreversible — gate behind a confirm dialog, mirroring
				// /rpiv-setup's prune (the repo's established destructive-action pattern).
				const confirmed = await ctx.ui.confirm(MSG_RESET_ALL_TITLE, MSG_RESET_ALL_BODY);
				if (!confirmed) {
					ctx.ui.notify(MSG_RESET_ALL_CANCELLED, "info");
					return;
				}
				if (!saveJsonConfig(CONFIG_PATH, {})) {
					ctx.ui.notify(MSG_SAVE_FAILED, "error");
					return;
				}
				__resetModelsConfigCache();
				ctx.ui.notify(MSG_RESET_ALL, "info");
				return;
			}

			const keyPath: string[] = [];

			if (scope === SCOPE_AGENTS) {
				const items = keyItems(bundledAgentNames(), (n) => keyHasOverride(raw, SCOPE_AGENTS, n));
				if (items.length === 0) {
					ctx.ui.notify("No bundled agents found.", "error");
					return;
				}
				const picked = await showFilterablePicker(ctx, {
					title: "Agent",
					proseLines: ["Select agent."],
					items,
				});
				if (!picked) return;
				keyPath.push(picked);
			} else if (scope === SCOPE_STAGES) {
				const wfMap = await loadWorkflowMap(ctx.cwd);
				const stages = Array.from(new Set(Object.values(wfMap).flat())).sort();
				if (stages.length === 0) {
					ctx.ui.notify(MSG_NO_WORKFLOWS, "error");
					return;
				}
				const picked = await showFilterablePicker(ctx, {
					title: "Stage",
					proseLines: ["Select stage."],
					items: keyItems(stages, (s) => keyHasOverride(raw, SCOPE_STAGES, s)),
				});
				if (!picked) return;
				keyPath.push(picked);
			} else if (scope === SCOPE_SKILLS) {
				const names = skillCommandNames(pi);
				if (names.length === 0) {
					ctx.ui.notify(MSG_NO_SKILLS, "error");
					return;
				}
				const picked = await showFilterablePicker(ctx, {
					title: "Skill",
					proseLines: ["Select skill."],
					items: keyItems(names, (n) => keyHasOverride(raw, SCOPE_SKILLS, n)),
				});
				if (!picked) return;
				keyPath.push(picked);
			} else if (scope === SCOPE_PRESETS) {
				const wfMap = await loadWorkflowMap(ctx.cwd);
				const wfNames = Object.keys(wfMap).sort();
				if (wfNames.length === 0) {
					ctx.ui.notify(MSG_NO_WORKFLOWS, "error");
					return;
				}
				const wf = await showFilterablePicker(ctx, {
					title: "Workflow",
					proseLines: ["Select workflow."],
					items: keyItems(wfNames, (n) => keyHasOverride(raw, SCOPE_PRESETS, n)),
				});
				if (!wf) return;
				const stages = wfMap[wf] ?? [];
				if (stages.length === 0) {
					ctx.ui.notify(`Workflow "${wf}" has no stages.`, "error");
					return;
				}
				const stage = await showFilterablePicker(ctx, {
					title: `Stage — ${wf}`,
					proseLines: ["Select stage."],
					items: keyItems(stages, (s) => presetStageHasOverride(raw, wf, s)),
				});
				if (!stage) return;
				keyPath.push(wf, stage);
			}

			const available = ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify("No models available (no API keys configured?).", "error");
				return;
			}
			const currentKey = getCurrentOverrideKey(scope, keyPath);
			const items = buildModelItems(available, currentKey);
			// Offer per-entry reset for every scope (defaults included) so a single
			// override can be cleared without the all-or-nothing "reset all".
			items.push({ value: RESET_VALUE, label: RESET_LABEL });
			const modelChoice = await showFilterablePicker(ctx, {
				title: "Model",
				proseLines: ["Select model."],
				items,
				preferredValue: currentKey ?? undefined,
			});
			if (!modelChoice) return;

			if (modelChoice === RESET_VALUE) {
				const label = scope === SCOPE_DEFAULTS ? scope : `${scope}/${keyPath.join("/")}`;
				const fresh = loadJsonConfig<RawModelsConfig>(CONFIG_PATH);
				const { next: updated, removed } = removeOverride(fresh, scope, keyPath);
				if (!removed) {
					// Nothing to remove — report honestly, skip the no-op write + cache reset.
					ctx.ui.notify(`No override set for ${label}.`, "info");
					return;
				}
				if (!saveJsonConfig(CONFIG_PATH, updated)) {
					ctx.ui.notify(MSG_SAVE_FAILED, "error");
					return;
				}
				__resetModelsConfigCache();
				ctx.ui.notify(`Removed ${label}.`, "info");
				return;
			}
			const picked = available.find((m) => modelKey(m) === modelChoice);
			if (!picked) {
				ctx.ui.notify(`Model not found: ${modelChoice}`, "error");
				return;
			}

			// `effort === undefined` ⇒ persist NO thinking field (inherit baseline);
			// `effort === "off"` ⇒ persist thinking:"off" (disable reasoning).
			let effort: ModelThinkingLevelValue | undefined;
			if (picked.reasoning) {
				const effortChoice = await showFilterablePicker(ctx, {
					title: "Reasoning Effort",
					proseLines: [`Select effort level for ${picked.name}.`],
					items: buildEffortItems(picked),
				});
				if (!effortChoice) return;
				effort = effortChoice === INHERIT_VALUE ? undefined : (effortChoice as ModelThinkingLevelValue);
			}

			const fresh = loadJsonConfig<RawModelsConfig>(CONFIG_PATH);
			const updated = applyOverride(fresh, scope, keyPath, { model: modelKey(picked), thinking: effort });
			if (!saveJsonConfig(CONFIG_PATH, updated)) {
				ctx.ui.notify(MSG_SAVE_FAILED, "error");
				return;
			}
			__resetModelsConfigCache();

			const label = scope === SCOPE_DEFAULTS ? scope : `${scope}/${keyPath.join("/")}`;
			ctx.ui.notify(`Saved ${label} → ${modelKey(picked)}${effort ? ` (${effort})` : ""}`, "info");
		},
	});
}
