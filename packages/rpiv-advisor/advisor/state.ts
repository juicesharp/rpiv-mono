/**
 * state — in-memory advisor selection (model + effort). Resets each session;
 * the persisted form lives in config.ts, the blocklist cache in policy.ts.
 */

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";

let selectedAdvisor: Model<Api> | undefined;
let selectedAdvisorEffort: ThinkingLevel | undefined;

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
