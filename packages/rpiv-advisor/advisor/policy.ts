/**
 * policy — the disabledForModels blocklist (cache + setter) and the predicates
 * that decide whether the advisor tool is blocked for a given model/effort.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey, parseModelKey } from "@juicesharp/rpiv-config";
import type { DisabledForModelsEntry } from "./config.js";
import { EFFORT_ORDINAL, type GradedEffort } from "./messages.js";

let disabledForModelsCache: DisabledForModelsEntry[] = [];

export function setDisabledForModels(models: DisabledForModelsEntry[]): void {
	disabledForModelsCache = models;
}

/**
 * Normalise a stored blocklist entry's model key to the canonical slash form.
 * Tolerates legacy colon-form persisted lists so `disabledForModels:
 * ["anthropic:sonnet"]` keeps blocking post-slash-canonical-migration without
 * requiring a re-save. Pass-through for already-canonical (slash) values and
 * for malformed input.
 */
function canonicalKey(entry: string): string {
	const parsed = parseModelKey(entry);
	return parsed ? `${parsed.provider}/${parsed.modelId}` : entry;
}

/**
 * True when `model` is on the disabledForModels blocklist at the executor's
 * current thinking level. Fail-soft ranking contract: an executor level that
 * is unset, "off", or unknown to EFFORT_ORDINAL yields indexOf −1, ranking
 * below every minEffort threshold — such levels never block.
 */
export function isModelBlocked(model: Model<Api> | undefined, thinkingLevel?: string): boolean {
	if (!model) return false;
	const key = modelKey(model);
	for (const entry of disabledForModelsCache) {
		if (typeof entry === "string") {
			if (canonicalKey(entry) === key) return true;
		} else {
			if (canonicalKey(entry.model) !== key) continue;
			if (entry.minEffort === undefined) return true;
			const thresholdOrdinal = EFFORT_ORDINAL.indexOf(entry.minEffort);
			// A threshold unknown to the ordinal cannot rank; skip the entry —
			// otherwise its indexOf -1 would equal an unknown executor's -1 and
			// block, breaking the "unknown never blocks" contract above.
			if (thresholdOrdinal === -1) continue;
			const executorOrdinal = EFFORT_ORDINAL.indexOf(thinkingLevel as GradedEffort);
			if (executorOrdinal >= thresholdOrdinal) return true;
		}
	}
	return false;
}

export function isExecutorBlocked(ctx: ExtensionContext, thinkingLevel?: string): boolean {
	return isModelBlocked(ctx?.model, thinkingLevel);
}
