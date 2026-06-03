/**
 * Iterate iteration — the sequential, accumulating dual of `fanout.ts`. When a
 * stage opts in via `StageDef.iterate`, the runner pulls units one at a time
 * (calling the user's `IterateFn` per unit, feeding it the prior units'
 * validated `Output`s) and runs one Pi session per unit. Unlike fanout, each
 * unit runs the stage's `outcome` collector — it reuses `runStageSession`
 * verbatim, so every unit gets the same collector → validate → record →
 * accumulate path as a one-shot `produces` stage.
 *
 * `runner.ts` (via `stage-lifecycle.ts`) injects the runner primitives through
 * `IterateDeps` so this module never imports back (cycle-free), mirroring how
 * `runFanout` receives `FanoutDeps`.
 *
 * Two run-wide bounds are the only safety nets: the generator's own `null`
 * terminator, and `run.maxIterations` (the backstop for a generator that never
 * returns null). No markdown regex, no per-convention counter — rpiv-workflow
 * stays convention-agnostic; the `IterateFn` body owns the convention.
 */

import type { StageDef } from "./api.js";
import { iterateRowStage } from "./audit.js";
import type { Artifact } from "./handle.js";
import { MSG_ITERATE_ZERO_UNITS, MSG_STAGE_COMPLETE, STATUS_ITERATE_UNIT, STATUS_KEY } from "./messages.js";
import type { Output } from "./output.js";
import type { RunContext, StageSession, WorkflowHostContext } from "./types.js";

export interface IterateDeps {
	/**
	 * Dispatch one unit through the standard stage-session path (collector →
	 * validate → record → accumulate). The same `runStageSession` a normal
	 * `produces` stage uses — iterate adds no bespoke session machinery.
	 */
	runStageSession: (ctx: WorkflowHostContext, s: StageSession) => Promise<void>;
	/**
	 * Resume the chain after the iterate node's units finish (generator
	 * returned null). Receives the iterate node's REAL name so routing looks up
	 * the outgoing edge from it — the per-unit audit decoration never leaks
	 * into routing.
	 */
	advanceAfter: (
		curCtx: WorkflowHostContext,
		completedName: string,
		completedIdx: number,
		run: RunContext,
	) => Promise<void>;
	/** Re-capture the outcome's pre-stage snapshot per unit (each unit is its own produces pass). */
	captureSnapshot: (def: StageDef, idx: number, run: RunContext) => Promise<unknown>;
	/** Record the terminal failure when the `maxIterations` backstop trips. */
	haltIterations: (curCtx: WorkflowHostContext, run: RunContext, stageName: string, count: number) => Promise<void>;
}

/**
 * `skill` is the bundled skill body (threaded by the runner), not the node
 * name — aliased nodes tag unit rows + prompts with the skill body so audit
 * consumers don't see two labels for the same work.
 *
 * `currentName` is the iterate node's REAL name in the workflow — passed to
 * `advanceAfter` once the generator terminates, and used (undecorated) for
 * `state.named` keying via `resolvePublishName`.
 *
 * `entryArtifact` is the stage-entry primary, FROZEN across every unit (the
 * rolling primary advances to each unit's output, but the generator keeps
 * seeing its true source — see `IterateContext.artifact`).
 *
 * `accumulated` carries this stage's prior validated `Output`s in order. The
 * continuation-style self-call appends the unit just produced (read from
 * `run.state.output`, which `tryRecordStage` sets immediately before
 * `onSuccess`).
 */
export async function runIterate(
	curCtx: WorkflowHostContext,
	stageIdx: number,
	currentName: string,
	skill: string,
	def: StageDef,
	entryArtifact: Artifact | undefined,
	accumulated: readonly Output[],
	run: RunContext,
	deps: IterateDeps,
): Promise<void> {
	const unit = await def.iterate!({
		cwd: run.cwd,
		artifact: entryArtifact,
		state: run.state,
		accumulated,
		index: accumulated.length,
	});

	// Generator terminated — complete the stage and resume the chain from the
	// real node name. A first-call null is the zero-unit no-op: nothing is
	// published, the primary stays at the entry artifact — warn (not error) so
	// the author notices the empty input. A null after ≥1 unit is a normal
	// completion.
	if (!unit) {
		if (accumulated.length === 0) curCtx.ui.notify(MSG_ITERATE_ZERO_UNITS(skill), "warning");
		else curCtx.ui.notify(MSG_STAGE_COMPLETE(skill), "info");
		await deps.advanceAfter(curCtx, currentName, stageIdx, run);
		return;
	}

	// Backstop: the generator wants another unit but we've hit the run-wide
	// cap. Halt with a terminal failure (mirrors the backward-jump guard) so a
	// runaway generator can't loop forever.
	if (accumulated.length >= run.maxIterations) {
		await deps.haltIterations(curCtx, run, currentName, accumulated.length);
		return;
	}

	curCtx.ui.setStatus(STATUS_KEY, STATUS_ITERATE_UNIT(stageIdx + 1, run.totalStages, skill, unit.label));
	const snapshot = await deps.captureSnapshot(def, stageIdx, run);

	await deps.runStageSession(curCtx, {
		cwd: run.cwd,
		runId: run.runId,
		state: run.state,
		prompt: `/skill:${skill} ${unit.prompt}`,
		// Decorated for the JSONL row + status; named keying still resolves to
		// outcome.name (mandatory for iterate), so the decoration never splits
		// the accumulation slot.
		stageName: iterateRowStage(currentName, unit.id ?? unit.label),
		skill,
		lifecycle: run.lifecycle,
		runIdentity: { workflow: run.workflow.name, totalStages: run.totalStages, trigger: run.trigger },
		stage: def,
		stageIndex: stageIdx,
		snapshot,
		branchOffset: undefined,
		onFailure: undefined,
		onSuccess: (freshCtx) => {
			// `tryRecordStage` set `state.output` to this unit's validated Output
			// (and `maybeAdvancePrimary` already pushed it onto state.named) before
			// onSuccess fired. Thread it into `accumulated` for the next pull.
			const produced = run.state.output!;
			return runIterate(
				freshCtx,
				stageIdx,
				currentName,
				skill,
				def,
				entryArtifact,
				[...accumulated, produced],
				run,
				deps,
			);
		},
	});
}
