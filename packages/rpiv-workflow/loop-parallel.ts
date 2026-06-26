/**
 * loop-parallel.ts — bounded-parallel, dependency-ordered fanout dispatch. Fanout
 * units fold into the cursor in DECLARED (index) order through `foldFanoutCompletion`
 * — never completion order — so `fanin` synthesis + resume stay deterministic at every
 * concurrency (Semaphore(1) just serializes). When units declare `Unit.deps`, the
 * scheduler dispatches in Kahn TOPOLOGICAL LEVELS (`computeWaveLevels`, loop-waves.ts):
 * one bounded-parallel wave per level, a dependent never opening before the units it
 * depends on have filled their slots. A deps-free fanout has ONE level — byte-identical
 * to the pre-wave flat dispatch.
 *
 * CONCURRENCY MODEL — what is and isn't fold-confined. ONLY the `LoopCursor`
 * (`slots`/`filledCount`/`lastProduce`) is mutated exclusively by the serial
 * post-`allSettled` fold below. `run.state` is NOT: each worker's `postStage` mutates
 * `lastAllocatedStageNumber`, `stagesCompleted`, `output`, `primaryArtifact`
 * CONCURRENTLY across siblings. That is safe — every such mutator is a synchronous,
 * `await`-free read-modify-write (JS run-to-completion makes each atomic), and every
 * order-sensitive result is re-derived by the index-addressed fold or overwritten by
 * `projectResult` at close.
 *
 * `runFanoutWaves` is the ONE orchestrator both the live entry (`runFanoutParallel`)
 * and the resume re-dispatch (`runFanoutResume`) — both thin wrappers in loop.ts —
 * degenerate to: each passes its `active` operand set (live: `0..dispatchCount-1`;
 * resume: the still-pending indices) and a `finalTail` for the path-specific completion
 * (live: hitCap-vs-finishLoop on the cap; resume: always finishLoop). It owns ONE
 * per-generation `genAbort` across every wave (so a fail-fast halt or run-abort in wave
 * k cancels in-flight siblings AND prevents wave k+1), computes the levels, intersects
 * each with `active`, and runs `dispatchWave` per non-empty level.
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
 * THE wave orchestrator — owns ONE per-generation `AbortController` across every
 * topological level. Computes Kahn levels over the full unit list, intersects each
 * with `active` (live: the first-cap indices; resume: the still-pending indices), and
 * dispatches the non-empty levels in order. The LAST active level runs `finalTail`
 * (live: hitCap-vs-finishLoop; resume: finishLoop); intermediate levels just settle.
 *
 * The `genAbort` fires on EITHER (a) run-level abort (Ctrl-C, `run.signal` — propagated
 * below) OR (b) the first fail-fast unit halt inside `dispatchWave`. The listener is
 * dropped BEFORE `finalTail` (which runs the downstream chain) so it never accumulates
 * across stages. Levels are computed BEFORE the listener is wired, so a defensive
 * cycle-throw from `computeWaveLevels` can't leak it.
 */
export async function runFanoutWaves(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	run: RunContext,
	deps: LoopDeps,
	active: readonly number[],
	finalTail: () => Promise<void> | void,
): Promise<void> {
	const activeSet = new Set(active);
	const waves = computeWaveLevels(e.units!, e.name)
		.map((level) => level.filter((i) => activeSet.has(i)))
		.filter((level) => level.length > 0);
	// Resolve the dep→artifact identity map once (only when the flag is set).
	const idToIndex = e.loop.kind === "fanout" && e.loop.depArtifactFlag ? unitIdIndex(e.units!) : undefined;
	// No active units (e.g. a resume with everything already filled) — still close the
	// loop via the tail (projection + advance), matching today's empty/all-done path.
	if (waves.length === 0) return finalTail();

	const genAbort = new AbortController();
	// Name the handler so it can be REMOVED once this generation settles — run.signal
	// lives for the WHOLE run, so an anonymous listener would accumulate across stages.
	const onRunAbort = () => genAbort.abort();
	if (run.signal) {
		if (run.signal.aborted) genAbort.abort();
		else run.signal.addEventListener("abort", onRunAbort, { once: true });
	}
	const detach = () => run.signal?.removeEventListener("abort", onRunAbort);

	for (let w = 0; w < waves.length; w++) {
		await dispatchWave(curCtx, e, cursor, run, deps, waves[w]!, genAbort, idToIndex);
		// Cross-wave gates — the same two checks the single-dispatch tail made, now
		// BETWEEN waves so a wave-k failure prevents wave-(k+1) dispatch. A fail-fast
		// halt already terminated state inside the worker; a run abort drained the
		// semaphore and rejects every later acquire.
		if (run.state.termination.status !== "running") {
			detach();
			return;
		}
		if (run.signal?.aborted) {
			detach();
			return deps.recordAborted(curCtx, e.name, run); // mid-flight abort → FAIL_WORKFLOW_ABORTED
		}
	}
	detach(); // all waves settled cleanly — drop the run-lifetime listener BEFORE the tail
	return finalTail();
}

/**
 * Dispatch ONE topological level's operands through a shared semaphore + the
 * per-generation `genAbort`, folding each result at its DECLARED index. The body the
 * former single-shot `runFanoutDispatch` ran, MINUS the genAbort lifecycle (the
 * orchestrator owns it across waves) and the terminal disposition (the orchestrator
 * runs the tail once, after the last wave). NEVER throws — an unexpected worker
 * rejection lands a terminal-failure row via `recordWorkerThrow` (D12); allSettled
 * guarantees every unit settled.
 */
async function dispatchWave(
	curCtx: WorkflowHostContext,
	e: LoopEntry,
	cursor: LoopCursor,
	run: RunContext,
	deps: LoopDeps,
	ops: readonly number[],
	genAbort: AbortController,
	idToIndex: Map<string, number> | undefined,
): Promise<void> {
	const failFast = isFailFast(e.loop);
	// A fanout may cap its own concurrency BELOW the host cap (`implement`'s
	// `concurrency: 1`); floored at 1, never raised above the host cap.
	const loopCap = e.loop.kind === "fanout" ? e.loop.concurrency : undefined;
	const sem = new Semaphore(
		Math.max(1, Math.min(loopCap ?? curCtx.maxConcurrency, curCtx.maxConcurrency)),
		genAbort.signal,
	); // drains queued units on either abort
	const settled = await Promise.allSettled(
		ops.map((i) => {
			// Resolve `--upstream`-style dep-artifact injection from the slots prior waves
			// already filled. Empty when the loop sets no flag or the unit has no deps.
			const suffix = idToIndex ? depArtifactSuffix(e, cursor, i, idToIndex) : "";
			return sem
				.run(() => dispatchUnitDetached(curCtx, e, i, run, deps, genAbort.signal, suffix))
				.then((out) => {
					// a fail-fast unit's worker terminated state via recordTerminalFailure;
					// fire genAbort so in-flight siblings get session.abort()'d NOW.
					if (failFast && run.state.termination.status !== "running") genAbort.abort();
					return out;
				});
		}),
	);
	// `ops[k]` maps the k-th settled result back to its DECLARED unit index.
	for (let k = 0; k < settled.length; k++) {
		const r = settled[k]!;
		const i = ops[k]!;
		if (r.status === "rejected") {
			if (isAbortError(r.reason)) continue; // aborted / never-started → unfilled slot (resume re-dispatches)
			await deps.recordWorkerThrow(curCtx, fanoutUnitRef(e, i), e.skill, run, r.reason);
			continue;
		}
		cursor.ranThisInvocation++;
		// index-addressed placement (shared with the resume fold) so declared order
		// survives parallel completion + waves + resume.
		foldFanoutCompletion(run.state, cursor, e.def, e.name, i, e.units!.length, r.value);
	}
}

/**
 * Resolve the `depArtifactFlag` injection for unit `index`: ` <flag> <path>` per direct
 * dep whose slot is filled with a NON-FAILED output. A failed/sentinel or still-unfilled
 * dep slot is SKIPPED (the dependent designs blind for that dep) — so a failed upstream
 * degrades gracefully instead of injecting a broken path; synthesize stays the backstop.
 * Dangling ids never reach here (`validateUnitDeps` rejected them at the live entry); the
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
	curCtx: WorkflowHostContext,
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
