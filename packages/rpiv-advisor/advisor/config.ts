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

export interface AdvisorContextBudgetConfig {
	enabled?: boolean;
	responseReserveTokens?: number;
	keepFirst?: number;
	keepLast?: number;
	toolResultMaxChars?: number;
}

export interface AdvisorContextBudget {
	enabled: boolean;
	responseReserveTokens: number;
	keepFirst: number;
	keepLast: number;
	toolResultMaxChars: number;
}

interface AdvisorConfig {
	modelKey?: string;
	effort?: GradedEffort;
	guidance?: GuidanceFields;
	disabledForModels?: DisabledForModelsEntry[];
	contextBudget?: AdvisorContextBudgetConfig;
}

const DEFAULT_CONTEXT_BUDGET: AdvisorContextBudget = {
	enabled: true,
	responseReserveTokens: 16_384,
	keepFirst: 4,
	keepLast: 24,
	toolResultMaxChars: 12_000,
};

export function loadAdvisorConfig(): AdvisorConfig {
	return loadJsonConfigWithLegacyFallback<AdvisorConfig>("rpiv-advisor", "advisor.json");
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

export function resolveAdvisorContextBudget(value: unknown): AdvisorContextBudget {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_CONTEXT_BUDGET };
	const raw = value as AdvisorContextBudgetConfig;
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONTEXT_BUDGET.enabled,
		responseReserveTokens: boundedInteger(
			raw.responseReserveTokens,
			DEFAULT_CONTEXT_BUDGET.responseReserveTokens,
			1_024,
			1_000_000,
		),
		keepFirst: boundedInteger(raw.keepFirst, DEFAULT_CONTEXT_BUDGET.keepFirst, 0, 1_000),
		keepLast: boundedInteger(raw.keepLast, DEFAULT_CONTEXT_BUDGET.keepLast, 1, 1_000),
		toolResultMaxChars: boundedInteger(
			raw.toolResultMaxChars,
			DEFAULT_CONTEXT_BUDGET.toolResultMaxChars,
			256,
			1_000_000,
		),
	};
}

export function getAdvisorContextBudget(): AdvisorContextBudget {
	return resolveAdvisorContextBudget(loadAdvisorConfig().contextBudget);
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
