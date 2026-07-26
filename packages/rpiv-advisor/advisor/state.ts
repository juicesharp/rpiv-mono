/**
 * state — in-memory advisor selection (model + effort + fallback chain).
 * Resets each session; the persisted form lives in config.ts, the blocklist
 * cache in policy.ts.
 */

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";

let selectedAdvisor: Model<Api> | undefined;
let selectedAdvisorEffort: ThinkingLevel | undefined;
// Ordered fallback chain, resolved from config.fallbackModels at session_start
// (restore.ts). Tried in order when the primary advisor call fails or the model
// declines (a refusal reaches execute.ts as stopReason "error"; see execute.ts).
let selectedAdvisorFallbacks: Model<Api>[] = [];

export function getAdvisorModel(): Model<Api> | undefined {
	return selectedAdvisor;
}

export function setAdvisorModel(model: Model<Api> | undefined): void {
	selectedAdvisor = model;
}

export function getAdvisorEffort(): ThinkingLevel | undefined {
	return selectedAdvisorEffort;
}

export function setAdvisorEffort(effort: ThinkingLevel | undefined): void {
	selectedAdvisorEffort = effort;
}

export function getAdvisorFallbacks(): Model<Api>[] {
	return selectedAdvisorFallbacks;
}

export function setAdvisorFallbacks(models: Model<Api>[]): void {
	selectedAdvisorFallbacks = models;
}
