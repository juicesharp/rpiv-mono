/**
 * config — persisted advisor config (~/.config/rpiv-advisor/advisor.json) and
 * the provider:id key codec. Owns the AdvisorConfig shape and load/validate/save.
 * The modelKey (join) / parseModelKey (split) inverse pair the codec relies on
 * lives in @juicesharp/rpiv-config.
 */

import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { configPath, loadJsonConfigWithLegacyFallback, saveJsonConfig } from "@juicesharp/rpiv-config";
import { EFFORT_ORDINAL, type GradedEffort } from "./messages.js";

const ADVISOR_CONFIG_PATH = configPath("rpiv-advisor", "advisor.json");

export type DisabledForModelsEntry = string | { model: string; minEffort?: GradedEffort };

interface AdvisorConfig {
	modelKey?: string;
	effort?: GradedEffort;
	guidance?: GuidanceFields;
	disabledForModels?: DisabledForModelsEntry[];
}

export function loadAdvisorConfig(): AdvisorConfig {
	return loadJsonConfigWithLegacyFallback<AdvisorConfig>("rpiv-advisor", "advisor.json");
}

export function validateDisabledForModels(value: unknown): DisabledForModelsEntry[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is DisabledForModelsEntry => {
		if (typeof entry === "string") return entry.length > 0;
		if (typeof entry !== "object" || entry === null) return false;
		const obj = entry as Record<string, unknown>;
		if (typeof obj.model !== "string" || obj.model.length === 0) return false;
		if (obj.minEffort !== undefined && !EFFORT_ORDINAL.includes(obj.minEffort as GradedEffort)) {
			// Warn before dropping — the entry's model identity is discarded along
			// with the bad threshold (mirrors models-config's warn-on-miss posture).
			console.warn(
				`[rpiv-advisor] advisor.json: unknown minEffort "${String(obj.minEffort)}" — dropping disabledForModels entry for "${obj.model}"`,
			);
			return false;
		}
		return true;
	});
}

export function saveAdvisorConfig(key: string | undefined, effort: GradedEffort | undefined): boolean {
	const existing = loadAdvisorConfig();
	const config: AdvisorConfig = { ...existing };
	// Delete (rather than omit) to clear fields that may exist in the spread
	// from a prior read. JSON.parse always produces configurable properties,
	// so delete is safe in strict mode.
	if (key) config.modelKey = key;
	else delete config.modelKey;
	if (effort) config.effort = effort;
	else delete config.effort;
	return saveJsonConfig(ADVISOR_CONFIG_PATH, config);
}
