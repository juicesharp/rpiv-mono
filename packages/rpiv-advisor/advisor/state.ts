/**
 * state — in-memory advisor selection (model + effort). Resets each session;
 * the persisted form lives in config.ts, the blocklist cache in policy.ts.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { GradedEffort } from "./messages.js";

let selectedAdvisor: Model<Api> | undefined;
let selectedAdvisorEffort: GradedEffort | undefined;

export function getAdvisorModel(): Model<Api> | undefined {
	return selectedAdvisor;
}

export function setAdvisorModel(model: Model<Api> | undefined): void {
	selectedAdvisor = model;
}

export function getAdvisorEffort(): GradedEffort | undefined {
	return selectedAdvisorEffort;
}

export function setAdvisorEffort(effort: GradedEffort | undefined): void {
	selectedAdvisorEffort = effort;
}
