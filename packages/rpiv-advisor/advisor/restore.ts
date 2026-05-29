/**
 * restore — session_start restoration. Loads persisted config, re-applies the
 * model/effort selection + blocklist, activates the tool when not blocked, and
 * announces once per process. Wired via registerAdvisorSessionStart.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAdvisorConfig, parseModelKey, validateDisabledForModels } from "./config.js";
import { ADVISOR_TOOL_NAME, errModelUnavailable, msgAdvisorRestored, msgAdvisorRestoredInactive } from "./messages.js";
import { isExecutorBlocked, setDisabledForModels } from "./policy.js";
import { setAdvisorEffort, setAdvisorModel } from "./state.js";

/**
 * Module-local "already announced" latch. Pi fires `session_start` for every
 * session including programmatic spawns (workflow stages, batch ops, any
 * extension's `newSession` call). State mutation belongs on every fire;
 * the user-facing announcement does NOT — repeating it per stage in a
 * `/wf` run just spams the status line. The latch flips on the first
 * notify and stays set until the module is reloaded (`/reload`) or the
 * process restarts. Test-resettable via `__resetAdvisorAnnounced()`.
 */
let restoreAnnounced = false;

/** Test reset — wired into test/setup.ts `beforeEach`. */
export function __resetAdvisorAnnounced(): void {
	restoreAnnounced = false;
}

export function restoreAdvisorState(ctx: ExtensionContext, pi: ExtensionAPI): void {
	const config = loadAdvisorConfig();

	setDisabledForModels(validateDisabledForModels(config.disabledForModels));

	if (!config.modelKey) return;

	const parsed = parseModelKey(config.modelKey);
	if (!parsed) return;

	const notifyOnce = (msg: string, level: "info" | "warning" | "error"): void => {
		if (!ctx.hasUI || restoreAnnounced) return;
		ctx.ui.notify(msg, level);
		restoreAnnounced = true;
	};

	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		notifyOnce(errModelUnavailable(config.modelKey), "warning");
		return;
	}

	setAdvisorModel(model);
	if (config.effort) {
		setAdvisorEffort(config.effort);
	}

	if (isExecutorBlocked(ctx, pi.getThinkingLevel())) {
		const advisorLabel = `${model.provider}:${model.id}`;
		notifyOnce(msgAdvisorRestoredInactive(advisorLabel, config.effort), "info");
		return;
	}

	const active = pi.getActiveTools();
	if (!active.includes(ADVISOR_TOOL_NAME)) {
		pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
	}

	notifyOnce(msgAdvisorRestored(`${model.provider}:${model.id}`, config.effort), "info");
}

export function registerAdvisorSessionStart(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		restoreAdvisorState(ctx, pi);
	});
}
