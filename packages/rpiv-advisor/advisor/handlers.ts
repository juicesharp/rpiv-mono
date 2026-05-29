/**
 * handlers — mid-session lifecycle handlers. A shared reconcileAdvisorTool
 * strips or re-adds the advisor tool to match the blocked state (with an
 * optional notify), and the three register*Handler functions wire it to
 * before_agent_start, model_select, and thinking_level_select.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey } from "./config.js";
import { ADVISOR_TOOL_NAME, MSG_ADVISOR_DISABLED, msgAdvisorRestored } from "./messages.js";
import { isExecutorBlocked, isModelBlocked } from "./policy.js";
import { getAdvisorEffort, getAdvisorModel } from "./state.js";

interface ReconcileNotify {
	/** Shown when the tool is stripped (executor became blocked). */
	disabled: string;
	/** Shown when the tool is re-added (executor became unblocked). */
	restored: string;
}

// Strip-or-add the advisor tool to match the blocked state, with an optional
// notify on each transition. Reads the active-tool list itself. Shared by the
// three lifecycle handlers and the /advisor command's activate step.
export function reconcileAdvisorTool(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: { blocked: boolean; notify?: ReconcileNotify },
): void {
	const active = pi.getActiveTools();
	const hasTool = active.includes(ADVISOR_TOOL_NAME);
	if (opts.blocked && hasTool) {
		pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
		if (opts.notify && ctx.hasUI) ctx.ui.notify(opts.notify.disabled, "info");
	} else if (!opts.blocked && !hasTool) {
		pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
		if (opts.notify && ctx.hasUI) ctx.ui.notify(opts.notify.restored, "info");
	}
}

export function registerAdvisorBeforeAgentStart(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		const advisor = getAdvisorModel();
		if (!advisor) {
			const active = pi.getActiveTools();
			if (active.includes(ADVISOR_TOOL_NAME)) {
				pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
			}
			return;
		}
		reconcileAdvisorTool(pi, ctx, { blocked: isExecutorBlocked(ctx, pi.getThinkingLevel()) });
	});
}

export function registerModelSelectHandler(pi: ExtensionAPI): void {
	pi.on("model_select", async (event, ctx) => {
		// session_start restore path is owned by restoreAdvisorState — it already
		// activates the tool and notifies. Skipping "restore" here prevents a
		// duplicate notification on initial model load.
		if (event.source === "restore") return;

		const advisor = getAdvisorModel();
		if (!advisor) return;

		reconcileAdvisorTool(pi, ctx, {
			blocked: isModelBlocked(event.model, pi.getThinkingLevel()),
			notify: {
				disabled: `Advisor disabled for ${modelKey(event.model)}`,
				restored: msgAdvisorRestored(modelKey(advisor), getAdvisorEffort()),
			},
		});
	});
}

export function registerThinkingLevelSelectHandler(pi: ExtensionAPI): void {
	pi.on("thinking_level_select", async (event, ctx) => {
		const advisor = getAdvisorModel();
		if (!advisor) return;

		// `blocked === true` implies a defined model (isModelBlocked returns false
		// for undefined), so the MSG_ADVISOR_DISABLED fallback is unreachable — it
		// only keeps the disabled string total without a non-null assertion on the model.
		const model = ctx?.model;
		reconcileAdvisorTool(pi, ctx, {
			blocked: isModelBlocked(model, event.level),
			notify: {
				disabled: model ? `Advisor disabled for ${modelKey(model)}` : MSG_ADVISOR_DISABLED,
				restored: msgAdvisorRestored(modelKey(advisor), getAdvisorEffort()),
			},
		});
	});
}
