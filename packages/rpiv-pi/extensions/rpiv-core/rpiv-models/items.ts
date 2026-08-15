/**
 * rpiv-models/items — UI item builders and picker utilities for /rpiv-models.
 *
 * Pure functions that construct SelectItem arrays for the cascade pickers
 * (scope, key, model, effort), plus the picker sentinel values. User-facing
 * string constants live in overrides.ts with the rest of the command prose.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { SelectItem } from "@earendil-works/pi-tui";
import { loadJsonConfigWithLegacyFallback, modelKey } from "@juicesharp/rpiv-config";
import { type ModelsConfigSchema, THINKING_LEVEL_VALUES, type ThinkingLevelValue } from "../models-config.js";
import {
	CHECK,
	SCOPE_AGENTS,
	SCOPE_DEFAULTS,
	SCOPE_PRESETS,
	SCOPE_RESET_ALL,
	SCOPE_SKILLS,
	SCOPE_STAGES,
	SCOPES,
	withCheck,
} from "./overrides.js";

// ---------------------------------------------------------------------------
// Sentinel values
// ---------------------------------------------------------------------------

const RESET_VALUE = "__reset__";
const RESET_LABEL = "Reset to default";
// Effort sentinel: "inherit" persists NO thinking field (inherit baseline);
// distinct from the real "off" value, which persists thinking:"off" (disable).
const INHERIT_VALUE = "__inherit__";

// ---------------------------------------------------------------------------
// Re-exported sentinel values for command.ts
// ---------------------------------------------------------------------------

export { INHERIT_VALUE, RESET_LABEL, RESET_VALUE };

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

export function scopeItems(raw: ModelsConfigSchema): SelectItem[] {
	return [
		{ value: SCOPE_DEFAULTS, label: withCheck("defaults", SCOPES.defaults.hasOverride(raw)) },
		{ value: SCOPE_AGENTS, label: withCheck("agents", SCOPES.agents.hasOverride(raw)) },
		{ value: SCOPE_STAGES, label: withCheck("stages", SCOPES.stages.hasOverride(raw)) },
		{ value: SCOPE_SKILLS, label: withCheck("skills", SCOPES.skills.hasOverride(raw)) },
		{ value: SCOPE_PRESETS, label: withCheck("presets", SCOPES.presets.hasOverride(raw)) },
		{ value: SCOPE_RESET_ALL, label: "reset all overrides" },
	];
}

// Mirror: packages/rpiv-advisor/advisor/command.ts buildModelItems — structural
// twin kept in a separate package by the zero-cross-imports contract; evolve
// model-picker semantics together.
export function buildModelItems(models: Model<Api>[], currentKey?: string): SelectItem[] {
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

// Mirror: packages/rpiv-advisor/advisor/command.ts buildEffortItems — same
// filter-in/map-out shape, different sentinels and persist target; evolve
// level-picker semantics together.
export function buildEffortItems(picked: Model<Api>): SelectItem[] {
	const supported = getSupportedThinkingLevels(picked);
	const levels = supported.filter((l): l is ThinkingLevelValue => THINKING_LEVEL_VALUES.includes(l as never));
	// "inherit" (no override → session baseline) vs the real "off" (disable
	// reasoning) are distinct choices. "off" is offered only when the model
	// supports it (getSupportedThinkingLevels includes it).
	const items: SelectItem[] = [{ value: INHERIT_VALUE, label: "inherit (no override)" }];
	if (supported.includes("off")) items.push({ value: "off", label: "off (disable reasoning)" });
	return [...items, ...levels.map((level) => ({ value: level, label: level }))];
}

export function loadRawConfig(): ModelsConfigSchema {
	return loadJsonConfigWithLegacyFallback<ModelsConfigSchema>("rpiv-pi", "models.json");
}
