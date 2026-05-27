/**
 * Fanout iteration. When a stage opts in via `StageDef.fanout`, the runner
 * calls the user's `FanoutFn` to get a list of units and iterates one Pi
 * session per unit. This module owns the iteration loop; `runner.ts`
 * injects its primitives via `FanoutDeps` so the module never imports
 * back (cycle-free).
 *
 * No markdown regex, no per-convention counter, no cap — rpiv-workflow
 * stays convention-agnostic. Consumers (rpiv-pi etc.) own the FanoutFn
 * body and any safety bounds it needs.
 */

import type { FanoutUnit } from "./api.js";
import { buildLifecycleContext, skillStageRef } from "./lifecycle.js";
import { MSG_STAGE_COMPLETE, STATUS_FANOUT_UNIT, STATUS_KEY } from "./messages.js";
import type { FanoutSession, RunContext, RunnerCtx } from "./types.js";

export interface FanoutDeps {
	runFanoutSession: (ctx: RunnerCtx, session: FanoutSession) => Promise<void>;
	/**
	 * Resume the chain after the fanout node's units finish. Receives the
	 * fanout node's name so the routing layer can look up the outgoing
	 * edge from it.
	 */
	advanceAfter: (curCtx: RunnerCtx, completedName: string, completedIdx: number, run: RunContext) => Promise<void>;
}

/**
 * `skill` is the bundled skill body (threaded by the runner), not the node
 * name. Aliased nodes (e.g. `implement-after-revise` invoking `implement`)
 * tag unit rows + prompts with the skill body so audit consumers don't see
 * two labels for the same work. Caller verifies node + fanout shape before
 * invoking (see `runStage`).
 *
 * `currentName` is the fanout node's name in the workflow — passed to
 * `advanceAfter` once the final unit completes so the routing layer can
 * look up the outgoing edge from it.
 *
 * `units` was already produced by the user's `FanoutFn`; the iteration loop
 * walks it in order. `p` is the 1-based index into `units` for the next
 * session to run — the continuation-style self-call increments it.
 */
export async function runFanout(
	curCtx: RunnerCtx,
	stageIdx: number,
	currentName: string,
	skill: string,
	p: number,
	units: readonly FanoutUnit[],
	run: RunContext,
	deps: FanoutDeps,
): Promise<void> {
	const { cwd, runId, totalStages, state } = run;

	if (p > units.length) {
		curCtx.ui.notify(MSG_STAGE_COMPLETE(skill), "info");
		await deps.advanceAfter(curCtx, currentName, stageIdx, run);
		return;
	}

	const unit = units[p - 1]!;
	curCtx.ui.setStatus(STATUS_KEY, STATUS_FANOUT_UNIT(stageIdx + 1, totalStages, skill, unit.label));

	const lifecycleCtx = buildLifecycleContext({
		cwd,
		runId,
		workflow: run.workflow.name,
		totalStages: run.totalStages,
		trigger: run.trigger,
		state,
	});
	await run.lifecycle.fire(
		curCtx,
		"onFanoutUnitStart",
		skillStageRef(currentName, stageIdx + 1, skill),
		unit,
		p,
		lifecycleCtx,
	);

	await deps.runFanoutSession(curCtx, {
		cwd,
		runId,
		state,
		prompt: `/skill:${skill} ${unit.prompt}`,
		stageName: currentName,
		skill,
		lifecycle: run.lifecycle,
		runIdentity: { workflow: run.workflow.name, totalStages: run.totalStages, trigger: run.trigger },
		unitIndex: p,
		label: unit.label,
		id: unit.id,
		stageIndex: stageIdx,
		onSuccess: (freshCtx) => runFanout(freshCtx, stageIdx, currentName, skill, p + 1, units, run, deps),
	});
}
