/**
 * rpiv-models/command — /rpiv-models cascade picker command handler.
 *
 * Scope picker → (descriptor.pickKey for key selection) → model picker → effort picker
 * → save (saveJsonConfig) → invalidate cache (invalidateModelsConfigCache).
 *
 * The handler dispatches scope-specific logic through the SCOPES descriptor table;
 * no inline scope branching remains.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadJsonConfig, modelKey, saveJsonConfig } from "@juicesharp/rpiv-config";
import {
	CONFIG_PATH,
	invalidateModelsConfigCache,
	type ModelsConfigSchema,
	type ModelThinkingLevelValue,
} from "../models-config.js";
import { showFilterablePicker } from "../models-picker.js";
import {
	buildEffortItems,
	buildModelItems,
	INHERIT_VALUE,
	loadRawConfig,
	MSG_REQUIRES_INTERACTIVE,
	MSG_RESET_ALL,
	MSG_RESET_ALL_BODY,
	MSG_RESET_ALL_CANCELLED,
	MSG_RESET_ALL_TITLE,
	MSG_SAVE_FAILED,
	RESET_LABEL,
	RESET_VALUE,
	scopeItems,
} from "./items.js";
import { applyOverride, floatChecked, removeOverride, SCOPE_DEFAULTS, SCOPE_RESET_ALL, SCOPES } from "./overrides.js";

export function registerRpivModelsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("rpiv-models", {
		description: "Configure model and reasoning overrides in ~/.config/rpiv-pi/models.json",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
				return;
			}

			// Raw config snapshot for ✓ decoration across the scope + key pickers.
			// Read once; no write happens during the interactive flow.
			const raw = loadRawConfig();
			const scope = await showFilterablePicker(ctx, {
				title: "Model Overrides",
				proseLines: ["Select scope."],
				items: floatChecked(scopeItems(raw)),
			});
			if (!scope) return;

			if (scope === SCOPE_RESET_ALL) {
				// Destructive + irreversible — gate behind a confirm dialog, mirroring
				// /rpiv-setup's prune (the repo's established destructive-action pattern).
				const confirmed = await ctx.ui.confirm(MSG_RESET_ALL_TITLE, MSG_RESET_ALL_BODY);
				if (!confirmed) {
					ctx.ui.notify(MSG_RESET_ALL_CANCELLED, "info");
					return;
				}
				if (!saveJsonConfig(CONFIG_PATH, {})) {
					ctx.ui.notify(MSG_SAVE_FAILED, "error");
					return;
				}
				invalidateModelsConfigCache();
				ctx.ui.notify(MSG_RESET_ALL, "info");
				return;
			}

			// Dispatch key-picking through the scope descriptor.
			const descriptor = SCOPES[scope];
			if (!descriptor) return; // Unknown scope — shouldn't happen
			const keyPath = await descriptor.pickKey(ctx, raw, pi);
			if (keyPath === null) return; // User cancelled

			const available = ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify("No models available (no API keys configured?).", "error");
				return;
			}
			const currentKey = descriptor.getCurrentKey(raw, keyPath);
			const items = buildModelItems(available, currentKey);
			// Offer per-entry reset for every scope (defaults included) so a single
			// override can be cleared without the all-or-nothing "reset all".
			items.push({ value: RESET_VALUE, label: RESET_LABEL });
			const modelChoice = await showFilterablePicker(ctx, {
				title: "Model",
				proseLines: ["Select model."],
				items,
				preferredValue: currentKey ?? undefined,
			});
			if (!modelChoice) return;

			if (modelChoice === RESET_VALUE) {
				const label = scope === SCOPE_DEFAULTS ? scope : `${scope}/${keyPath.join("/")}`;
				const fresh = loadJsonConfig<ModelsConfigSchema>(CONFIG_PATH);
				const { next: updated, removed } = removeOverride(fresh, scope, keyPath);
				if (!removed) {
					// Nothing to remove — report honestly, skip the no-op write + cache reset.
					ctx.ui.notify(`No override set for ${label}.`, "info");
					return;
				}
				if (!saveJsonConfig(CONFIG_PATH, updated)) {
					ctx.ui.notify(MSG_SAVE_FAILED, "error");
					return;
				}
				invalidateModelsConfigCache();
				ctx.ui.notify(`Removed ${label}.`, "info");
				return;
			}
			const picked = available.find((m) => modelKey(m) === modelChoice);
			if (!picked) {
				ctx.ui.notify(`Model not found: ${modelChoice}`, "error");
				return;
			}

			// `effort === undefined` ⇒ persist NO thinking field (inherit baseline);
			// `effort === "off"` ⇒ persist thinking:"off" (disable reasoning).
			let effort: ModelThinkingLevelValue | undefined;
			if (picked.reasoning) {
				const effortChoice = await showFilterablePicker(ctx, {
					title: "Reasoning Effort",
					proseLines: [`Select effort level for ${picked.name}.`],
					items: buildEffortItems(picked),
				});
				if (!effortChoice) return;
				effort = effortChoice === INHERIT_VALUE ? undefined : (effortChoice as ModelThinkingLevelValue);
			}

			const fresh = loadJsonConfig<ModelsConfigSchema>(CONFIG_PATH);
			const updated = applyOverride(fresh, scope, keyPath, { model: modelKey(picked), thinking: effort });
			if (!saveJsonConfig(CONFIG_PATH, updated)) {
				ctx.ui.notify(MSG_SAVE_FAILED, "error");
				return;
			}
			invalidateModelsConfigCache();

			const label = scope === SCOPE_DEFAULTS ? scope : `${scope}/${keyPath.join("/")}`;
			ctx.ui.notify(`Saved ${label} → ${modelKey(picked)}${effort ? ` (${effort})` : ""}`, "info");
		},
	});
}
