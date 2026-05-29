/**
 * policy — the disabledForModels blocklist (cache + setter) and the predicates
 * that decide whether the advisor tool is blocked for a given model/effort.
 */

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type DisabledForModelsEntry, modelKey } from "./config.js";
import { EFFORT_ORDINAL } from "./messages.js";

let disabledForModelsCache: DisabledForModelsEntry[] = [];

export function setDisabledForModels(models: DisabledForModelsEntry[]): void {
	disabledForModelsCache = models;
}

export function isModelBlocked(model: Model<Api> | undefined, thinkingLevel?: string): boolean {
	if (!model) return false;
	const key = modelKey(model);
	for (const entry of disabledForModelsCache) {
		if (typeof entry === "string") {
			if (entry === key) return true;
		} else {
			if (entry.model !== key) continue;
			if (entry.minEffort === undefined) return true;
			const thresholdOrdinal = EFFORT_ORDINAL.indexOf(entry.minEffort);
			const executorOrdinal = EFFORT_ORDINAL.indexOf(thinkingLevel as ThinkingLevel);
			if (executorOrdinal >= thresholdOrdinal) return true;
		}
	}
	return false;
}

export function isExecutorBlocked(ctx: ExtensionContext, thinkingLevel?: string): boolean {
	return isModelBlocked(ctx?.model, thinkingLevel);
}
