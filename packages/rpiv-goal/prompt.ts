import type { GoalRecord } from "./state.js";
import { formatTokenCount } from "./state.js";

export const CONTINUATION_MARKER_PREFIX = "rpiv-goal-continuation:";

export function buildGoalPrompt(goal: GoalRecord): string {
	return `Goal mode is active. Complete this goal fully:\n\n${goalBlock(goal)}${budgetLine(
		goal,
	)}\n\n${persistenceRules("this goal")}`;
}

export function buildGoalUpdatedPrompt(goal: GoalRecord): string {
	return `The active /goal objective changed. Continue toward the updated goal:\n\n${goalBlock(
		goal,
	)}${budgetLine(goal)}\n\n${persistenceRules("the updated goal")}`;
}

export function buildGoalResumePrompt(goal: GoalRecord): string {
	return `The user resumed the paused /goal. Continue toward this goal:\n\n${goalBlock(goal)}${budgetLine(
		goal,
	)}\n\n${persistenceRules("this goal")}`;
}

export function buildGoalSystemPrompt(goal: GoalRecord): string {
	return `Active /goal:\n${goalBlock(
		goal,
	)}\n\nGoal-mode rules:\n- Keep working until the active goal is resolved end-to-end.\n- Do not redefine the goal into a smaller task.\n- Treat the worktree, command output, tests, and external state as authoritative.\n- Do not stop with only analysis, a plan, TODOs, or partial progress.\n- Use normal work tools when they are needed to complete the goal.\n- If blocked, say what blocks the goal and wait for the user instead of pretending it is complete.\n- Call goal_complete only after every explicit requirement is satisfied and verified.${
		goal.tokenBudget === undefined
			? ""
			: `\n- Respect the token budget (${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(
					goal.tokenBudget,
				)} used).`
	}`;
}

export function buildGoalContinuePrompt(goal: GoalRecord, marker: string): string {
	return `Continue the active /goal until it is complete:\n\n${goalBlock(
		goal,
	)}\n\nAutomatic continuation #${goal.iteration}. Re-check current files and command output as needed. ${persistenceRules(
		"this goal",
	)}\n\n${continuationMarkerComment(marker)}`;
}

export function continuationMarkerComment(marker: string): string {
	return `<!-- ${CONTINUATION_MARKER_PREFIX}${marker} -->`;
}

export function extractContinuationMarker(text: string): string | undefined {
	return continuationPattern().exec(text)?.[1];
}

function continuationPattern(): RegExp {
	return new RegExp(`<!--\\s*${escapeRegExp(CONTINUATION_MARKER_PREFIX)}([^\\s>]+)\\s*-->`);
}

function goalBlock(goal: GoalRecord): string {
	return `<goal_objective>\n${escapeXml(goal.objective)}\n</goal_objective>`;
}

function budgetLine(goal: GoalRecord): string {
	return goal.tokenBudget === undefined
		? ""
		: `\nToken budget: ${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}.`;
}

function persistenceRules(goalLabel: string): string {
	return `Keep going until ${goalLabel} is completely resolved. Before calling goal_complete, audit the goal requirement by requirement against concrete evidence and include the evidence in the tool call.`;
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
