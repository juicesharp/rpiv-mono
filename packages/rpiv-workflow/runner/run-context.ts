/**
 * Run construction — the leaf that assembles a `RunContext` (and the pristine
 * `RunState` it starts from) for both entry points. `runWorkflow` builds a
 * fresh identity; `resumeWorkflow` threads the reconstructed one. Lives below
 * the whole engine so resume, the chain walk, and the entries all share one
 * construction site without importing each other.
 */

import type { Workflow } from "../api.js";
import type { WorkflowHost } from "../host.js";
import { LifecycleDispatcher, type LifecycleListeners } from "../lifecycle.js";
import { getSkillContracts } from "../skill-contracts/index.js";
import type { RunTrigger } from "../triggers.js";
import type { RunContext, RunState } from "../types.js";

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/**
 * Per-loop cap on decision-edge retries. A "backward jump" is a *decision*
 * resolving to an already-visited stage — i.e. the user's predicate chose to
 * retry. Deterministic edges through a cycle (the loop body) are NOT
 * counted; the budget is per retry iteration, not per hop. A decision
 * escaping the loop (target not visited) resets the counter so each
 * independent loop in the workflow gets its own fresh budget. With 2: the
 * loop runs once unconditionally and may retry up to 2 more times.
 */
export const MAX_BACKWARD_JUMPS = 2;

/**
 * Run-wide safety cap on loop units — the backstop for any loop kind whose
 * source never terminates (a pull generator that never returns `null`, an
 * assess `done` that never trips). Clamps the effective cap of every loop
 * (`min(loop.max, run.maxIterations)`). Mirrors rpiv-pi's `MAX_PHASES` (the
 * convention cap a fanout author would self-impose); 32 is comfortably above
 * any realistic per-stage unit count while still halting a runaway loop.
 */
export const MAX_ITERATIONS = 32;

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
		termination: { status: "running" },
	};
}

/**
 * Assemble the `RunContext` shared by both entry points. `identity` carries the
 * four fields that differ between a new run (fresh id/state/visited, caller
 * trigger) and a resume (same run id, reconstructed state/visited, resume
 * trigger); everything else derives identically from `options`.
 *
 * The skill-registry snapshot happens here, BEFORE any stage opens a fresh
 * session — Pi invalidates the `WorkflowHost` handle on the first
 * `ctx.newSession()`, so this is the only safe moment to enumerate. After this
 * the runner reads `run.registeredSkills`; `options.host` survives only on
 * `run.continueHost` for the continue-policy session handler.
 */
export function buildRunContext(
	cwd: string,
	workflow: Workflow,
	options: {
		host?: WorkflowHost;
		maxBackwardJumps?: number;
		maxIterations?: number;
		lifecycle?: LifecycleListeners;
		signal?: AbortSignal;
	},
	identity: { runId: string; state: RunState; visited: Set<string>; trigger: RunTrigger },
): RunContext {
	return {
		cwd,
		runId: identity.runId,
		workflow,
		totalStages: countReachableStages(workflow),
		state: identity.state,
		visited: identity.visited,
		registeredSkills: options.host ? snapshotRegisteredSkills(options.host) : undefined,
		// Defensive COPY (not the live global Map) so a later registerSkillContracts
		// call cannot mutate this run's snapshot mid-run — parity with the fresh-Set
		// copy snapshotRegisteredSkills makes.
		skillContracts: new Map(getSkillContracts()),
		continueHost: options.host,
		maxBackwardJumps: options.maxBackwardJumps ?? MAX_BACKWARD_JUMPS,
		maxIterations: options.maxIterations ?? MAX_ITERATIONS,
		trigger: identity.trigger,
		lifecycle: new LifecycleDispatcher(options.lifecycle),
		signal: options.signal,
	};
}

/**
 * Build the `registeredSkills` snapshot consumed by `ensureSkillRegistered`.
 *
 * Pi prefixes skill-source commands with `"skill:"` (agent-session.js); we
 * strip the prefix so the set keys match `stage.skill` directly. Called
 * exactly once per run, before any `ctx.newSession()` opens (which is when
 * Pi marks the `WorkflowHost` handle stale).
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
