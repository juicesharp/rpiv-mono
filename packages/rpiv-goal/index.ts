import {
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildGoalContinuePrompt,
	buildGoalPrompt,
	buildGoalResumePrompt,
	buildGoalSystemPrompt,
	buildGoalUpdatedPrompt,
	extractContinuationMarker,
} from "./prompt.js";
import {
	assistantStopReason,
	assistantTurnTokens,
	COMMAND_NAME,
	createGoal,
	editGoal,
	finalAssistantMessage,
	formatGoalStatus,
	type GoalRecord,
	type GoalStateEntry,
	goalSummary,
	incrementGoal,
	isBudgetExhausted,
	MAX_CONTINUATIONS,
	parseGoalCommand,
	replayGoalFromEntries,
	STATE_ENTRY,
	STATUS_KEY,
	TOOL_NAME,
	transitionGoal,
	truncate,
	WIDGET_KEY,
} from "./state.js";

interface PendingContinuation {
	goalId: string;
	marker: string;
}

interface GoalCompleteDetails {
	goal: GoalRecord | undefined;
	summary: string;
	evidence?: string;
}

let activeGoal: GoalRecord | undefined;
let pendingContinuation: PendingContinuation | undefined;
let cancelledContinuationMarkers = new Set<string>();
let workToolCalledThisRun = false;

export function __resetGoalRuntime(): void {
	activeGoal = undefined;
	pendingContinuation = undefined;
	cancelledContinuationMarkers = new Set<string>();
	workToolCalledThisRun = false;
}

const goalCompleteTool = defineTool({
	name: TOOL_NAME,
	label: "Goal Complete",
	description: "Mark the active /goal complete. Only call this after the objective is fully done and verified.",
	promptSnippet: "Mark the active /goal complete after fully finishing and verifying it",
	promptGuidelines: [
		"Use goal_complete only when every explicit goal requirement is satisfied.",
		"Before calling goal_complete, compare the goal against concrete evidence from files, commands, tests, or external state.",
		"Do not use goal_complete for partial progress, plans, TODO lists, or blockers.",
	],
	parameters: Type.Object({
		summary: Type.String({ description: "Concise completion summary." }),
		evidence: Type.Optional(Type.String({ description: "Concrete evidence that proves the goal is complete." })),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const completed = activeGoal
			? transitionGoal(activeGoal, "complete", {
					completedSummary: params.summary.trim(),
					...(params.evidence?.trim() ? { completionEvidence: params.evidence.trim() } : {}),
				})
			: undefined;
		if (completed) persistGoal(completed);
		activeGoal = undefined;
		clearContinuationState();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, "🎯 complete");
		ctx.ui.notify(`Goal complete: ${completed ? truncate(completed.objective, 120) : "no active goal"}`, "info");
		return {
			content: [
				{
					type: "text",
					text: completed ? `Goal complete: ${params.summary.trim()}` : "No active goal.",
				},
			],
			details: {
				goal: completed,
				summary: params.summary.trim(),
				...(params.evidence?.trim() ? { evidence: params.evidence.trim() } : {}),
			} satisfies GoalCompleteDetails,
			terminate: true,
		};
	},
});

export default function goalExtension(pi: ExtensionAPI): void {
	activePi = pi;
	pi.registerTool(goalCompleteTool);

	pi.registerCommand(COMMAND_NAME, {
		description: "Run a session-scoped goal to completion: /goal [--tokens 100k] <objective>",
		handler: async (args, ctx) => {
			const parsed = parseGoalCommand(args);
			if (typeof parsed === "string") {
				ctx.ui.notify(parsed, "warning");
				return;
			}
			switch (parsed.kind) {
				case "show":
					showGoal(ctx);
					return;
				case "pause":
					pauseGoal(ctx, "user");
					return;
				case "resume":
					await resumeGoal(pi, ctx);
					return;
				case "clear":
					clearGoal(ctx);
					return;
				case "edit":
					await updateGoalObjective(pi, ctx, parsed.objective, parsed.tokenBudget);
					return;
				case "start":
					await startGoal(pi, ctx, parsed.objective, parsed.tokenBudget);
					return;
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		loadGoal(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		loadGoal(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		loadGoal(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		clearContinuationState();
	});

	pi.on("input", (event) => {
		const marker = extractContinuationMarker(event.text);
		if (marker && cancelledContinuationMarkers.delete(marker)) {
			return { action: "handled" as const };
		}
	});

	pi.on("before_agent_start", (event) => {
		const marker = extractContinuationMarker(event.prompt);
		if (marker && pendingContinuation?.marker === marker) pendingContinuation = undefined;
		if (activeGoal?.status !== "active") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(activeGoal)}` };
	});

	pi.on("agent_start", () => {
		workToolCalledThisRun = false;
	});

	pi.on("tool_execution_end", (event) => {
		if (activeGoal?.status !== "active") return;
		if (event.isError || event.toolName === TOOL_NAME) return;
		workToolCalledThisRun = true;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (activeGoal?.status !== "active") return;
		const finalAssistant = finalAssistantMessage(event.messages as unknown[]);
		const stopReason = assistantStopReason(finalAssistant);
		if (stopReason === "aborted" || stopReason === "error") {
			pauseGoal(ctx, stopReason);
			return;
		}

		activeGoal = incrementGoal(activeGoal, assistantTurnTokens(finalAssistant));
		if (isBudgetExhausted(activeGoal)) {
			activeGoal = transitionGoal(activeGoal, "budget_limited");
			persistGoal(activeGoal);
			updateUI(ctx);
			ctx.ui.notify(`Goal token budget reached: ${formatGoalStatus(activeGoal)}`, "warning");
			return;
		}
		if (activeGoal.iteration >= MAX_CONTINUATIONS) {
			pauseGoal(ctx, "continuation_limit");
			return;
		}
		if (!workToolCalledThisRun) {
			pauseGoal(ctx, "empty_turn");
			return;
		}

		persistGoal(activeGoal);
		updateUI(ctx);
		if (hasPendingMessages(ctx)) return;
		await sendContinuationPrompt(pi, ctx, activeGoal);
	});
}

async function startGoal(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	objective: string,
	tokenBudget: number | undefined,
): Promise<void> {
	const existing = activeGoal && activeGoal.status !== "complete" ? activeGoal : undefined;
	if (existing) {
		const replace = await ctx.ui.confirm(
			"Replace active goal?",
			`Current goal: ${existing.objective}\n\nNew goal: ${objective}`,
		);
		if (!replace) {
			ctx.ui.notify("Goal unchanged.", "info");
			return;
		}
	}
	activeGoal = createGoal(objective, tokenBudget);
	clearContinuationState();
	persistGoal(activeGoal);
	updateUI(ctx);
	ctx.ui.notify(`Goal started: ${truncate(activeGoal.objective, 120)}`, "info");
	await sendPrompt(pi, ctx, buildGoalPrompt(activeGoal));
}

async function updateGoalObjective(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	objective: string,
	tokenBudget: number | undefined,
): Promise<void> {
	if (!activeGoal) {
		ctx.ui.notify("No active goal to edit. Use /goal <objective> first.", "warning");
		return;
	}
	activeGoal = editGoal(activeGoal, objective, tokenBudget);
	clearContinuationState();
	persistGoal(activeGoal);
	updateUI(ctx);
	ctx.ui.notify(`Goal updated: ${truncate(activeGoal.objective, 120)}`, "info");
	if (activeGoal.status === "active") await sendPrompt(pi, ctx, buildGoalUpdatedPrompt(activeGoal));
}

function pauseGoal(ctx: ExtensionContext, reason: string): void {
	if (!activeGoal) {
		ctx.ui.notify("No active goal.", "warning");
		return;
	}
	if (activeGoal.status !== "active") {
		ctx.ui.notify(`Goal is ${activeGoal.status}.`, "info");
		return;
	}
	activeGoal = transitionGoal(activeGoal, "paused", { pauseReason: reason });
	cancelPendingContinuation();
	persistGoal(activeGoal);
	updateUI(ctx);
	ctx.ui.notify(`Goal paused: ${reason}`, reason === "user" ? "info" : "warning");
}

async function resumeGoal(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!activeGoal) {
		ctx.ui.notify("No paused goal.", "warning");
		return;
	}
	if (activeGoal.status !== "paused" && activeGoal.status !== "budget_limited") {
		ctx.ui.notify(`Goal is ${activeGoal.status}; only paused or budget-limited goals can resume.`, "warning");
		return;
	}
	activeGoal = transitionGoal(activeGoal, "active", { pauseReason: undefined });
	persistGoal(activeGoal);
	updateUI(ctx);
	ctx.ui.notify(`Goal resumed: ${truncate(activeGoal.objective, 120)}`, "info");
	await sendPrompt(pi, ctx, buildGoalResumePrompt(activeGoal));
}

function clearGoal(ctx: ExtensionContext): void {
	if (!activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		return;
	}
	const objective = activeGoal.objective;
	activeGoal = undefined;
	cancelPendingContinuation();
	persistGoal(null);
	updateUI(ctx);
	ctx.ui.notify(`Goal cleared: ${truncate(objective, 120)}`, "info");
}

function showGoal(ctx: ExtensionContext): void {
	ctx.ui.notify(goalSummary(activeGoal), activeGoal ? "info" : "warning");
	updateUI(ctx);
}

function loadGoal(ctx: ExtensionContext): void {
	activeGoal = replayGoalFromEntries(ctx.sessionManager.getBranch());
	clearContinuationState();
	workToolCalledThisRun = false;
	updateUI(ctx);
}

function persistGoal(goal: GoalRecord | null): void {
	const state: GoalStateEntry = { goal };
	activePi?.appendEntry(STATE_ENTRY, state);
}

let activePi: ExtensionAPI | undefined;

function updateUI(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (!activeGoal) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, formatGoalStatus(activeGoal));
	ctx.ui.setWidget(
		WIDGET_KEY,
		[
			formatGoalStatus(activeGoal),
			`├─ ${truncate(activeGoal.objective, 100)}`,
			`└─ /goal status · /goal pause · /goal clear`,
		],
		{ placement: "aboveEditor" },
	);
}

async function sendContinuationPrompt(pi: ExtensionAPI, ctx: ExtensionContext, goal: GoalRecord): Promise<boolean> {
	if (pendingContinuation?.goalId === goal.id) return false;
	if (hasPendingMessages(ctx)) return false;
	const marker = `${goal.id}:${goal.iteration}`;
	pendingContinuation = { goalId: goal.id, marker };
	const sent = await sendPrompt(pi, ctx, buildGoalContinuePrompt(goal, marker));
	if (!sent && pendingContinuation?.marker === marker) pendingContinuation = undefined;
	return sent;
}

async function sendPrompt(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): Promise<boolean> {
	try {
		if (isIdle(ctx)) pi.sendUserMessage(prompt);
		else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		return true;
	} catch (error) {
		ctx.ui.notify(`Goal prompt failed: ${formatError(error)}`, "error");
		return false;
	}
}

function cancelPendingContinuation(): void {
	if (pendingContinuation) cancelledContinuationMarkers.add(pendingContinuation.marker);
	pendingContinuation = undefined;
}

function clearContinuationState(): void {
	pendingContinuation = undefined;
	cancelledContinuationMarkers.clear();
}

function hasPendingMessages(ctx: ExtensionContext): boolean {
	try {
		return ctx.hasPendingMessages?.() ?? false;
	} catch {
		return true;
	}
}

function isIdle(ctx: ExtensionContext): boolean {
	try {
		return ctx.isIdle?.() ?? false;
	} catch {
		return false;
	}
}

function formatError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return truncate(message, 160);
}
