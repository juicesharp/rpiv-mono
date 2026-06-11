/**
 * loop.ts — THE unit-loop driver. One continuation loop runs every loop
 * stage: `fanout` (push: units precomputed), `iterate` (pull: one unit per
 * generator call, accumulating), `assess` (producer→judge rounds until the
 * judge's verdict satisfies `done`). The only per-kind code is `pullNext` —
 * dispatch, persistence, cap policy, result projection, and completion are
 * shared.
 *
 * A `verify`-bearing stage runs here too — `effectiveLoopOf` desugars it into
 * a degenerate assess loop; the only verify-aware code in this module is
 * presentation (role/label flavoring keyed on `e.def.verify`).
 *
 * Every unit runs `runStageSession` with a pre-decorated session: `stageName`
 * carries the DISPLAY decoration (`decorateStage`), `unit` carries the
 * machine identity that lands in the row's `parent`/`role`/`unitId`/`unitIndex`
 * fields and the `onUnitStart`/`onUnitEnd` payloads.
 *
 * Continuation-style: each unit's `onSuccess` advances the cursor and
 * re-enters `step`. Everything is awaited up the stack, so a throw from a
 * user fn (`units`/`next`/`feedForward`/`done`/judge prompt) propagates to
 * `runStageOrRecordFailure`'s single catch — a thrown `StagePreflightError`
 * (the `haltPreflight` consumer contract) keeps its own attribution.
 *
 * Capture semantics (the post-refactor bug class — pinned):
 *   - `entryArtifact` + `entryPair` frozen by the CALLER before unit 1;
 *   - snapshot captured per unit, immediately before its session;
 *   - the skill registry was snapshotted once at run start (RunContext).
 *
 * `runner.ts` (via `stage-lifecycle.ts`) injects primitives through
 * `LoopDeps` so this module never imports back (cycle-free).
 *
 * Resume re-enters `runLoop` with a fold-reconstructed cursor (see
 * `runner/resume-loop.ts`); the silence rule — banner only when this
 * invocation dispatched ≥1 unit — keeps a finished-loop resume a silent
 * no-op (pinned behavior).
 */

import type { LoopDef, StageDef, Unit, UnitRole } from "./api.js";
import { decorateStage, nowIso, runIdentityOf } from "./audit.js";
import { type Artifact, handleToString } from "./handle.js";
import { type Judge, resolveJudgePrompt } from "./judge.js";
import { buildLifecycleContext, type LifecycleContext, skillStageRef, type UnitEvent } from "./lifecycle.js";
import {
	MSG_LOOP_CAP_ADVANCE,
	MSG_LOOP_ZERO_UNITS,
	MSG_STAGE_COMPLETE,
	STATUS_KEY,
	STATUS_LOOP_UNIT,
} from "./messages.js";
import type { Output } from "./output.js";
import { appendLoopCap } from "./state/index.js";
import type { RunContext, StageSession, UnitRef, WorkflowHostContext } from "./types.js";

export interface LoopDeps {
	/** Dispatch one unit through the standard stage-session path. */
	runStageSession: (ctx: WorkflowHostContext, s: StageSession) => Promise<void>;
	/** Resume the chain after the loop finishes — receives the loop node's REAL name. */
	advanceAfter: (
		curCtx: WorkflowHostContext,
		completedName: string,
		completedIdx: number,
		run: RunContext,
	) => Promise<void>;
	/** Re-capture the outcome's pre-stage snapshot per unit. */
	captureSnapshot: (def: StageDef, idx: number, run: RunContext) => Promise<unknown>;
	/** Record the terminal failure when `onCap: "halt"` trips — verify-worded for verify stages. */
	haltLoop: (
		curCtx: WorkflowHostContext,
		run: RunContext,
		e: Pick<LoopEntry, "name" | "def">,
		count: number,
		cap: number,
	) => Promise<void>;
}

/**
 * Frozen per-invocation loop identity, built by the caller (`tryLoop` live;
 * `resume-loop` on resume). `entryArtifact`/`entryArgs`/`entryPair` are
 * captured BEFORE unit 1 and never change.
 */
export interface LoopEntry {
	stageIdx: number;
	/** Loop stage record key (routing + row `parent` + event refs). */
	name: string;
	/** Parent stage's resolved skill body (produce units dispatch it). */
	skill: string;
	/** Parent stage def — produce units run with its knobs. */
	def: StageDef;
	loop: LoopDef;
	/** Stage-entry primary, FROZEN (IterateContext.artifact / JudgeContext.entryArtifact). */
	entryArtifact: Artifact | undefined;
	/** Round-0 producer arg (assess) — precomputed via `inputForStage`. */
	entryArgs: string;
	/** {output, primaryArtifact} captured at loop entry — the "entry" projection. */
	entryPair: { output: Output | undefined; primaryArtifact: Artifact | undefined };
	/** Precomputed unit list — fanout only (computed by tryLoop / verified by the resume fold). */
	units?: readonly Unit[];
}

/** Mutable generation cursor threaded through the continuation self-calls. */
export interface LoopCursor {
	/** 0-based index of the NEXT unit (== the round for assess). */
	index: number;
	/** This generation's completed produce Outputs, in order (the iterate pull prefix). */
	accumulated: Output[];
	/** Last completed produce unit's pair — "last" projection + judge input. */
	lastProduce?: { output: Output; artifact: Artifact | undefined };
	/** Last judge verdict — feedForward input + done fast-path. */
	lastVerdict?: Output;
	/** Which assess sub-step is next ("produce" for non-assess loops). */
	phase: "produce" | "judge";
	/** Units dispatched by THIS driver invocation — the resume silence rule. */
	ranThisInvocation: number;
}

/** Pristine cursor for a live (non-resume) loop entry. */
export function freshCursor(): LoopCursor {
	return { index: 0, accumulated: [], phase: "produce", ranThisInvocation: 0 };
}

/** Stable unit identity — `row.unitId`, the display tag, and the resume guard's join key. */
export const unitTagOf = (u: Unit): string => u.id ?? u.label;

/**
 * Synthetic `produces` def a judge unit runs on: the verdict is validated +
 * published by `judge.outcome`; `sessionPolicy: "fresh"` so it never replays
 * the producer's branch. Parent validation knobs are DELIBERATELY not copied
 * (judge sessions use framework defaults; a skill judge still picks up its
 * own declared contract via `effectiveOutputSchema`). The ONE construction
 * site — the resume fold reuses it for verdict publishing.
 */
export function judgeStageDef(judge: Judge): StageDef {
	return { kind: "produces", outcome: judge.outcome, sessionPolicy: "fresh" };
}

/** Run (or resume) one loop generation. The caller fired onStageStart/onLoopStart. */
export async function runLoop(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	run: RunContext,
	deps: LoopDeps,
): Promise<void> {
	const cap = Math.min(e.loop.max ?? Number.POSITIVE_INFINITY, run.maxIterations);
	await step(curCtx, e, cursor, cap, run, deps);
}

// ---------------------------------------------------------------------------
// The step cycle
// ---------------------------------------------------------------------------

type NextStep =
	| { kind: "complete" }
	| { kind: "cap"; count: number }
	| {
			kind: "unit";
			role: UnitRole;
			/** Display + identity tag (`unitId` for fanout/iterate; `r{n}·{phase}` display-only for assess). */
			tag: string;
			id?: string;
			label: string;
			skill: string;
			prompt: string;
			def: StageDef;
	  };

async function step(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	cap: number,
	run: RunContext,
	deps: LoopDeps,
): Promise<void> {
	const next = await pullNext(e, cursor, cap, run);
	if (next.kind === "complete") return finishLoop(curCtx, e, cursor, run, deps);
	if (next.kind === "cap") return hitCap(curCtx, e, cursor, next.count, cap, run, deps);
	return dispatchUnit(curCtx, e, cursor, next, cap, run, deps);
}

/**
 * The ONLY per-kind code. Cap-check positions preserve today's semantics:
 * iterate checks POST-pull (the null terminator wins; the generator gets one
 * extra discarded call), assess checks pre-round, fanout checks pre-index.
 * For assess, a `done` verdict wins over the cap (a done loop is a normal
 * completion, never a cap event).
 */
async function pullNext(e: LoopEntry, cursor: LoopCursor, cap: number, run: RunContext): Promise<NextStep> {
	const loop = e.loop;

	if (loop.kind === "fanout") {
		const units = e.units!; // tryLoop computed it (empty list never reaches the driver)
		if (cursor.index >= units.length) return { kind: "complete" };
		if (cursor.index >= cap) return { kind: "cap", count: cursor.index };
		const u = units[cursor.index]!;
		const tag = unitTagOf(u);
		return {
			kind: "unit",
			role: "produce",
			tag,
			id: tag,
			label: u.label,
			skill: e.skill,
			prompt: `/skill:${e.skill} ${u.prompt}`,
			def: e.def,
		};
	}

	if (loop.kind === "iterate") {
		const u = await loop.next({
			cwd: run.cwd,
			artifact: e.entryArtifact,
			state: run.state,
			accumulated: cursor.accumulated,
			index: cursor.index,
		});
		if (!u) return { kind: "complete" };
		if (cursor.accumulated.length >= cap) return { kind: "cap", count: cursor.accumulated.length };
		const tag = unitTagOf(u);
		return {
			kind: "unit",
			role: "produce",
			tag,
			id: tag,
			label: u.label,
			skill: e.skill,
			prompt: `/skill:${e.skill} ${u.prompt}`,
			def: e.def,
		};
	}

	// assess — including a synthesized verify loop. Verify-ness is derived from
	// the parent def (`e.def.verify`), never from the loop object: the synthesis
	// carries no marker, so live and resume can't disagree about flavoring.
	const isVerify = e.def.verify !== undefined;
	if (cursor.phase === "judge") {
		const lp = cursor.lastProduce!; // a judge step always follows a completed produce
		const judge = loop.judge;
		const judgeSkill = judge.skill ?? (isVerify ? `${e.name}-verify` : `${e.name}-judge`);
		const prompt =
			judge.skill !== undefined
				? `/skill:${judge.skill} ${handleToString(lp.artifact!.handle)}`
				: await resolveJudgePrompt(judge.prompt!, {
						cwd: run.cwd,
						output: lp.output,
						entryArtifact: e.entryArtifact,
						state: run.state,
						round: cursor.index,
					});
		const label = isVerify ? `a${cursor.index}·verify` : `r${cursor.index}·judge`;
		return {
			kind: "unit",
			role: isVerify ? "verify" : "judge",
			tag: label,
			label,
			skill: judgeSkill,
			prompt,
			def: judgeStageDef(judge),
		};
	}

	// assess produce — done wins over cap (one code path for live + resume fast-advance)
	if (cursor.lastVerdict !== undefined && loop.done(cursor.lastVerdict)) return { kind: "complete" };
	if (cursor.index >= cap) return { kind: "cap", count: cursor.index };
	// `lastVerdict` is only set by a completed judge, which also bumps `index` —
	// so `index - 1 ≥ 0` whenever feedForward runs (round 0 takes entryArgs).
	const arg =
		cursor.lastVerdict !== undefined
			? loop.feedForward({
					cwd: run.cwd,
					output: cursor.lastProduce!.output,
					verdict: cursor.lastVerdict,
					round: cursor.index - 1,
					state: run.state,
				})
			: e.entryArgs;
	const label = isVerify ? `a${cursor.index}·attempt` : `r${cursor.index}·produce`;
	return {
		kind: "unit",
		role: "produce",
		tag: label,
		label,
		skill: e.skill,
		prompt: `/skill:${e.skill} ${arg}`,
		def: e.def,
	};
}

/** Dispatch one unit session; the onSuccess continuation advances the cursor and re-enters step. */
async function dispatchUnit(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	u: Extract<NextStep, { kind: "unit" }>,
	cap: number,
	run: RunContext,
	deps: LoopDeps,
): Promise<void> {
	curCtx.ui.setStatus(STATUS_KEY, STATUS_LOOP_UNIT(e.stageIdx + 1, run.totalStages, u.skill, u.label));

	const unitRef: UnitRef = { parent: e.name, role: u.role, index: cursor.index, id: u.id, label: u.label };
	const event: UnitEvent = { role: u.role, index: cursor.index, unitId: u.id, label: u.label, skill: u.skill };
	await run.lifecycle.fire(
		curCtx,
		"onUnitStart",
		skillStageRef(e.name, e.stageIdx + 1, u.skill),
		event,
		lifecycleCtxOf(run),
	);

	const snapshot = await deps.captureSnapshot(u.def, e.stageIdx, run);

	await deps.runStageSession(curCtx, {
		cwd: run.cwd,
		runId: run.runId,
		state: run.state,
		prompt: u.prompt,
		stageName: decorateStage(e.name, u.tag), // DISPLAY only — machine identity is `unit`
		skill: u.skill,
		lifecycle: run.lifecycle,
		runIdentity: runIdentityOf(run),
		stage: u.def,
		skillContracts: run.skillContracts,
		stageIndex: e.stageIdx,
		snapshot,
		branchOffset: undefined,
		unit: unitRef,
		onFailure: undefined,
		onSuccess: (freshCtx, output) => {
			cursor.ranThisInvocation++;
			if (u.role === "produce") {
				cursor.accumulated.push(output);
				cursor.lastProduce = { output, artifact: output.artifacts[0] };
				if (e.loop.kind === "assess") cursor.phase = "judge";
				else cursor.index++;
			} else {
				cursor.lastVerdict = output;
				cursor.phase = "produce";
				cursor.index++;
			}
			return step(freshCtx, e, cursor, cap, run, deps);
		},
	});
}

// ---------------------------------------------------------------------------
// Loop end — projection, notification, cap policy
// ---------------------------------------------------------------------------

/**
 * The declared `result` projection — the ONE place the loop's outcome lands
 * in `{state.output, state.primaryArtifact}` (the pair is governed as one;
 * mid-loop transient rolls are accepted by design). The resume fold applies
 * this same function at generation close.
 */
export function projectResult(
	loop: LoopDef,
	entryPair: LoopEntry["entryPair"],
	cursor: LoopCursor,
	state: RunContext["state"],
): void {
	if (loop.result === "last" && cursor.lastProduce) {
		state.output = cursor.lastProduce.output;
		// `artifact` is undefined only for acts-stage units (produces units are
		// guaranteed ≥1 artifact by enforceCompletionContract) — the entry
		// primary carries through, mirroring how a single acts stage behaves.
		state.primaryArtifact = cursor.lastProduce.artifact ?? entryPair.primaryArtifact;
		return;
	}
	// "entry" — or "last" with zero produce units (degrades to entry: the
	// zero-unit pull loop leaves the chain exactly as it found it).
	state.output = entryPair.output;
	state.primaryArtifact = entryPair.primaryArtifact;
}

/**
 * Notification rules: banner iff THIS invocation ran units; the zero-unit
 * warning only for a live empty pull loop; a resumed finished loop stays
 * SILENT (pinned — no re-announce, no double completion toast).
 */
async function finishLoop(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	run: RunContext,
	deps: LoopDeps,
): Promise<void> {
	projectResult(e.loop, e.entryPair, cursor, run.state);
	if (cursor.ranThisInvocation > 0) {
		curCtx.ui.notify(MSG_STAGE_COMPLETE(e.skill), "info");
	} else if (cursor.accumulated.length === 0 && e.loop.kind === "iterate") {
		curCtx.ui.notify(MSG_LOOP_ZERO_UNITS(e.skill), "warning");
	}
	await deps.advanceAfter(curCtx, e.name, e.stageIdx, run);
}

/** Cap trip: "halt" → terminal failure; "advance" → durable telemetry + event + projected advance. */
async function hitCap(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	count: number,
	cap: number,
	run: RunContext,
	deps: LoopDeps,
): Promise<void> {
	if (e.loop.onCap === "halt") return deps.haltLoop(curCtx, run, e, count, cap);
	appendLoopCap(run.cwd, run.runId, { type: "loop-cap", stage: e.name, count, max: cap, ts: nowIso() });
	curCtx.ui.notify(MSG_LOOP_CAP_ADVANCE(e.skill, cap), "warning");
	await run.lifecycle.fire(
		curCtx,
		"onLoopCap",
		skillStageRef(e.name, e.stageIdx + 1, e.skill),
		{ kind: e.loop.kind, count, max: cap, policy: "advance" as const },
		lifecycleCtxOf(run),
	);
	return finishLoop(curCtx, e, cursor, run, deps);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Local LifecycleContext builder (no runner import — cycle-free, mirrors the old fanout.ts). */
function lifecycleCtxOf(run: RunContext): LifecycleContext {
	return buildLifecycleContext({
		cwd: run.cwd,
		runId: run.runId,
		workflow: run.workflow.name,
		totalStages: run.totalStages,
		trigger: run.trigger,
		state: run.state,
	});
}
