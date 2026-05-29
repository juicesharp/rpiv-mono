import { randomUUID } from "node:crypto";

export const COMMAND_NAME = "goal";
export const STATE_ENTRY = "rpiv-goal-state";
export const STATUS_KEY = "rpiv-goal";
export const WIDGET_KEY = "rpiv-goal";
export const TOOL_NAME = "goal_complete";
export const MAX_CONTINUATIONS = 50;

export type GoalStatus = "active" | "paused" | "budget_limited" | "complete";

export interface GoalRecord {
	id: string;
	objective: string;
	status: GoalStatus;
	createdAt: string;
	updatedAt: string;
	iteration: number;
	tokensUsed: number;
	tokenBudget?: number;
	pauseReason?: string;
	completedSummary?: string;
	completionEvidence?: string;
}

export interface GoalStateEntry {
	goal: GoalRecord | null;
}

export type ParsedGoalCommand =
	| { kind: "show" }
	| { kind: "pause" }
	| { kind: "resume" }
	| { kind: "clear" }
	| { kind: "edit"; objective: string; tokenBudget?: number }
	| { kind: "start"; objective: string; tokenBudget?: number };

export function createGoal(objective: string, tokenBudget?: number, now = new Date()): GoalRecord {
	const timestamp = now.toISOString();
	return {
		id: randomUUID(),
		objective: objective.trim(),
		status: "active",
		createdAt: timestamp,
		updatedAt: timestamp,
		iteration: 0,
		tokensUsed: 0,
		...(tokenBudget === undefined ? {} : { tokenBudget }),
	};
}

export function parseGoalCommand(rawArgs: string): ParsedGoalCommand | string {
	const args = rawArgs.trim();
	if (!args) return { kind: "show" };

	const [first, ...restParts] = args.split(/\s+/);
	const rest = restParts.join(" ").trim();
	if (first === "status") return rest ? "Usage: /goal status" : { kind: "show" };
	if (first === "pause") return rest ? "Usage: /goal pause" : { kind: "pause" };
	if (first === "resume") return rest ? "Usage: /goal resume" : { kind: "resume" };
	if (first === "clear") return rest ? "Usage: /goal clear" : { kind: "clear" };
	if (first === "edit") {
		const parsed = parseObjectiveWithBudget(rest);
		if (typeof parsed === "string") return parsed;
		if (!parsed.objective) return "Usage: /goal edit <objective>";
		return { kind: "edit", ...parsed };
	}

	const parsed = parseObjectiveWithBudget(args);
	if (typeof parsed === "string") return parsed;
	if (!parsed.objective) return "Usage: /goal [--tokens 100k] <objective>";
	return { kind: "start", ...parsed };
}

function parseObjectiveWithBudget(input: string): { objective: string; tokenBudget?: number } | string {
	let objective = input.trim();
	let tokenBudget: number | undefined;
	const eqMatch = /^--tokens=(\S+)\s*/.exec(objective);
	const spacedMatch = /^--tokens\s+(\S+)\s*/.exec(objective);
	const match = eqMatch ?? spacedMatch;
	if (match) {
		const parsed = parseTokenBudget(match[1] ?? "");
		if (typeof parsed === "string") return parsed;
		tokenBudget = parsed;
		objective = objective.slice(match[0].length).trim();
	}
	return tokenBudget === undefined ? { objective } : { objective, tokenBudget };
}

export function parseTokenBudget(raw: string): number | string {
	const match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(raw.trim());
	if (!match) return "Token budget must be a number, optionally suffixed with k or m.";
	const base = Number(match[1]);
	const suffix = match[2]?.toLowerCase();
	const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
	const budget = Math.floor(base * multiplier);
	if (!Number.isFinite(budget) || budget <= 0) return "Token budget must be greater than zero.";
	if (budget > 100_000_000) return "Token budget is too large.";
	return budget;
}

export function replayGoalFromEntries(entries: Iterable<unknown>): GoalRecord | undefined {
	let latest: GoalRecord | null | undefined;
	for (const entry of entries) {
		const candidate = entry as { type?: string; customType?: string; data?: unknown };
		if (candidate.type !== "custom" || candidate.customType !== STATE_ENTRY) continue;
		const state = normalizeGoalStateEntry(candidate.data);
		if (!state) continue;
		latest = state.goal;
	}
	return latest && latest.status !== "complete" ? latest : undefined;
}

export function normalizeGoalStateEntry(value: unknown): GoalStateEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const goal = (value as { goal?: unknown }).goal;
	if (goal === null) return { goal: null };
	const normalized = normalizeGoalRecord(goal);
	return normalized ? { goal: normalized } : undefined;
}

export function normalizeGoalRecord(value: unknown): GoalRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Partial<GoalRecord>;
	if (typeof raw.id !== "string" || !raw.id) return undefined;
	if (typeof raw.objective !== "string" || !raw.objective.trim()) return undefined;
	if (!isGoalStatus(raw.status)) return undefined;
	if (typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string") return undefined;
	if (!isFiniteNonNegative(raw.iteration) || !isFiniteNonNegative(raw.tokensUsed)) return undefined;
	const tokenBudget =
		typeof raw.tokenBudget === "number" && raw.tokenBudget > 0 ? Math.floor(raw.tokenBudget) : undefined;
	return {
		id: raw.id,
		objective: raw.objective.trim(),
		status: raw.status,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
		iteration: Math.floor(raw.iteration),
		tokensUsed: Math.floor(raw.tokensUsed),
		...(tokenBudget === undefined ? {} : { tokenBudget }),
		...(typeof raw.pauseReason === "string" ? { pauseReason: raw.pauseReason } : {}),
		...(typeof raw.completedSummary === "string" ? { completedSummary: raw.completedSummary } : {}),
		...(typeof raw.completionEvidence === "string" ? { completionEvidence: raw.completionEvidence } : {}),
	};
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return value === "active" || value === "paused" || value === "budget_limited" || value === "complete";
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function transitionGoal(goal: GoalRecord, status: GoalStatus, patch: Partial<GoalRecord> = {}): GoalRecord {
	return {
		...goal,
		...patch,
		status,
		updatedAt: new Date().toISOString(),
	};
}

export function editGoal(goal: GoalRecord, objective: string, tokenBudget?: number): GoalRecord {
	const next: GoalRecord = {
		...goal,
		objective: objective.trim(),
		status: goal.status === "paused" ? "paused" : "active",
		updatedAt: new Date().toISOString(),
	};
	if (tokenBudget !== undefined) next.tokenBudget = tokenBudget;
	return next;
}

export function incrementGoal(goal: GoalRecord, tokens: number): GoalRecord {
	return {
		...goal,
		iteration: goal.iteration + 1,
		tokensUsed: goal.tokensUsed + Math.max(0, Math.floor(tokens)),
		updatedAt: new Date().toISOString(),
	};
}

export function isBudgetExhausted(goal: GoalRecord): boolean {
	return goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget;
}

export function assistantTurnTokens(message: unknown): number {
	if (!message || typeof message !== "object") return 0;
	const usage = (message as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return 0;
	const raw = usage as Record<string, unknown>;
	const total = numberValue(raw.totalTokens);
	if (total > 0) return total;
	return numberValue(raw.input) + numberValue(raw.output) + numberValue(raw.cacheRead) + numberValue(raw.cacheWrite);
}

export function finalAssistantMessage(messages: readonly unknown[]): unknown | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") {
			return message;
		}
	}
	return undefined;
}

export function assistantStopReason(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const value = (message as { stopReason?: unknown }).stopReason;
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function formatTokenCount(value: number): string {
	if (value < 1_000) return `${value}`;
	if (value < 1_000_000) return `${trimFixed(value / 1_000)}k`;
	return `${trimFixed(value / 1_000_000)}m`;
}

function trimFixed(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

export function formatGoalStatus(goal: GoalRecord): string {
	const budget =
		goal.tokenBudget === undefined
			? ""
			: ` ${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`;
	if (goal.status === "active") return `🎯 active ${goal.iteration}/${MAX_CONTINUATIONS}${budget}`;
	if (goal.status === "paused") return "🎯 paused";
	if (goal.status === "budget_limited") return `🎯 budget${budget}`;
	return "🎯 complete";
}

export function goalSummary(goal: GoalRecord | undefined): string {
	if (!goal) return "No active goal.";
	const lines = [
		`Goal: ${goal.objective}`,
		`Status: ${goal.status}`,
		`Iteration: ${goal.iteration}/${MAX_CONTINUATIONS}`,
		`Tokens: ${
			goal.tokenBudget === undefined
				? formatTokenCount(goal.tokensUsed)
				: `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`
		}`,
		`Commands: ${goalCommandHint(goal.status)}`,
	];
	if (goal.pauseReason) lines.splice(2, 0, `Pause reason: ${goal.pauseReason}`);
	return lines.join("\n");
}

function goalCommandHint(status: GoalStatus): string {
	if (status === "active") return "/goal edit <objective>, /goal pause, /goal clear";
	if (status === "paused" || status === "budget_limited") {
		return "/goal resume, /goal edit <objective>, /goal clear";
	}
	return "/goal clear";
}

export function truncate(value: string, max = 120): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
