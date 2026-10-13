/**
 * Run construction — the leaf that assembles a `RunContext` (and the pristine
 * `RunState` it starts from) for both entry points. `runWorkflow` builds a
 * fresh identity; `resumeWorkflow` threads the reconstructed one. Lives below
 * the whole engine so resume, the chain walk, and the entries all share one
 * construction site without importing each other.
 */

import type { Workflow } from "../api.js";
import { LifecycleDispatcher, type LifecycleListeners } from "../events.js";
import type { ModelSelection, WorkflowHost } from "../host.js";
import { MSG_BUDGET_INVALID } from "../messages.js";
import { getSkillContracts } from "../skill-contracts/index.js";
import type { BranchEntry } from "../transcript.js";
import type { RunTrigger } from "../triggers.js";
import type { RunContext, RunState } from "../types.js";

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/**
 * Per-DESTINATION cap on decision-edge retries. A "backward jump" is a
 * *decision* resolving to an already-visited stage — i.e. the user's
 * predicate chose to retry. Deterministic edges through a cycle (the loop
 * body) are NOT counted, and each destination stage owns its own budget
 * (`RunContext.revisits`), so the retry allowance is invariant to how many
 * decision edges the cycle crosses per iteration and unrelated loops never
 * share a pool. With 3: any given stage runs once unconditionally and may be
 * re-entered up to 3 more times — at most 4 executions per stage.
 */
export const MAX_BACKWARD_JUMPS = 3;

/**
 * Per-DESTINATION absolute ceiling on decision-edge re-entries — the
 * verdict-proof backstop ABOVE the waive-aware `MAX_BACKWARD_JUMPS` cap.
 * Every re-entry counts toward it, whatever the stage `progress` hook
 * votes: a destination whose laps keep reporting "improved" waives the
 * cap but never this ceiling, so the `maxLaps + 1`-th re-entry of one
 * stage always halts. Fresh per invocation like the cap — a resume
 * re-opens a closed loop with both budgets restored.
 */
export const MAX_LAPS = 8;

/**
 * Run-wide safety cap on loop units — the backstop for any loop kind whose
 * source never terminates (a pull generator that never returns `null`, an
 * assess `done` that never trips). Clamps the effective cap of every loop
 * (`min(loop.max, run.maxIterations)`). Mirrors rpiv-pi's `MAX_PHASES` (the
 * convention cap a fanout author would self-impose); 32 is comfortably above
 * any realistic per-stage unit count while still halting a runaway loop.
 */
export const MAX_ITERATIONS = 32;

/**
 * The run budgets an embedder may override — the single key list behind
 * `RunBudgetOptions`, the validator, and `buildRunContext`'s options type, so
 * a fourth budget is a one-row addition here plus its default below.
 */
const BUDGET_KEYS = ["maxBackwardJumps", "maxLaps", "maxIterations"] as const;

/** The run budgets an embedder may override — each a non-negative integer or absent. */
export type RunBudgetOptions = { [K in (typeof BUDGET_KEYS)[number]]?: number };

/**
 * Validate the budget options an embedder may thread in. `??` passes `NaN`
 * straight through to the ledgers, where `laps > NaN` is always false — the
 * ceiling documented as "always halts" would fail OPEN (an always-"improved"
 * hook never spends the cap either, so nothing terminates the loop) while
 * `revisits <= NaN` fails CLOSED on the first counted re-entry. Non-integers
 * and negatives are refused for the same reason: the compares are integer
 * arithmetic. The CLI regexes gate `\d+`, so only the programmatic options
 * path can reach this. Returns the first offending option's message, or
 * `undefined` when every supplied budget is well-formed; `runWorkflow` and
 * `resumeWorkflow` refuse pre-flight on it (before any row is written) and
 * `buildRunContext` throws on it as the backstop.
 */
export function validateRunBudgets(options: RunBudgetOptions): string | undefined {
	for (const key of BUDGET_KEYS) {
		const value = options[key];
		if (value === undefined) continue;
		if (!Number.isInteger(value) || value < 0) return MSG_BUDGET_INVALID(key, value);
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// State + context construction
// ---------------------------------------------------------------------------

/**
 * A pristine `RunState`. New runs start here (`runWorkflow`); the resume fold
 * starts here too and replays the trail on top — ONE construction site, so a
 * new `RunState` field can never silently diverge between live runs and
 * resumes.
 */
export function freshRunState(originalInput: string): RunState {
	return {
		originalInput,
		primaryArtifact: undefined,
		output: undefined,
		named: {},
		stagesCompleted: 0,
		lastAllocatedStageNumber: 0,
		telemetry: { backwardJumps: 0, droppedRoutingRows: [], droppedFailureRows: [] },
		failureMemos: [],
		// Validation-retry gate memory — fresh on every entry point (operator
		// resume starts with NO prior baseline ⇒ first qualifying dispatch
		// proceeds, mirroring the fresh-strike-budget policy).
		lastGatedDispatch: undefined,
		termination: { status: "running" },
	};
}

/**
 * Assemble the `RunContext` shared by both entry points. `identity` carries the
 * four fields that differ between a new run (fresh id/state/visited, caller
 * trigger) and a resume (same run id, reconstructed state/visited, resume
 * trigger); everything else derives identically from `options`.
 *
 * The skill-registry snapshot happens here, BEFORE any stage opens its first
 * child session — `options.host` (Pi's registry-level handle) is enumerated once
 * for `run.registeredSkills`; the runner reads that set thereafter and never
 * touches the host again (every stage now runs in a detached child, so there is
 * no stale-after-swap concern and no continue-policy host fallback).
 */
export function buildRunContext(
	cwd: string,
	workflow: Workflow,
	options: RunBudgetOptions & {
		host?: WorkflowHost;
		lifecycle?: LifecycleListeners;
		signal?: AbortSignal;
		resolveModel?: (id: { workflow: string; stage: string; skill: string }) => ModelSelection | undefined;
		readSessionBranch?: (file: string) => BranchEntry[] | undefined;
		worktreeDigest?: (cwd: string) => string | undefined;
	},
	identity: { runId: string; state: RunState; visited: Set<string>; trigger: RunTrigger },
): RunContext {
	// Backstop for any constructor path that skipped the pre-flight check —
	// a malformed budget must never reach the ledgers.
	const budgetError = validateRunBudgets(options);
	if (budgetError !== undefined) throw new Error(budgetError);
	return {
		cwd,
		runId: identity.runId,
		workflow,
		totalStages: countReachableStages(workflow),
		state: identity.state,
		visited: identity.visited,
		// Fresh on every entry point: a resume grants each stage a fresh
		// re-entry budget, exactly as the pre-ledger streak counter did.
		revisits: new Map(),
		// Fresh beside `revisits`: the progress-verdict ring is engine memory
		// (never persisted), so both entry points — run and resume — start it
		// empty.
		progressTrail: new Map(),
		// Absolute lap ledger — the ceiling's counter, same fresh-per-
		// invocation rule as `revisits` (a resume re-opens the loop).
		laps: new Map(),
		registeredSkills: options.host ? snapshotRegisteredSkills(options.host) : undefined,
		// Defensive COPY (not the live global Map) so a later registerSkillContracts
		// call cannot mutate this run's snapshot mid-run — parity with the fresh-Set
		// copy snapshotRegisteredSkills makes.
		skillContracts: new Map(getSkillContracts()),
		maxBackwardJumps: options.maxBackwardJumps ?? MAX_BACKWARD_JUMPS,
		maxLaps: options.maxLaps ?? MAX_LAPS,
		maxIterations: options.maxIterations ?? MAX_ITERATIONS,
		trigger: identity.trigger,
		lifecycle: new LifecycleDispatcher(options.lifecycle),
		signal: options.signal,
		resolveModel: options.resolveModel,
		readSessionBranch: options.readSessionBranch,
		worktreeDigest: options.worktreeDigest,
	};
}

/**
 * Build the `registeredSkills` snapshot consumed by `ensureSkillRegistered`.
 *
 * Pi prefixes skill-source commands with `"skill:"` (agent-session.js); we
 * strip the prefix so the set keys match `stage.skill` directly. Called
 * exactly once per run, at run start, off the launcher's registry-level host.
 *
 * Non-skill commands (slash commands registered by extensions) are filtered
 * out — the preflight only cares about skills.
 */
export function snapshotRegisteredSkills(host: WorkflowHost): ReadonlySet<string> {
	const skills = new Set<string>();
	for (const cmd of host.getCommands()) {
		if (cmd.source !== "skill") continue;
		const name = cmd.name.startsWith("skill:") ? cmd.name.slice("skill:".length) : cmd.name;
		skills.add(name);
	}
	return skills;
}

/**
 * Upper bound for the status-line denominator — BFS reach from `workflow.start`.
 *
 * Relies on every `EdgeFn` carrying `.targets`. `validate-workflow.ts` enforces
 * this at load time, so by the time the runner sees a workflow the contract
 * holds. A `.targets`-less EdgeFn here means validation was bypassed (test
 * fixture or programmatic embedder) — surface loudly instead of silently
 * counting all declared stages.
 */
function countReachableStages(workflow: Workflow): number {
	const seen = new Set<string>();
	const frontier: string[] = [workflow.start];
	while (frontier.length > 0) {
		const cur = frontier.shift()!;
		if (seen.has(cur)) continue;
		seen.add(cur);
		const edge = workflow.edges[cur];
		if (edge === undefined || edge === "stop") continue;
		if (typeof edge === "string") {
			if (workflow.stages[edge] && !seen.has(edge)) frontier.push(edge);
		} else if (Array.isArray(edge.targets)) {
			for (const t of edge.targets) {
				if (t !== "stop" && workflow.stages[t] && !seen.has(t)) frontier.push(t);
			}
		} else {
			throw new Error(
				`countReachableStages: edge from "${cur}" is an EdgeFn without .targets — validateWorkflow should have rejected this workflow`,
			);
		}
	}
	return seen.size;
}
