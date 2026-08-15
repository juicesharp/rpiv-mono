/**
 * command — the /advisor slash command. Reads top-down: interactive guard →
 * model picker (buildModelItems) → no-advisor branch (applyDisable) → model
 * lookup → effort picker (buildEffortItems) → enable (applyEnable). The apply
 * helpers persist before mutating in-memory state — a save failure must never
 * leave memory ahead of disk.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { modelKey } from "@juicesharp/rpiv-config";
import { showAdvisorPicker, showEffortPicker } from "../advisor-ui.js";
import { saveAdvisorConfig } from "./config.js";
import { reconcileAdvisorTool } from "./handlers.js";
import {
	ADVISOR_TOOL_NAME,
	CHECKMARK,
	DEFAULT_EFFORT,
	EFFORT_ORDINAL,
	errSelectionNotFound,
	type GradedEffort,
	MSG_ADVISOR_DISABLED,
	MSG_EFFORT_NOT_SET,
	MSG_PERSIST_FAILED,
	MSG_REQUIRES_INTERACTIVE,
	msgAdvisorEnabled,
	msgAdvisorEnabledInactive,
	NO_ADVISOR_VALUE,
	OFF_VALUE,
	RECOMMENDED_EFFORT_SUFFIX,
} from "./messages.js";
import { isExecutorBlocked } from "./policy.js";
import { getAdvisorEffort, getAdvisorModel, setAdvisorEffort, setAdvisorModel } from "./state.js";

// Mirror: packages/rpiv-pi/extensions/rpiv-core/rpiv-models/items.ts
// buildModelItems — structural twin kept in a separate package by the
// zero-cross-imports contract; evolve model-picker semantics together.
function buildModelItems(availableModels: Model<Api>[], currentKey: string | undefined): SelectItem[] {
	const items: SelectItem[] = availableModels.map((m) => {
		const key = modelKey(m);
		const check = key === currentKey ? CHECKMARK : "";
		return { value: key, label: `${m.name}  (${m.provider})${check}` };
	});
	items.push({
		value: NO_ADVISOR_VALUE,
		label: currentKey === undefined ? `No advisor${CHECKMARK}` : "No advisor",
	});
	return items;
}

// Mirror: packages/rpiv-pi/extensions/rpiv-core/rpiv-models/items.ts
// buildEffortItems — same filter-in/map-out shape, different sentinels and
// persist target; evolve level-picker semantics together.
function buildEffortItems(picked: Model<Api>): SelectItem[] {
	// Intersect with EFFORT_ORDINAL (which excludes "off") so the picker can
	// never offer — hence saveAdvisorConfig can never persist — a level that
	// minEffort blocklist comparisons don't rank.
	const levels = getSupportedThinkingLevels(picked).filter((level): level is GradedEffort =>
		EFFORT_ORDINAL.includes(level as GradedEffort),
	);
	return [
		// "off (no reasoning sent)" ≠ /rpiv-models' "off (disable reasoning)":
		// this row sends NO reasoning option; /rpiv-models persists thinking:"off".
		{ value: OFF_VALUE, label: "off (no reasoning sent)" },
		...levels.map((level) => ({
			value: level,
			label: level === DEFAULT_EFFORT ? `${level}${RECOMMENDED_EFFORT_SUFFIX}` : level,
		})),
	];
}

// Disable path — persist BEFORE mutating in-memory state so a save failure
// can't strand "model=undefined + tool still registered". The strip
// is unconditional-on-presence (no advisor at all), so it stays inline rather
// than routing through reconcileAdvisorTool's blocked-conditional path.
function applyDisable(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!saveAdvisorConfig(undefined, undefined)) {
		ctx.ui.notify(MSG_PERSIST_FAILED, "error");
		return;
	}
	setAdvisorModel(undefined);
	setAdvisorEffort(undefined);
	const active = pi.getActiveTools();
	if (active.includes(ADVISOR_TOOL_NAME)) {
		pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
	}
	ctx.ui.notify(MSG_ADVISOR_DISABLED, "info");
}

// Enable path — persist first, set in-memory state, activate via
// reconcileAdvisorTool (which re-reads the active-tool list post-effort-picker-
// await), and notify. Silent reconcile — the enable/inactive notify is the
// single trailing notify call here.
function applyEnable(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	picked: Model<Api>,
	effort: GradedEffort | undefined,
): void {
	if (!saveAdvisorConfig(modelKey(picked), effort)) {
		ctx.ui.notify(MSG_PERSIST_FAILED, "error");
		return;
	}
	setAdvisorEffort(effort);
	setAdvisorModel(picked);

	const blocked = isExecutorBlocked(ctx, pi.getThinkingLevel());
	reconcileAdvisorTool(pi, ctx, { blocked });
	ctx.ui.notify(
		blocked ? msgAdvisorEnabledInactive(modelKey(picked), effort) : msgAdvisorEnabled(modelKey(picked), effort),
		"info",
	);
}

export function registerAdvisorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("advisor", {
		description: "Configure the advisor model for the advisor-strategy pattern",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
				return;
			}

			const availableModels = ctx.modelRegistry.getAvailable();
			const current = getAdvisorModel();
			const currentKey = current ? modelKey(current) : undefined;

			const choice = await showAdvisorPicker(ctx, buildModelItems(availableModels, currentKey));
			if (!choice) return;

			if (choice === NO_ADVISOR_VALUE) {
				applyDisable(pi, ctx);
				return;
			}

			const picked = availableModels.find((m) => modelKey(m) === choice);
			if (!picked) {
				ctx.ui.notify(errSelectionNotFound(choice), "error");
				return;
			}

			// Effort picker — only for reasoning-capable models
			let effortChoice: GradedEffort | undefined;
			if (picked.reasoning) {
				const effortResult = await showEffortPicker(
					ctx,
					buildEffortItems(picked),
					getAdvisorEffort(),
					DEFAULT_EFFORT,
				);
				if (!effortResult) {
					// Esc at the effort step keeps the model selection — cancelling
					// one step never discards prior choices (the invariant shared
					// with the /rpiv-models stepper). The divergence is deliberate:
					// that twin backs up without writing, while here the enable
					// proceeds and PERSISTS with no explicit effort (model default),
					// announced by this notify before the write.
					ctx.ui.notify(MSG_EFFORT_NOT_SET, "info");
				} else {
					effortChoice = effortResult === OFF_VALUE ? undefined : (effortResult as GradedEffort);
				}
			}

			applyEnable(pi, ctx, picked, effortChoice);
		},
	});
}
