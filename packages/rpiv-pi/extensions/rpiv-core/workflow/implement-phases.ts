/**
 * Implement-skill phase fanout for the /rpiv workflow runner.
 *
 * When an `implement` skill node runs against a plan artifact whose body
 * contains `## Phase N:` headings, the runner expands the single stage into
 * one session per phase. The expansion is implement-specific: phases iterate
 * over the plan's heading layout, not over per-phase artifacts (the chain's
 * artifact handoff already happened at the plan stage that produced the
 * input).
 *
 * The runner injects `runPhaseSession` and `runNextStage` as dependencies so
 * this module doesn't import from `runner.ts` — avoids a circular module
 * graph while keeping every implement-specific concept (regex, status
 * format, phase-row labels) in one place.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MSG_STAGE_COMPLETE, STATUS_KEY, STATUS_PHASE } from "./messages.js";
import type { ChainCtx, PhaseSession, RunContext } from "./types.js";

// ---------------------------------------------------------------------------
// Dependency interface — runner supplies its primitives so this module
// doesn't import from runner.ts (one-way value graph: runner → phases).
// ---------------------------------------------------------------------------

/**
 * Dependencies the runner supplies to drive a phase iteration. Wrapping these
 * as a struct keeps the call site readable when runImplementPhases recurses.
 */
export interface PhaseFanoutDeps {
	/** Execute one phase session — opaque to phases; runner.ts owns the impl. */
	runPhaseSession: (ctx: ChainCtx, session: PhaseSession) => Promise<void>;
	/** Hand back to the generic stage loop once all phases complete. */
	runNextStage: (curCtx: ChainCtx, nextIdx: number, run: RunContext) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Phase detection — file read + regex
// ---------------------------------------------------------------------------

/** Regex for phase headings in plan artifacts: `## Phase N: {name}`. */
const PHASE_HEADING_REGEX = /^## Phase (\d+):/gm;

/**
 * Count `## Phase N:` headings in a plan artifact, resolving `planPath`
 * relative to `cwd` when it's not absolute. Returns 0 on any failure (missing
 * file, no headings, read error) so callers can branch on phase count without
 * try/catch noise.
 *
 * Fail-soft: never throws.
 */
export function countPhases(planPath: string, cwd: string): number {
	const absolutePath = planPath.startsWith("/") ? planPath : join(cwd, planPath);
	try {
		const content = readFileSync(absolutePath, "utf-8");
		const matches = content.match(PHASE_HEADING_REGEX);
		return matches ? matches.length : 0;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Phase iteration
// ---------------------------------------------------------------------------

/**
 * Run the multi-phase expansion of an `implement` stage. Iterates phases
 * 1..phaseCount, spawning one session per phase via `deps.runPhaseSession`,
 * then hands back to `deps.runNextStage` once every phase has completed.
 *
 * Specific to the `implement` skill — generic-stage logic lives in
 * `runStage`. Caller is responsible for verifying the node is implement-
 * shaped and that the plan artifact has matching `## Phase N:` headings
 * before invoking this function (see `runStage` in runner.ts).
 */
export async function runImplementPhases(
	curCtx: ChainCtx,
	stageIdx: number,
	p: number,
	phaseCount: number,
	run: RunContext,
	deps: PhaseFanoutDeps,
): Promise<void> {
	const { cwd, runId, stageIds, totalStages, state } = run;
	// The audit label for phases is the bare skill name "implement" — that's
	// what runStage's guard checked when fanning out.
	const skill = stageIds[stageIdx]!;

	if (p > phaseCount) {
		curCtx.ui.notify(MSG_STAGE_COMPLETE(skill), "info");
		await deps.runNextStage(curCtx, stageIdx + 1, run);
		return;
	}

	curCtx.ui.setStatus(STATUS_KEY, STATUS_PHASE(stageIdx + 1, totalStages, p, phaseCount));

	await deps.runPhaseSession(curCtx, {
		cwd,
		runId,
		state,
		prompt: `/skill:implement ${state.artifactPath} Phase ${p}`,
		skill,
		phaseIndex: p,
		phaseCount,
		stageIndex: stageIdx,
		onSuccess: (freshCtx) => runImplementPhases(freshCtx, stageIdx, p + 1, phaseCount, run, deps),
	});
}
