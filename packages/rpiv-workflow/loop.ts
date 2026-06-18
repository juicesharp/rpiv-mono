/**
 * loop.ts — THE unit-loop driver. One continuation loop runs every loop
 * stage: `fanout` (push: units precomputed), `iterate` (pull: one unit per
 * generator call, accumulating), `assess` (producer→judge rounds until the
 * judge's verdict satisfies `done`). The only per-kind code is the strategy
 * table in loop-kinds.ts (`pull` / `guardExpectation` / `hasPending`) —
 * dispatch, persistence, cap policy, result projection, and completion are
 * shared and kind-agnostic here.
 *
 * A `verify`-bearing stage runs here too — `effectiveLoopOf` desugars it into
 * a degenerate assess loop; verify-aware code is presentation only
 * (role/label flavoring keyed on `e.def.verify` inside the assess strategy).
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
 * `runner/run-stage.ts` injects primitives through `LoopDeps` so this
 * module never imports the engine back (cycle-free).
 *
 * Resume re-enters `runLoop` with a fold-reconstructed cursor (see
 * `runner/resume-loop.ts`); the silence rule — banner only when this
 * invocation dispatched ≥1 unit — keeps a finished-loop resume a silent
 * no-op (pinned behavior).
 */

import type { AssessLoop, LoopDef } from "./api.js";
import { applyCompletedStage } from "./chain-state.js";
import { lifecycleCtxFor, skillStageRef } from "./events.js";
import { nowIso } from "./internal-utils.js";
import { isPanel } from "./judge.js";
import { panelVerdictChannel, panelVerdictDef } from "./loop-constructors.js";
import {
	advanceCursor,
	buildUnitSession,
	foldFanoutCompletion,
	type LoopCursor,
	type LoopDeps,
	type LoopEntry,
	loopStrategyOf,
	type NextStep,
	presentedKindOf,
} from "./loop-kinds.js";
import { runFanoutDispatch } from "./loop-parallel.js";
import {
	MSG_LOOP_CAP_ADVANCE,
	MSG_LOOP_ZERO_UNITS,
	MSG_STAGE_COMPLETE,
	STATUS_KEY,
	STATUS_LOOP_UNIT,
} from "./messages.js";
import { appendLoopCap } from "./state/index.js";
import type { RunContext, WorkflowHostContext } from "./types.js";

/**
 * The loop-entry announcement — `onStageStart` then `onLoopStart` with the
 * presented kind (+ the precomputed unit list when the loop has one). ONE
 * helper for the live entry (`runLoopStage`) and the resume re-entry
 * (`resumeLoopStage`), which used to re-spell the pair and keep the
 * presented-kind expression aligned by convention.
 */
export async function announceLoopStart(
	curCtx: WorkflowHostContext,
	run: RunContext,
	e: Pick<LoopEntry, "stageIdx" | "name" | "skill" | "def" | "loop" | "units">,
): Promise<void> {
	const ref = skillStageRef(e.name, e.stageIdx + 1, e.skill);
	await run.lifecycle.fire(curCtx, "onStageStart", ref, lifecycleCtxFor(run));
	await run.lifecycle.fire(
		curCtx,
		"onLoopStart",
		ref,
		{ kind: presentedKindOf(e.def, e.loop), ...(e.units ? { units: e.units } : {}) },
		lifecycleCtxFor(run),
	);
}

/** A pristine cursor ⇒ a live first entry. A resumed cursor (index advanced or
 *  any units folded) routes to the sequential path; resume instead
 *  re-dispatches only the still-pending children. */
const isPristine = (cursor: LoopCursor): boolean =>
	cursor.index === 0 && cursor.accumulated.length === 0 && cursor.slots === undefined;

/** Run (or resume) one loop generation. The caller fired onStageStart/onLoopStart. */
export async function runLoop(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	run: RunContext,
	deps: LoopDeps,
): Promise<void> {
	const cap = Math.min(e.loop.max ?? Number.POSITIVE_INFINITY, run.maxIterations);
	// ALL fanout goes through the index-addressed parallel path (Semaphore(1)
	// just serializes when maxConcurrency === 1) — so the named-channel + cursor
	// representation is identical at every concurrency AND matches the resume
	// fold. iterate/assess keep the sequential step()/advanceCursor.
	// (Live entry is always pristine; resume routes to runFanoutResume directly.)
	if (e.loop.kind === "fanout" && loopStrategyOf(e.loop.kind).parallelizable && isPristine(cursor)) {
		return runFanoutParallel(curCtx, e, cursor, cap, run, deps);
	}
	await step(curCtx, e, cursor, cap, run, deps);
}

/**
 * Live bounded-parallel fanout entry — thin wrapper over the shared
 * `runFanoutDispatch` (loop-parallel.ts). Dispatches the first `cap` units
 * (`0..dispatchCount-1`); on completion picks the cap policy: over-cap units
 * trip `hitCap`, otherwise the loop finishes. iterate/assess never reach here
 * (not parallelizable).
 */
function runFanoutParallel(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	cap: number,
	run: RunContext,
	deps: LoopDeps,
): Promise<void> {
	const operands = Array.from({ length: Math.min(e.units!.length, cap) }, (_u, i) => i);
	return runFanoutDispatch(curCtx, e, cursor, run, deps, operands, () =>
		e.units!.length > cap ? hitCap(curCtx, e, cursor, cap, cap, run, deps) : finishLoop(curCtx, e, cursor, run, deps),
	);
}

/** Indices whose slot is still unfilled after the fold — the units to re-run. */
export function pendingFanoutIndices(cursor: LoopCursor, total: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < total; i++) if (cursor.slots?.[i] === undefined) out.push(i);
	return out;
}

/** Resume re-dispatch — thin wrapper over the shared `runFanoutDispatch`
 *  (loop-parallel.ts). Runs the still-pending fanout units in bounded parallel,
 *  folding each at its declared index (so completed slots keep their position),
 *  and always finishes (the live run already settled the cap policy). Pending
 *  fanout units COLD re-dispatch (a fresh child each) — fanout units are
 *  idempotent (each writes its own distinct artifact at its declared index), so a
 *  partial in-flight session is discarded rather than reattached; this matches
 *  what the live loop does. The run-scoped `childSessionsDir` + the id-first
 *  `locateSessionFile` serve the SINGLE-STAGE session-backed reattach path
 *  (run-stage.ts), not this fanout re-dispatch. */
export function runFanoutResume(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	run: RunContext,
	deps: LoopDeps,
	pending: readonly number[],
): Promise<void> {
	return runFanoutDispatch(curCtx, e, cursor, run, deps, pending, () => finishLoop(curCtx, e, cursor, run, deps));
}

// ---------------------------------------------------------------------------
// The step cycle
// ---------------------------------------------------------------------------

async function step(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	cap: number,
	run: RunContext,
	deps: LoopDeps,
): Promise<void> {
	const next = await loopStrategyOf(e.loop.kind).pull(e, cursor, cap, run);
	if (next.kind === "complete") return finishLoop(curCtx, e, cursor, run, deps);
	if (next.kind === "cap") return hitCap(curCtx, e, cursor, next.count, cap, run, deps);
	return dispatchUnit(curCtx, e, cursor, next, cap, run, deps);
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

	await run.lifecycle.fire(
		curCtx,
		"onUnitStart",
		skillStageRef(e.name, e.stageIdx + 1, u.skill),
		{ role: u.role, index: cursor.index, unitId: u.id, label: u.label, skill: u.skill },
		lifecycleCtxFor(run),
	);

	const snapshot = await deps.captureSnapshot(curCtx, e.name, u.def, e.stageIdx, run);

	await deps.runStageSession(
		curCtx,
		buildUnitSession(e, u, cursor.index, run, snapshot, run.signal, (freshCtx, output) => {
			cursor.ranThisInvocation++;
			// Fanout owns its channel + cursor through the index-addressed
			// `foldFanoutCompletion` (→ placeFanoutOutput) — `applyCompletedStage`
			// early-returns for fanout, so this sequential single-dispatch fallback
			// must fold here too, not lean on the removed `applyCompletedStage`
			// channel push. `cursor.index` is the dispatched unit's index; the fold
			// updates `filledCount` (not `index`), so advance the pointer explicitly.
			// (Currently unreached for fanout: live → runFanoutParallel, resume →
			// runFanoutResume; kept consistent so "index = pointer" holds everywhere.)
			// iterate/assess keep the sequential cursor advance + panel publish.
			if (e.loop.kind === "fanout") {
				foldFanoutCompletion(run.state, cursor, e.def, e.name, cursor.index, e.units!.length, output);
				cursor.index++;
			} else {
				advanceCursor(cursor, u.role, output, e.loop);
				publishPanelVerdict(e.loop, e.name, cursor, run.state);
			}
			return step(freshCtx, e, cursor, cap, run, deps);
		}),
	);
}

/**
 * Panel-close publish — lands a panel's FOLDED verdict on its named channel,
 * run by BOTH the live driver (`dispatchUnit.onSuccess`) and the resume fold
 * (`runner/resume.ts` `foldUnitRow`) immediately after the SAME `advanceCursor`,
 * so the two paths publish byte-identically (THE REPLAY CONTRACT). Fires exactly
 * once per round — only on the transition that closes a panel: the LAST member's
 * judge advance is the one that clears `cursor.panel` AND flips back to `produce`
 * with the folded verdict already on `lastVerdict`. A single judge (non-panel),
 * a mid-panel member advance (`cursor.panel` still set), and every produce
 * advance (`phase` left at `judge`) all fall through untouched. `advanceCursor`
 * already manufactured the verdict (pure); this only appends it — the fold
 * carries no artifact, so `applyCompletedStage` leaves the rolling primary alone
 * and writes only the named channel. It lives BESIDE `advanceCursor`, not inside
 * it: publishing mutates `RunState`, and `advanceCursor` must stay pure for the
 * live + resume folds to agree.
 */
export function publishPanelVerdict(
	loop: LoopDef,
	stageName: string,
	cursor: LoopCursor,
	state: RunContext["state"],
): void {
	if (loop.kind !== "assess") return;
	const judge = (loop as AssessLoop).judge;
	if (!isPanel(judge) || cursor.panel !== undefined || cursor.phase !== "produce") return;
	if (cursor.lastVerdict === undefined) return; // defensive — the fold always set it
	applyCompletedStage(
		state,
		panelVerdictDef(judge, stageName),
		panelVerdictChannel(judge, stageName),
		cursor.lastVerdict,
	);
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
		lifecycleCtxFor(run),
	);
	return finishLoop(curCtx, e, cursor, run, deps);
}
