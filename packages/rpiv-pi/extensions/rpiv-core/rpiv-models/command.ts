/**
 * rpiv-models/command — /rpiv-models cascade picker command handler.
 *
 * Scope picker → (descriptor.pickKey for key selection) → model picker → effort picker
 * → save (saveJsonConfig) → invalidate cache (invalidateModelsConfigCache).
 *
 * The handler reads as the cascade story; each step is a named helper below,
 * and scope-specific logic is dispatched through the SCOPES descriptor table.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
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
import {
	applyOverride,
	floatChecked,
	removeOverride,
	SCOPE_DEFAULTS,
	SCOPE_RESET_ALL,
	SCOPES,
	type ScopeDescriptor,
} from "./overrides.js";

export function registerRpivModelsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("rpiv-models", {
		description: "Configure model and reasoning overrides in ~/.config/rpiv-pi/models.json",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!requireInteractive(ctx)) return;

			// Raw config snapshot for ✓ decoration across the scope + key pickers.
			// Read once; no write happens during the interactive flow.
			const raw = loadRawConfig();

			const scope = await pickScope(ctx, raw);
			if (!scope) return;
			if (scope === SCOPE_RESET_ALL) return resetAllOverrides(ctx);

			const descriptor = SCOPES[scope];
			if (!descriptor) return; // Unknown scope — shouldn't happen
			const keyPath = await descriptor.pickKey(ctx, raw, pi);
			if (keyPath === null) return; // User cancelled

			const choice = await pickModel(ctx, descriptor, raw, keyPath);
			if (choice === null) return; // Cancelled or already-notified error
			if (choice === "reset") return resetOverride(ctx, scope, keyPath);

			const effort = await pickEffort(ctx, choice);
			if (effort === CANCELLED) return;

			saveOverride(ctx, scope, keyPath, modelKey(choice), effort);
		},
	});
}

// ---------------------------------------------------------------------------
// Cascade steps — each at a single level of abstraction
// ---------------------------------------------------------------------------

/** Guard: /rpiv-models needs an interactive UI. Notifies + returns false if not. */
function requireInteractive(ctx: ExtensionContext): boolean {
	if (ctx.hasUI) return true;
	ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
	return false;
}

/** First picker: which scope to override (defaults/agents/.../presets or reset-all). */
function pickScope(ctx: ExtensionContext, raw: ModelsConfigSchema): Promise<string | null> {
	return showFilterablePicker(ctx, {
		title: "Model Overrides",
		proseLines: ["Select scope."],
		items: floatChecked(scopeItems(raw)),
	});
}

/**
 * Model picker for the chosen scope+keyPath. Returns the picked model, the
 * `"reset"` sentinel when the user chose per-entry reset, or null when there
 * is nothing to act on (cancelled, no models available, or unknown model — the
 * latter two already surfaced their own error notify).
 */
async function pickModel(
	ctx: ExtensionContext,
	descriptor: ScopeDescriptor,
	raw: ModelsConfigSchema,
	keyPath: string[],
): Promise<Model<Api> | "reset" | null> {
	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) {
		ctx.ui.notify("No models available (no API keys configured?).", "error");
		return null;
	}
	const currentKey = descriptor.getCurrentKey(raw, keyPath);
	const items = buildModelItems(available, currentKey);
	// Offer per-entry reset for every scope (defaults included) so a single
	// override can be cleared without the all-or-nothing "reset all".
	items.push({ value: RESET_VALUE, label: RESET_LABEL });

	const choice = await showFilterablePicker(ctx, {
		title: "Model",
		proseLines: ["Select model."],
		items,
		preferredValue: currentKey ?? undefined,
	});
	if (!choice) return null;
	if (choice === RESET_VALUE) return "reset";

	const picked = available.find((m) => modelKey(m) === choice);
	if (!picked) {
		ctx.ui.notify(`Model not found: ${choice}`, "error");
		return null;
	}
	return picked;
}

/** Sentinel: the user cancelled the effort picker (distinct from "inherit"). */
const CANCELLED = Symbol("effort-cancelled");

/**
 * Effort picker. Non-reasoning models skip the prompt and inherit (undefined).
 * For reasoning models: CANCELLED if the user backed out, undefined for the
 * "inherit" sentinel (persist NO thinking field), or the chosen level — where
 * "off" persists thinking:"off" (disable reasoning), distinct from inherit.
 */
async function pickEffort(
	ctx: ExtensionContext,
	picked: Model<Api>,
): Promise<ModelThinkingLevelValue | undefined | typeof CANCELLED> {
	if (!picked.reasoning) return undefined;
	const choice = await showFilterablePicker(ctx, {
		title: "Reasoning Effort",
		proseLines: [`Select effort level for ${picked.name}.`],
		items: buildEffortItems(picked),
	});
	if (!choice) return CANCELLED;
	return choice === INHERIT_VALUE ? undefined : (choice as ModelThinkingLevelValue);
}

// ---------------------------------------------------------------------------
// Writes — load fresh, mutate, persist, notify
// ---------------------------------------------------------------------------

/** Clear every override after an explicit confirm (destructive + irreversible). */
async function resetAllOverrides(ctx: ExtensionContext): Promise<void> {
	// Gate behind a confirm dialog, mirroring /rpiv-setup's prune (the repo's
	// established destructive-action pattern).
	const confirmed = await ctx.ui.confirm(MSG_RESET_ALL_TITLE, MSG_RESET_ALL_BODY);
	if (!confirmed) {
		ctx.ui.notify(MSG_RESET_ALL_CANCELLED, "info");
		return;
	}
	if (persist(ctx, {})) ctx.ui.notify(MSG_RESET_ALL, "info");
}

/** Remove a single scope+keyPath override, reporting honestly when there was none. */
function resetOverride(ctx: ExtensionContext, scope: string, keyPath: string[]): void {
	const label = scopeLabel(scope, keyPath);
	const fresh = loadJsonConfig<ModelsConfigSchema>(CONFIG_PATH);
	const { next, removed } = removeOverride(fresh, scope, keyPath);
	if (!removed) {
		// Nothing to remove — report honestly, skip the no-op write + cache reset.
		ctx.ui.notify(`No override set for ${label}.`, "info");
		return;
	}
	if (persist(ctx, next)) ctx.ui.notify(`Removed ${label}.`, "info");
}

/** Write a model (+ optional effort) override for the chosen scope+keyPath. */
function saveOverride(
	ctx: ExtensionContext,
	scope: string,
	keyPath: string[],
	model: string,
	effort: ModelThinkingLevelValue | undefined,
): void {
	const fresh = loadJsonConfig<ModelsConfigSchema>(CONFIG_PATH);
	const next = applyOverride(fresh, scope, keyPath, { model, thinking: effort });
	if (persist(ctx, next)) {
		ctx.ui.notify(`Saved ${scopeLabel(scope, keyPath)} → ${model}${effort ? ` (${effort})` : ""}`, "info");
	}
}

/**
 * Persist a config to disk and invalidate the cache on success. Returns false
 * (after notifying) on write failure — the cache is left untouched so a failed
 * save never silently drops the in-memory state.
 */
function persist(ctx: ExtensionContext, next: ModelsConfigSchema): boolean {
	if (!saveJsonConfig(CONFIG_PATH, next)) {
		ctx.ui.notify(MSG_SAVE_FAILED, "error");
		return false;
	}
	invalidateModelsConfigCache();
	return true;
}

/** Human-readable label for a scope+keyPath (defaults has no key). */
function scopeLabel(scope: string, keyPath: string[]): string {
	return scope === SCOPE_DEFAULTS ? scope : `${scope}/${keyPath.join("/")}`;
}
