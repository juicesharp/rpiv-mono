/**
 * restore — session_start restoration. Loads persisted config, re-applies the
 * model/effort selection + blocklist, activates the tool when not blocked, and
 * announces once per process. Wired via registerAdvisorSessionStart.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey, parseModelKey } from "@juicesharp/rpiv-config";
import { loadAdvisorConfig, validateDisabledForModels, validateFallbackModels } from "./config.js";
import { reconcileAdvisorTool } from "./handlers.js";
import { ADVISOR_TOOL_NAME, errModelUnavailable, msgAdvisorRestored, msgAdvisorRestoredInactive } from "./messages.js";
import { isExecutorBlocked, setDisabledForModels } from "./policy.js";
import { setAdvisorEffort, setAdvisorFallbacks, setAdvisorModel } from "./state.js";

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

	// No usable advisor model → clear in-memory selection, then strip the tool
	// (and its prompt block) from the active set. Clearing state mirrors the
	// /advisor disable path (command.ts applyDisable): `selectedAdvisor` is
	// module-level and persists across session_start fires, so leaving it stale
	// would let the per-turn before_agent_start strip read a truthy model and
	// re-add the very tool we just stripped (e.g. a configured model removed
	// from the registry mid-process). The tool is registered active-by-default
	// at load, so its promptSnippet/promptGuidelines otherwise linger in the
	// base system prompt even though every advisor() call would fail with
	// ERR_NO_MODEL. See issue #72.
	const deactivate = (): void => {
		setAdvisorModel(undefined);
		setAdvisorEffort(undefined);
		setAdvisorFallbacks([]);
		reconcileAdvisorTool(pi, ctx, { blocked: true });
	};

	// Resolve config.fallbackModels (provider/id keys) to Model objects, dropping
	// entries that don't parse, aren't in the registry, or duplicate the primary.
	// Called after the primary model is set so the primary can be excluded.
	const resolveFallbacks = (primary: Model<Api>): void => {
		const seen = new Set<string>([modelKey(primary)]);
		const resolved: Model<Api>[] = [];
		for (const key of validateFallbackModels(config.fallbackModels)) {
			if (seen.has(key)) continue;
			const p = parseModelKey(key);
			if (!p) continue;
			const m = ctx.modelRegistry.find(p.provider, p.modelId);
			if (!m) continue;
			seen.add(key);
			resolved.push(m);
		}
		setAdvisorFallbacks(resolved);
	};

	if (!config.modelKey) {
		deactivate();
		return;
	}

	const parsed = parseModelKey(config.modelKey);
	if (!parsed) {
		deactivate();
		return;
	}

	const notifyOnce = (msg: string, level: "info" | "warning" | "error"): void => {
		if (!ctx.hasUI || restoreAnnounced) return;
		ctx.ui.notify(msg, level);
		restoreAnnounced = true;
	};

	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		deactivate();
		notifyOnce(errModelUnavailable(config.modelKey), "warning");
		return;
	}

	setAdvisorModel(model);
	resolveFallbacks(model);
	if (config.effort) {
		setAdvisorEffort(config.effort);
	}

	if (isExecutorBlocked(ctx, pi.getThinkingLevel())) {
		reconcileAdvisorTool(pi, ctx, { blocked: true });
		const advisorLabel = modelKey(model);
		notifyOnce(msgAdvisorRestoredInactive(advisorLabel, config.effort), "info");
		return;
	}

	const active = pi.getActiveTools();
	if (!active.includes(ADVISOR_TOOL_NAME)) {
		pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
	}

	notifyOnce(msgAdvisorRestored(modelKey(model), config.effort), "info");
}

export function registerAdvisorSessionStart(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		restoreAdvisorState(ctx, pi);
	});
}
