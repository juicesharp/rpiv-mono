/**
 * loop-parallel.ts — bounded-parallel, dependency-GATED fanout dispatch. Every active
 * unit is dispatched into ONE generation-wide semaphore and awaits ITS OWN `Unit.deps`
 * — not a topological level — so a dependent opens the instant its deps have filled
 * their slots, even while unrelated siblings are still running. Kahn levels
 * (`computeWaveLevels`, loop-waves.ts) remain the CYCLE GUARD and supply the dispatch
 * ORDER (level asc, index asc); they are no longer a barrier. A deps-free fanout is a
 * flat dispatch, and a cap-1 fanout (`implement`) dispatches in exactly declared order.
 *
 * Deps are awaited BEFORE the semaphore is acquired — a waiting dependent never holds a
 * slot, so hold-and-wait (and with it deadlock) cannot arise; the DAG is acyclic by the
 * guard above.
 *
 * CONCURRENCY MODEL — why a per-unit fold is safe. Each unit folds itself through
 * `foldFanoutCompletion` in its own continuation, so the cursor is now advanced from
 * many continuations rather than one serial post-`allSettled` pass. That is safe for the
 * same reason `run.state` already was: every mutator is a synchronous, `await`-free
 * read-modify-write (JS run-to-completion makes each atomic), AND the fold is
 * COMMUTATIVE by construction — `slots[i]` is index-addressed, `filledCount` is
 * recomputed by `reduce` over the whole array (never incremented), and `lastProduce` is
 * derived by `lastNonFailedSlot` scanning slots high→low. Declared order therefore
 * survives completion order without a barrier. The one genuinely order-sensitive write,
 * `state.primaryArtifact`, is last-writer-wins during dispatch either way (each worker's
 * `postStage` already races it) and is overwritten by `projectResult` at close. The
 * durable trail is likewise completion-ordered already, and resume places by
 * `row.unitIndex`, never by trail order.
 *
 * `runFanoutGeneration` is the ONE orchestrator both the live entry (`runFanoutParallel`)
 * and the resume re-dispatch (`runFanoutResume`) — both thin wrappers in loop.ts —
 * degenerate to: each passes its `active` operand set (live: `0..dispatchCount-1`;
 * resume: the still-pending indices) and a `finalTail` for the path-specific completion
 * (live: hitCap-vs-finishLoop on the cap; resume: always finishLoop). It owns ONE
 * per-generation `genAbort` (so a fail-fast halt or run-abort cancels in-flight siblings
 * AND rejects every queued acquire), computes the order, and runs the generation.
 *
 * This module is a downward leaf: it consumes the shared loop foundation
 * (`loop-kinds.ts`, `loop-waves.ts`) and never imports loop.ts back (loop.ts → here only).
 */

import { decorateStage } from "./audit.js";
import { lifecycleCtxFor, skillStageRef } from "./events.js";
import { handleToString } from "./handle.js";
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
import { computeWaveLevels, unitIdIndex } from "./loop-waves.js";
import { failedOutput, isFailedOutput, type Output, type OutputMeta, outputMeta } from "./output.js";
import { Semaphore } from "./semaphore.js";
import type { RunContext, UnitRef, WorkflowHostContext } from "./types.js";

/** Structured identity for fanout unit `i` — carried on a worker-throw failure
 *  row (`recordWorkerThrow`) so the unit's identity lands in the row's structured
 *  `unit*` fields instead of being folded into the `stage` name string. */
const fanoutUnitRef = (e: LoopEntry, i: number): UnitRef => {
	const u = fanoutUnitAt(e, i);
	return { parent: e.name, role: u.role, index: i, id: u.id, label: u.label };
};

/**
 * THE generation orchestrator — owns ONE per-generation `AbortController` and ONE
 * semaphore across every active unit. Computes the Kahn levels over the full unit list
 * (the cycle guard) and flattens them into the dispatch ORDER, intersected with `active`
 * (live: the first-cap indices; resume: the still-pending indices). Runs `finalTail`
 * (live: hitCap-vs-finishLoop; resume: finishLoop) once the generation settles.
 *
 * The `genAbort` fires on EITHER (a) run-level abort (Ctrl-C, `run.signal` — propagated
 * below) OR (b) the first fail-fast unit halt inside `dispatchGeneration`. The listener
 * is dropped BEFORE `finalTail` (which runs the downstream chain) so it never accumulates
 * across stages. Levels are computed BEFORE the listener is wired, so a defensive
 * cycle-throw from `computeWaveLevels` can't leak it.
 */
export async function runFanoutGeneration(
	hostCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	run: RunContext,
	deps: LoopDeps,
	active: readonly number[],
	finalTail: () => Promise<void> | void,
): Promise<void> {
	const activeSet = new Set(active);
	// Levels earn their keep twice over, and neither use is a barrier: `computeWaveLevels`
	// THROWS `invariantPreflight` on a dependency cycle (the defensive guard), and its
	// flattening is the dispatch order — level asc, index asc, i.e. the order the wave
	// scheduler used, so a cap-1 fanout stays byte-identical.
	const order = computeWaveLevels(e.units!, e.name)
		.flat()
		.filter((i) => activeSet.has(i));
	// The dep→index map is resolved unconditionally now: dep GATING needs it whether or
	// not `depArtifactFlag` is set. `depArtifactSuffix` keeps its own flag guard.
	const idToIndex = unitIdIndex(e.units!);
	// No active units (e.g. a resume with everything already filled) — still close the
	// loop via the tail (projection + advance), matching today's empty/all-done path.
	if (order.length === 0) return finalTail();

	const genAbort = new AbortController();
	// Name the handler so it can be REMOVED once this generation settles — run.signal
	// lives for the WHOLE run, so an anonymous listener would accumulate across stages.
	const onRunAbort = () => genAbort.abort();
	if (run.signal) {
		if (run.signal.aborted) genAbort.abort();
		else run.signal.addEventListener("abort", onRunAbort, { once: true });
	}
	const detach = () => run.signal?.removeEventListener("abort", onRunAbort);

	await dispatchGeneration(hostCtx, e, cursor, run, deps, order, genAbort, idToIndex);
	detach(); // generation settled — drop the run-lifetime listener BEFORE the tail

	// The same two gates the wave loop ran between levels, now once at the end: a
	// fail-fast halt already terminated state inside the worker and aborted its
	// siblings; a run abort drained the semaphore and rejected every later acquire.
	if (run.state.termination.status !== "running") return;
	if (run.signal?.aborted) return deps.recordAborted(hostCtx, e.name, run); // mid-flight abort → FAIL_WORKFLOW_ABORTED
	return finalTail();
}

/**
 * Dispatch the whole generation through a shared semaphore + the per-generation
 * `genAbort`, each unit gated on ITS OWN deps and folding itself at its DECLARED index.
 * NEVER throws — an unexpected worker rejection lands a terminal-failure row via
 * `recordWorkerThrow`; allSettled guarantees every unit settled.
 */
async function dispatchGeneration(
	hostCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	run: RunContext,
	deps: LoopDeps,
	ops: readonly number[],
	genAbort: AbortController,
	idToIndex: Map<string, number>,
): Promise<void> {
	const failFast = isFailFast(e.loop);
	// A fanout may cap its own concurrency BELOW the host cap (`implement`'s
	// `concurrency: 1`); floored at 1, never raised above the host cap.
	const loopCap = e.loop.kind === "fanout" ? e.loop.concurrency : undefined;
	const sem = new Semaphore(
		Math.max(1, Math.min(loopCap ?? hostCtx.maxConcurrency, hostCtx.maxConcurrency)),
		genAbort.signal,
	); // drains queued units on either abort

	// One readiness latch per DISPATCHED unit, index-addressed. A dep with no latch is
	// already settled: either it is outside `ops` (a resume whose prior invocation filled
	// the slot) or it is dangling (`computeWaveLevels` treats those as satisfied too —
	// `ensureUnitDeps` owns the dangling report).
	const latch = new Array<Promise<void> | undefined>(e.units!.length);
	const open = new Array<(() => void) | undefined>(e.units!.length);
	for (const i of ops)
		latch[i] = new Promise<void>((resolve) => {
			open[i] = resolve;
		});
	const depLatches = (i: number): Promise<void>[] =>
		(e.units![i]!.deps ?? []).flatMap((d) => {
			const di = idToIndex.get(d);
			const l = di === undefined ? undefined : latch[di];
			return l ? [l] : [];
		});

	await Promise.allSettled(
		ops.map(async (i) => {
			// Await THIS unit's deps — never a whole level — and do it BEFORE acquiring a
			// slot, so a waiting dependent never holds one.
			await Promise.all(depLatches(i));
			try {
				// Resolve `--upstream`-style dep-artifact injection from the slots this
				// unit's deps just filled. Empty when the loop sets no flag or no deps.
				const suffix = depArtifactSuffix(e, cursor, i, idToIndex);
				const out = await sem.run(() => dispatchUnitDetached(hostCtx, e, i, run, deps, genAbort.signal, suffix));
				// ONE synchronous block, and its order is load-bearing. (1) A fail-fast
				// unit's worker terminated state via recordFatalFailure — fire genAbort
				// so in-flight siblings get session.abort()'d NOW and no dependent released
				// below can still slip into the semaphore. (2) Fold BEFORE the latch opens:
				// a dependent's `depArtifactSuffix` reads `cursor.slots`, so an early
				// release would make it design blind for this dep.
				if (failFast && run.state.termination.status !== "running") genAbort.abort();
				cursor.ranThisInvocation++;
				// index-addressed placement (shared with the resume fold) so declared order
				// survives parallel completion + dep gating + resume.
				foldFanoutCompletion(run.state, cursor, e.def, e.name, i, e.units!.length, out);
			} catch (reason) {
				// aborted / never-started → unfilled slot (resume re-dispatches)
				if (!isAbortError(reason)) await deps.recordWorkerThrow(hostCtx, fanoutUnitRef(e, i), e.skill, run, reason);
			} finally {
				// Dependents proceed even when this unit failed — `depArtifactSuffix` skips
				// a failed/unfilled slot, so they design blind for it rather than stalling.
				open[i]?.();
			}
		}),
	);
}

/**
 * Resolve the `depArtifactFlag` injection for unit `index`: ` <flag> <path>` per direct
 * dep whose slot is filled with a NON-FAILED output. A failed/sentinel or still-unfilled
 * dep slot is SKIPPED (the dependent designs blind for that dep) — so a failed upstream
 * degrades gracefully instead of injecting a broken path; synthesize stays the backstop.
 * Dangling ids never reach here (`ensureUnitDeps` rejected them at the live entry); the
 * `undefined` guard is defensive.
 */
function depArtifactSuffix(e: LoopEntry, cursor: LoopCursor, index: number, idToIndex: Map<string, number>): string {
	const flag = e.loop.kind === "fanout" ? e.loop.depArtifactFlag : undefined;
	const deps = e.units![index]!.deps;
	if (!flag || !deps?.length) return "";
	let suffix = "";
	for (const depId of deps) {
		const di = idToIndex.get(depId);
		if (di === undefined) continue; // dangling (defensive — validated away at the entry)
		const out = cursor.slots?.[di];
		if (!out || isFailedOutput(out)) continue; // unfilled or failed → skip (blind for this dep)
		const handle = out.artifacts[0]?.handle;
		if (handle) suffix += ` ${flag} ${handleToString(handle)}`;
	}
	return suffix;
}

/** Dispatch one fanout unit in its own child and RETURN its output. The cursor is NOT
 *  touched here — the wave fold consumes the return value in index order. `promptSuffix`
 *  (the resolved dep-artifact injection) is appended to the unit prompt by `fanoutUnitAt`.
 *  A halted unit leaves `captured` unset; returns failedOutput. (Settle shapes unchanged
 *  from the pre-wave dispatcher: collect-all unit failure → sentinel; fail-fast halt →
 *  placement sentinel + graceful return; ABORT → throws WorkflowAbortError → unfilled slot.) */
async function dispatchUnitDetached(
	hostCtx: WorkflowHostContext,
	e: LoopEntry,
	index: number,
	run: RunContext,
	deps: LoopDeps,
	signal: AbortSignal | undefined, // genAbort.signal — run-level abort OR fail-fast sibling cancel
	promptSuffix = "",
): Promise<Output> {
	if (signal?.aborted) throw new WorkflowAbortError(); // never open a child after abort; isAbortError → unfilled slot
	const u = fanoutUnitAt(e, index, promptSuffix);
	await run.lifecycle.fire(
		hostCtx,
		"onUnitStart",
		skillStageRef(e.name, e.stageIdx + 1, u.skill),
		{ role: u.role, index, unitId: u.id, label: u.label, skill: u.skill },
		lifecycleCtxFor(run),
	);
	const snapshot = await deps.captureSnapshot(hostCtx, e.name, u.def, e.stageIdx, run);
	let captured: Output | undefined;
	await deps.executeStageSession(
		hostCtx,
		buildUnitSession(e, u, index, run, snapshot, signal, (_child, output) => {
			captured = output;
			return Promise.resolve();
		}),
	);
	return captured ?? failedOutput(unitOutputMeta(e, u, run), `${u.label}: unit halted`);
}

/** Minimal OutputMeta for a fail-fast placement sentinel. The run is terminating when
 *  this is used, so the sentinel is never read downstream; it only keeps the fold's
 *  Output type intact without a throw. */
function unitOutputMeta(e: LoopEntry, u: Extract<NextStep, { kind: "unit" }>, run: RunContext): OutputMeta {
	return outputMeta({
		stage: decorateStage(e.name, u.tag),
		skill: u.skill,
		stageNumber: run.state.lastAllocatedStageNumber,
		ts: nowIso(),
		runId: run.runId,
	});
}
