/**
 * RunTracker — module-level state for the subagent-tree widget.
 *
 * Pure state: no UI, no timer. The widget reads live state via listRuns()
 * on every render; mutations preserve reference identity so the widget's
 * tui.requestRender() path sees fresh data without re-invoking the
 * setWidget factory (pattern mirrors packages/rpiv-todo/todo.ts).
 *
 * Turn-based linger: finished runs persist for COMPLETED_LINGER_TURNS
 * (success) or ERROR_LINGER_TURNS (failures). Ages advance on turn_start,
 * never on wall-clock.
 */

import { COMPLETED_LINGER_TURNS, ERROR_LINGER_TURNS, ERROR_STATUSES } from "./constants.js";
import type { ErrorStatus, RunMode, RunStatus, SingleResult, SubagentDetails, TrackedRun } from "./types.js";

interface SubagentArgs {
	agent?: string;
	task?: string;
	tasks?: Array<{ agent: string; task: string }>;
	chain?: Array<{ agent: string; task: string }>;
}

// Multi-line skill prompts (e.g. peer-comparator with `PeerPairs (orchestrator-computed):` inlined)
// must not ship embedded newlines into the widget's string[] output — pi-tui tracks logical lines
// but the terminal splits on \n into physical rows it can't clear, leaving stale duplicate blocks.
function oneLine(s: string): string {
	return s.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function inferMode(args: SubagentArgs): RunMode {
	if (args.chain && args.chain.length > 0) return "chain";
	if (args.tasks && args.tasks.length > 0) return "parallel";
	return "single";
}

/**
 * True iff args constitute an actual dispatch (one of single/parallel/chain).
 * Filters out meta calls like `subagent list` (no valid mode) that pi's
 * subagent tool answers with the agent list in <1ms — otherwise we'd
 * track them as stray 0.0s entries.
 */
function hasValidMode(args: SubagentArgs): boolean {
	if (args.chain && args.chain.length > 0) return true;
	if (args.tasks && args.tasks.length > 0) return true;
	return Boolean(args.agent && args.task);
}

function deriveDisplay(args: SubagentArgs, mode: RunMode): { displayName: string; description: string } {
	if (mode === "chain") {
		const steps = args.chain ?? [];
		return {
			displayName: `chain (${steps.length} steps)`,
			description: oneLine(steps.map((s) => s.agent).join(" → ")),
		};
	}
	if (mode === "parallel") {
		const tasks = args.tasks ?? [];
		return {
			displayName: `parallel (${tasks.length} tasks)`,
			description: oneLine(tasks[0]?.agent ?? ""),
		};
	}
	return { displayName: oneLine(args.agent ?? "subagent"), description: oneLine(args.task ?? "") };
}

function deriveTerminalStatus(isError: boolean, results: readonly SingleResult[]): RunStatus {
	const last = results[results.length - 1];
	const stopReason = last?.stopReason;
	if (stopReason === "aborted" || stopReason === "steered" || stopReason === "stopped") {
		return stopReason;
	}
	return isError ? "error" : "completed";
}

let runs: Map<string, TrackedRun> = new Map();
let finishedAge: Map<string, number> = new Map();

export function onStart(toolCallId: string, args: unknown): void {
	const typed = (args ?? {}) as SubagentArgs;
	if (!hasValidMode(typed)) return;
	const mode = inferMode(typed);
	const { displayName, description } = deriveDisplay(typed, mode);
	runs.set(toolCallId, {
		toolCallId,
		mode,
		status: "running",
		startedAt: Date.now(),
		displayName,
		description,
		results: [],
	});
	finishedAge.delete(toolCallId);
}

export function onUpdate(toolCallId: string, details: SubagentDetails | undefined): void {
	if (!details) return;
	const run = runs.get(toolCallId);
	if (!run) return;
	run.mode = details.mode;
	run.results = details.results;
	if (details.progress) run.progress = details.progress;
}

export function onEnd(toolCallId: string, result: { details?: SubagentDetails } | undefined, isError: boolean): void {
	const run = runs.get(toolCallId);
	if (!run) return;
	const details = result?.details;
	if (details) {
		run.mode = details.mode;
		run.results = details.results;
		if (details.progress) run.progress = details.progress;
	}
	run.completedAt = Date.now();
	run.status = deriveTerminalStatus(isError, run.results);
	const last = run.results[run.results.length - 1];
	const rawErr = last?.errorMessage || (isError ? last?.stderr : undefined) || undefined;
	run.errorMessage = rawErr ? oneLine(rawErr) : undefined;
	finishedAge.set(toolCallId, 0);
}

/**
 * Advance linger ages on turn boundary. Evicts runs whose age has
 * reached their budget. Returns true iff at least one run was evicted.
 */
export function onTurnStart(): boolean {
	let evicted = false;
	for (const [id, age] of finishedAge) {
		const run = runs.get(id);
		if (!run) {
			finishedAge.delete(id);
			continue;
		}
		const nextAge = age + 1;
		const budget = ERROR_STATUSES.has(run.status as ErrorStatus) ? ERROR_LINGER_TURNS : COMPLETED_LINGER_TURNS;
		if (nextAge >= budget) {
			runs.delete(id);
			finishedAge.delete(id);
			evicted = true;
		} else {
			finishedAge.set(id, nextAge);
		}
	}
	return evicted;
}

/** Snapshot of currently-visible runs. Callers must not retain references. */
export function listRuns(): readonly TrackedRun[] {
	return [...runs.values()];
}

/** Cheap existence check for widget idle-teardown decisions. */
export function hasAnyVisible(): boolean {
	return runs.size > 0;
}

/** Active-spinning run count (excludes lingering finished runs). */
export function runningCount(): number {
	let n = 0;
	for (const r of runs.values()) {
		if (r.status === "running") n++;
	}
	return n;
}

export function __resetState(): void {
	runs = new Map();
	finishedAge = new Map();
}
