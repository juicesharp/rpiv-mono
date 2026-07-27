/**
 * config — persisted advisor config (~/.config/rpiv-advisor/advisor.json) and
 * the provider:id key codec. Owns the AdvisorConfig shape, load/validate/save,
 * and the modelKey (join) / parseModelKey (split) inverse pair (L4-04).
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { configPath, loadJsonConfigWithLegacyFallback, saveJsonConfig } from "@juicesharp/rpiv-config";
import { EFFORT_ORDINAL } from "./messages.js";

const ADVISOR_CONFIG_PATH = configPath("rpiv-advisor", "advisor.json");

export type DisabledForModelsEntry = string | { model: string; minEffort?: ThinkingLevel };

interface AdvisorConfig {
	modelKey?: string;
	effort?: ThinkingLevel;
	guidance?: GuidanceFields;
	disabledForModels?: DisabledForModelsEntry[];
	// Ordered list of provider/id keys tried when the primary advisor call fails
	// or the model declines. Resolved to Model objects at session_start
	// (restore.ts). Config-file driven; preserved across /advisor model changes
	// because saveAdvisorConfig spreads the existing config.
	fallbackModels?: string[];
}

export function loadAdvisorConfig(): AdvisorConfig {
	return loadJsonConfigWithLegacyFallback<AdvisorConfig>("rpiv-advisor", "advisor.json");
}

export function validateFallbackModels(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function validateDisabledForModels(value: unknown): DisabledForModelsEntry[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is DisabledForModelsEntry => {
		if (typeof entry === "string") return entry.length > 0;
		if (typeof entry !== "object" || entry === null) return false;
		const obj = entry as Record<string, unknown>;
		if (typeof obj.model !== "string" || obj.model.length === 0) return false;
		if (obj.minEffort !== undefined && !EFFORT_ORDINAL.includes(obj.minEffort as ThinkingLevel)) return false;
		return true;
	});
}

export function saveAdvisorConfig(key: string | undefined, effort: ThinkingLevel | undefined): boolean {
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
