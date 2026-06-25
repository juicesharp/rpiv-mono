/**
 * loop-parallel.ts — bounded-parallel fanout dispatch. Fanout units are mutually
 * independent (each writes its own distinct artifact at its declared index), so
 * they dispatch up to `cap` at a time through a `Semaphore(maxConcurrency)` and
 * fold into the cursor in DECLARED (index) order through `foldFanoutCompletion` —
 * never completion order — so `fanin` synthesis + resume stay deterministic at
 * every concurrency (Semaphore(1) just serializes).
 *
 * `runFanoutDispatch` is the ONE dispatch primitive both the live entry
 * (`runFanoutParallel`) and the resume re-dispatch (`runFanoutResume`) — both thin
 * wrappers in loop.ts — degenerate to: each passes its operand list (live:
 * `0..dispatchCount-1`; resume: the still-pending indices) and a `tail` hook for
 * the path-specific completion (live: hitCap-vs-finishLoop on the cap; resume:
 * always finishLoop). The abort/semaphore/fold sequence is shared here, so an
 * abort or fold fix is made once.
 *
 * This module is a downward leaf: it consumes the shared loop foundation
 * (`loop-kinds.ts` — `buildUnitSession`, `fanoutUnitAt`, `foldFanoutCompletion`,
 * `isFailFast`, `LoopDeps`) and never imports loop.ts back (loop.ts → here only).
 */

import { decorateStage } from "./audit.js";
import { lifecycleCtxFor, skillStageRef } from "./events.js";
import { isAbortError, nowIso, WorkflowAbortError } from "./internal-utils.js";
import {
	buildUnitSession,
	fanoutUnitAt,
	foldFanoutCompletion,
	isFailFast,
	type LoopCursor,
	type LoopDeps,
	type LoopEntry,
	type NextStep,
} from "./loop-kinds.js";
import { STATUS_KEY, STATUS_LOOP_UNIT } from "./messages.js";
import { failedOutput, type Output, type OutputMeta, outputMeta } from "./output.js";
import { Semaphore } from "./semaphore.js";
import type { RunContext, UnitRef, WorkflowHostContext } from "./types.js";

/** Structured identity for fanout unit `i` — carried on a worker-throw failure
 *  row (`recordWorkerThrow`) so the unit's identity lands in the row's structured
 *  `unit*` fields instead of being folded into the `stage` name string. Mirrors
 *  the `unit` shape `buildUnitSession` puts on a live unit session. */
const fanoutUnitRef = (e: LoopEntry, i: number): UnitRef => {
	const u = fanoutUnitAt(e, i);
	return { parent: e.name, role: u.role, index: i, id: u.id, label: u.label };
};

/**
 * THE shared parallel-fanout dispatch primitive — wire the per-generation abort,
 * fan the `operands` out through the semaphore, fold each result at its DECLARED
 * index, then run the path-specific `tail`. Both `runFanoutParallel` (live) and
 * `runFanoutResume` (resume) reduce to choosing the operand list + the tail.
 *
 * The per-generation `AbortController` is the signal the children + the semaphore
 * actually observe. It fires on EITHER (a) run-level abort (Ctrl-C, `run.signal` —
 * propagated below) OR (b) the first fail-fast unit halt (so in-flight siblings
 * are cancelled mid-flight, not merely halted-after-settle).
 */
export async function runFanoutDispatch(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	run: RunContext,
	deps: LoopDeps,
	operands: readonly number[],
	tail: () => Promise<void> | void,
): Promise<void> {
	const genAbort = new AbortController();
	// Name the handler so it can be REMOVED once this generation settles — run.signal
	// lives for the WHOLE run, so an anonymous listener per fanout stage would
	// accumulate (and retain its genAbort closure) across N non-aborted stages.
	const onRunAbort = () => genAbort.abort();
	if (run.signal) {
		if (run.signal.aborted) genAbort.abort();
		else run.signal.addEventListener("abort", onRunAbort, { once: true });
	}
	const failFast = isFailFast(e.loop);
	const sem = new Semaphore(Math.max(1, curCtx.maxConcurrency), genAbort.signal); // drains queued units on either abort
	const settled = await Promise.allSettled(
		operands.map((i) =>
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
	// the fold NEVER throws. allSettled guarantees every unit has settled, so
	// entry() always resolves and onWorkflowEnd always fires. `operands[k]` maps the
	// k-th settled result back to its DECLARED unit index — the identity for both
	// the live (0..dispatchCount-1) and resume (pending[]) operand lists.
	for (let k = 0; k < settled.length; k++) {
		const r = settled[k]!;
		const i = operands[k]!;
		if (r.status === "rejected") {
			if (isAbortError(r.reason)) continue; // aborted / never-started → unfilled slot (resume re-dispatches)
			// UNEXPECTED rejection (programming error, not a workflow halt). Funnel to
			// a terminal-failure row + onStageError; do NOT re-throw (that would skip
			// onWorkflowEnd). recordWorkerThrow terminates state and records the row.
			await deps.recordWorkerThrow(curCtx, fanoutUnitRef(e, i), e.skill, run, r.reason);
			continue;
		}
		cursor.ranThisInvocation++;
		// index-addressed placement (shared with the resume fold) so declared order
		// survives parallel completion + resume.
		foldFanoutCompletion(run.state, cursor, e.def, e.name, i, e.units!.length, r.value);
	}
	// A fail-fast unit halt already ran recordTerminalFailure inside its worker's
	// postStage (terminate()d state, fired onStageError). Detect it and return
	// gracefully — executeRun builds the envelope + fires onWorkflowEnd.
	if (run.state.termination.status !== "running") return;
	if (run.signal?.aborted) return deps.recordAborted(curCtx, e.name, run); // mid-flight abort → FAIL_WORKFLOW_ABORTED
	// path-specific completion: live picks hitCap-vs-finishLoop on the cap; resume
	// always finishes (the live run already settled the cap policy).
	return tail();
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
 *     with stopReason:"aborted"). The throw propagates to runFanoutDispatch's
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
	return outputMeta({
		stage: decorateStage(e.name, u.tag),
		skill: u.skill,
		stageNumber: run.state.lastAllocatedStageNumber,
		ts: nowIso(),
		runId: run.runId,
	});
}
