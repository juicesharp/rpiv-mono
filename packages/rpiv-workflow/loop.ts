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

import type { AssessLoop, FanoutLoop, LoopDef, StageDef } from "./api.js";
import { decorateStage, runIdentityOf } from "./audit.js";
import { applyCompletedStage } from "./chain-state.js";
import { lifecycleCtxFor, skillStageRef } from "./events.js";
import { isAbortError, nowIso, WorkflowAbortError } from "./internal-utils.js";
import { isPanel } from "./judge.js";
import { panelVerdictChannel, panelVerdictDef } from "./loop-constructors.js";
import {
	advanceCursor,
	fanoutUnitAt,
	foldFanoutCompletion,
	type LoopCursor,
	type LoopEntry,
	loopStrategyOf,
	type NextStep,
	presentedKindOf,
} from "./loop-kinds.js";
import {
	MSG_LOOP_CAP_ADVANCE,
	MSG_LOOP_ZERO_UNITS,
	MSG_STAGE_COMPLETE,
	STATUS_KEY,
	STATUS_LOOP_UNIT,
} from "./messages.js";
import { failedOutput, type Output, type OutputMeta } from "./output.js";
import { Semaphore } from "./semaphore.js";
import { laneFor } from "./sessions/spawn.js";
import { appendLoopCap } from "./state/index.js";
import type { RunContext, StageSession, WorkflowHostContext } from "./types.js";

export interface LoopDeps {
	/** Dispatch one unit through the standard stage-session path. */
	runStageSession: (ctx: WorkflowHostContext, s: StageSession) => Promise<void>;
	/**
	 * Resume the chain after the loop finishes — receives the loop node's REAL
	 * name. `Promise<unknown>` so the walk's `ChainOutcome`-returning composed
	 * advance plugs in directly (the driver only awaits settlement).
	 */
	advanceAfter: (
		curCtx: WorkflowHostContext,
		completedName: string,
		completedIdx: number,
		run: RunContext,
	) => Promise<unknown>;
	/** Re-capture the outcome's pre-stage snapshot per unit (ctx + stage name for the fail-soft warning). */
	captureSnapshot: (
		curCtx: WorkflowHostContext,
		stageName: string,
		def: StageDef,
		idx: number,
		run: RunContext,
	) => Promise<unknown>;
	/** Record the terminal failure when `onCap: "halt"` trips — verify-worded for verify stages. */
	haltLoop: (
		curCtx: WorkflowHostContext,
		run: RunContext,
		e: Pick<LoopEntry, "name" | "def">,
		count: number,
		cap: number,
	) => Promise<void>;
	/** Record a mid-flight run abort at the loop seam (FAIL_WORKFLOW_ABORTED).
	 *  Keeps loop.ts free of engine imports; wired to `recordAbortedAtSeam`. */
	recordAborted: (curCtx: WorkflowHostContext, name: string, run: RunContext) => Promise<void>;
	/** Funnel an UNEXPECTED worker rejection (not a workflow halt) to a
	 *  terminal-failure row + onStageError, terminating state WITHOUT re-throwing,
	 *  so entry() resolves and onWorkflowEnd still fires. Wraps recordEntryThrow. */
	recordWorkerThrow: (
		curCtx: WorkflowHostContext,
		name: string,
		unitIndex: number,
		run: RunContext,
		err: unknown,
	) => Promise<void>;
}

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
 * Bounded-parallel fanout dispatch. Units are independent, so dispatch up
 * to `cap` of them through a Semaphore(maxConcurrency); fold results into the
 * cursor in DECLARED (index) order through the single `foldFanoutCompletion` —
 * never completion order — so `fanin` synthesis + resume stay deterministic.
 * iterate/assess never reach here (not parallelizable).
 */
async function runFanoutParallel(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	cap: number,
	run: RunContext,
	deps: LoopDeps,
): Promise<void> {
	const dispatchCount = Math.min(e.units!.length, cap);
	// a per-generation AbortController is the signal the children + the
	// semaphore actually observe. It fires on EITHER (a) run-level abort (Ctrl-C,
	// run.signal — propagated below) OR (b) the first fail-fast unit halt (so
	// in-flight siblings are cancelled mid-flight, not merely halted-after-settle).
	const genAbort = new AbortController();
	// Name the handler so it can be REMOVED once this generation settles — run.signal
	// lives for the WHOLE run, so an anonymous listener per fanout stage would
	// accumulate (and retain its genAbort closure) across N non-aborted stages.
	const onRunAbort = () => genAbort.abort();
	if (run.signal) {
		if (run.signal.aborted) genAbort.abort();
		else run.signal.addEventListener("abort", onRunAbort, { once: true });
	}
	const failFast = e.loop.kind === "fanout" && (e.loop as FanoutLoop).failFast === true;
	const sem = new Semaphore(Math.max(1, curCtx.maxConcurrency), genAbort.signal); // drains queued units on either abort
	const settled = await Promise.allSettled(
		Array.from({ length: dispatchCount }, (_u, i) =>
			sem
				.run(() => dispatchUnitDetached(curCtx, e, i, run, deps, genAbort.signal))
				.then((out) => {
					// a fail-fast unit's worker terminated state via recordTerminalFailure;
					// fire genAbort so the in-flight siblings get session.abort()'d NOW. Each
					// worker is its own task, so this fires while siblings are still running.
					if (failFast && run.state.termination.status !== "running") genAbort.abort();
					return out;
				}),
		),
	);
	run.signal?.removeEventListener("abort", onRunAbort); // generation settled — drop the run-lifetime listener
	// the fold NEVER throws. allSettled guarantees every unit has settled,
	// so entry() always resolves and onWorkflowEnd always fires.
	for (let i = 0; i < settled.length; i++) {
		const r = settled[i]!;
		if (r.status === "rejected") {
			if (isAbortError(r.reason)) continue; // aborted / never-started → unfilled slot (resume re-dispatches)
			// UNEXPECTED rejection (programming error, not a workflow halt). Funnel to
			// a terminal-failure row + onStageError; do NOT re-throw (that would skip
			// onWorkflowEnd). recordWorkerThrow terminates state and records the row.
			await deps.recordWorkerThrow(curCtx, e.name, i, run, r.reason);
			continue;
		}
		cursor.ranThisInvocation++;
		// index-addressed placement (shared with the resume fold) so
		// declared order survives parallel completion + resume.
		foldFanoutCompletion(run.state, cursor, e.def, e.name, i, e.units!.length, r.value);
	}
	// A fail-fast unit halt already ran recordTerminalFailure inside its worker's
	// postStage (terminate()d state, fired onStageError). Detect it and return
	// gracefully — executeRun builds the envelope + fires onWorkflowEnd.
	if (run.state.termination.status !== "running") return;
	if (run.signal?.aborted) return deps.recordAborted(curCtx, e.name, run); // mid-flight abort → FAIL_WORKFLOW_ABORTED
	if (e.units!.length > cap) return hitCap(curCtx, e, cursor, cap, cap, run, deps);
	return finishLoop(curCtx, e, cursor, run, deps);
}

/** Indices whose slot is still unfilled after the fold — the units to re-run. */
export function pendingFanoutIndices(cursor: LoopCursor, total: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < total; i++) if (cursor.slots?.[i] === undefined) out.push(i);
	return out;
}

/** Resume re-dispatch: run the still-pending fanout units in bounded parallel,
 *  folding each at its declared index (so completed slots keep their position).
 *  Pending fanout units COLD re-dispatch via `dispatchUnitDetached` (a fresh
 *  child each) — fanout units are idempotent (each writes its own distinct
 *  artifact at its declared index), so a partial in-flight session is discarded
 *  rather than reattached; this matches what the live loop does above. The
 *  run-scoped `childSessionsDir` + the id-first `locateSessionFile` serve the
 *  SINGLE-STAGE session-backed reattach path (run-stage.ts), not this fanout
 *  re-dispatch. */
export async function runFanoutResume(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	run: RunContext,
	deps: LoopDeps,
	pending: readonly number[],
): Promise<void> {
	// Same per-generation abort as the live path: run-level abort OR a
	// fail-fast halt cancels the in-flight re-dispatched siblings.
	const genAbort = new AbortController();
	const onRunAbort = () => genAbort.abort(); // removed after settle (run-lifetime signal — see runFanoutParallel)
	if (run.signal) {
		if (run.signal.aborted) genAbort.abort();
		else run.signal.addEventListener("abort", onRunAbort, { once: true });
	}
	const failFast = e.loop.kind === "fanout" && (e.loop as FanoutLoop).failFast === true;
	const sem = new Semaphore(Math.max(1, curCtx.maxConcurrency), genAbort.signal);
	const settled = await Promise.allSettled(
		pending.map((i) =>
			sem
				.run(() => dispatchUnitDetached(curCtx, e, i, run, deps, genAbort.signal))
				.then((out) => {
					if (failFast && run.state.termination.status !== "running") genAbort.abort();
					return out;
				}),
		),
	);
	run.signal?.removeEventListener("abort", onRunAbort);
	for (let k = 0; k < settled.length; k++) {
		const r = settled[k]!;
		const i = pending[k]!;
		if (r.status === "rejected") {
			if (isAbortError(r.reason)) continue; // aborted / never-started → unfilled slot (resume re-dispatches)
			await deps.recordWorkerThrow(curCtx, e.name, i, run, r.reason); // never throw
			continue;
		}
		cursor.ranThisInvocation++;
		foldFanoutCompletion(run.state, cursor, e.def, e.name, i, e.units!.length, r.value);
	}
	if (run.state.termination.status !== "running") return; // fail-fast halt already recorded
	if (run.signal?.aborted) return deps.recordAborted(curCtx, e.name, run);
	return finishLoop(curCtx, e, cursor, run, deps);
}

/** Dispatch one fanout unit in its own child and RETURN its output. The cursor
 *  is NOT touched here — the parallel fold consumes the return value in index
 *  order. A halted unit leaves `captured` unset; returns failedOutput.
 *
 *  Lifecycle parity (matches the sequential `dispatchUnit`): fires `onUnitStart`
 *  HERE before the child opens; `onUnitEnd` fires for free inside
 *  `recordStageSuccess` (gated on `s.unit`) when the unit succeeds.
 *
 *  Three settle shapes. Only ABORT throws (intentionally); the two no-output
 *  shapes never throw (an unexpected throw would reject the allSettled
 *  slot and, if re-thrown, skip onWorkflowEnd):
 *   • collect-all unit failure: softHaltUnit DID call onSuccess(sentinel), so
 *     `captured` is the failedOutput sentinel — returned and placed normally.
 *   • fail-fast unit halt: postStage ran haltStage → recordTerminalFailure
 *     already terminated state + fired onStageError, and did NOT call onSuccess,
 *     so `captured` is undefined. Return a placement sentinel; the caller's
 *     `state.termination.status !== "running"` check then returns gracefully.
 *   • ABORT: postStage threw WorkflowAbortError (the SDK resolved prompt()
 *     with stopReason:"aborted"). The throw propagates to runFanoutParallel's
 *     allSettled, where isAbortError leaves the slot unfilled so resume
 *     re-dispatches the unit. No row is written. */
async function dispatchUnitDetached(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	index: number,
	run: RunContext,
	deps: LoopDeps,
	signal: AbortSignal | undefined, // genAbort.signal — run-level abort OR fail-fast sibling cancel
): Promise<Output> {
	if (signal?.aborted) throw new WorkflowAbortError(); // never open a child after abort; isAbortError → unfilled slot
	const u = fanoutUnitAt(e, index);
	curCtx.ui.setStatus(STATUS_KEY, STATUS_LOOP_UNIT(e.stageIdx + 1, run.totalStages, u.skill, u.label));
	await run.lifecycle.fire(
		curCtx,
		"onUnitStart",
		skillStageRef(e.name, e.stageIdx + 1, u.skill),
		{ role: u.role, index, unitId: u.id, label: u.label, skill: u.skill },
		lifecycleCtxFor(run),
	);
	const snapshot = await deps.captureSnapshot(curCtx, e.name, u.def, e.stageIdx, run);
	let captured: Output | undefined;
	await deps.runStageSession(
		curCtx,
		buildUnitSession(e, u, index, run, snapshot, signal, (_child, output) => {
			captured = output;
			return Promise.resolve();
		}),
	);
	return captured ?? failedOutput(unitOutputMeta(e, u, run), `${u.label}: unit halted`);
}

/** Minimal OutputMeta for a fail-fast placement sentinel. The run is terminating
 *  when this is used, so the sentinel is never read downstream; it only keeps the
 *  fold's Output type intact without a throw. */
function unitOutputMeta(e: LoopEntry, u: Extract<NextStep, { kind: "unit" }>, run: RunContext): OutputMeta {
	return {
		stage: decorateStage(e.name, u.tag),
		skill: u.skill,
		stageNumber: run.state.lastAllocatedStageNumber,
		ts: nowIso(),
		runId: run.runId,
	};
}

/** Factored unit StageSession — shared by the sequential `dispatchUnit` and the
 *  parallel `dispatchUnitDetached`; differs only in `onSuccess` and the threaded
 *  `signal`. Populates the per-child execution controls (lane/model/signal). The
 *  sequential path passes `run.signal` (run-level abort only); the detached path
 *  passes the per-generation `genAbort.signal` (run-level abort OR fail-fast
 *  sibling cancel). */
function buildUnitSession(
	e: LoopEntry,
	u: Extract<NextStep, { kind: "unit" }>,
	index: number,
	run: RunContext,
	snapshot: unknown,
	signal: AbortSignal | undefined,
	onSuccess: StageSession["onSuccess"],
): StageSession {
	return {
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
		unit: { parent: e.name, role: u.role, index, id: u.id, label: u.label },
		lane: laneFor(run.skillContracts, u.skill),
		model: run.resolveModel?.({ stage: e.name, skill: u.skill }),
		signal,
		// fanout units collect-all by default (opt out via fanout({ failFast: true })):
		collectAll: e.loop.kind === "fanout" && !(e.loop as FanoutLoop).failFast,
		onFailure: undefined,
		onSuccess,
	};
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
			// early-returns for fanout, so the sequential re-dispatch path used
			// on RESUME (a non-pristine cursor falls through `runLoop` to `step`) must
			// fold here too, not lean on the removed `applyCompletedStage` channel
			// push. `cursor.index` is the dispatched unit's index (evaluated before
			// the fold advances it). iterate/assess keep the sequential cursor
			// advance + panel publish.
			if (e.loop.kind === "fanout") {
				foldFanoutCompletion(run.state, cursor, e.def, e.name, cursor.index, e.units!.length, output);
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
