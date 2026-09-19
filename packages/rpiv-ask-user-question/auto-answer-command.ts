import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { AutoAnswerState } from "./auto-answer-state.js";
import { saveJevAutoAnswerEnabled } from "./config.js";
import { reconcileAskUserQuestionTool } from "./reconcile.js";

export const AUTO_ANSWER_COMMAND = "ask-user-auto-answer";

const VALUES = ["on", "off", "status"] as const;

function completions(prefix: string): AutocompleteItem[] | null {
	const normalizedPrefix = prefix.toLowerCase();
	const items = VALUES.flatMap((value) => (value.startsWith(normalizedPrefix) ? [{ value, label: value }] : []));
	return items.length > 0 ? items : null;
}

export function registerAutoAnswerCommand(
	pi: ExtensionAPI,
	state: AutoAnswerState,
	saveSetting: (enabled: boolean) => boolean = saveJevAutoAnswerEnabled,
): void {
	pi.registerCommand(AUTO_ANSWER_COMMAND, {
		description: "Enable, disable, or inspect Jev auto-answer for ask_user_question",
		getArgumentCompletions: completions,
		handler: async (rawArgs, ctx) => {
			const action = rawArgs.trim().toLowerCase() || "status";
			if (action === "status") {
				ctx.ui.notify(`Jev auto-answer is ${state.enabled ? "on" : "off"}.`, "info");
				return;
			}
			if (action !== "on" && action !== "off") {
				ctx.ui.notify(`Usage: /${AUTO_ANSWER_COMMAND} on|off|status`, "error");
				return;
			}

			const enabled = action === "on";
			if (!saveSetting(enabled)) {
				ctx.ui.notify("Could not save the Jev auto-answer setting.", "error");
				return;
			}
			state.enabled = enabled;
			reconcileAskUserQuestionTool(pi, ctx, state);
			ctx.ui.notify(`Jev auto-answer is now ${enabled ? "on" : "off"}.`, "info");
		},
	});
}
