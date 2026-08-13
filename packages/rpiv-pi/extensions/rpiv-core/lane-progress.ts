/**
 * lane-progress — bridges rpiv-workflow's lifecycle bus into the run-lane
 * registry so the ambient overlay shows LIVE stage progress.
 *
 * The base plan deferred "rich progress" on the premise it needed a new
 * runner→host→registry report path. That path already exists: rpiv-workflow
 * publicly exports `registerLifecycle`, whose docstring literally describes "a
 * rpiv-pi widget" marking stage progress by runId. So this bridge is a cheap,
 * clean-install-safe increment — no host plumbing.
 *
 * Each lifecycle event maps to `setLaneProgress(ctx.runId, …)`:
 *   - onStageStart → clear the prior stage's fan-out unit sub-rows (every stage kind; it fires
 *                    before onLoopStart on a loop stage) + { stageName, phase: "running" }
 *   - onStageRetry → phase "retry" + attempt           ("⟲ … retry 2/3")
 *   - onStageError → phase "error"                      (brief — the run then evicts)
 *   - onLoopStart  → seed units.total (fanout precomputes its unit list); on a
 *                    fanout generation also clear the prior generation's unit sub-rows.
 *   - onUnitStart  → materialize a per-unit sub-row (fanout only) via setUnitStarted.
 *   - onUnitEnd    → flip the unit sub-row terminal + advance units.done by a TRUE
 *                    completion count ("units x/y"). The aggregate `done` advances on
 *                    completion, so it stays monotone under out-of-order fanout.
 * `setLaneProgress` no-ops on a non-recorded run, so non-detached runs cost nothing.
 *
 * Clean-install contract: a static top-level VALUE import of the rpiv-workflow
 * barrel crashes the extension when the sibling is absent. So the listener is
 * registered via a DYNAMIC `import("@juicesharp/rpiv-workflow/startup")` (the thin
 * `/startup` entry that also backs the execution-host provider) guarded by
 * `isModuleNotFound`.
 *
 * Root-gated + idempotent: registered only on the ROOT launcher's session_start
 * (`ctx.hasUI && !isLaneRelayUiContext`, mirroring the provider hook) so a
 * re-loading child never double-subscribes; a process-global guard slot holds the
 * disposer so a re-fired session_start (`/reload`) or a child re-load never stacks
 * a duplicate listener. `__resetLaneProgress` is wired into test/setup.ts beforeEach.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { shortFailureReason } from "./lane-failure.js";
import { isLaneRelayUiContext } from "./lane-relay-ui.js";
import {
	clearUnitLanes,
	foldStageUsage,
	getLane,
	markUnitDone,
	retireRun,
	seedPendingUnits,
	setLaneProgress,
	setRecap,
	setUnitStarted,
	sweepRunningUnits,
} from "./run-lane-registry.js";
import { getCapturedUiContext } from "./session-capture.js";
import { isModuleNotFound } from "./utils.js";

/**
 * Process-global guard holding the active `registerLifecycle` disposer. Anchored
 * on a `globalThis[Symbol.for(...)]` slot (NOT a module-local `let`) for the same
 * reason the registry is: a `/reload` or a detached child may re-evaluate this
 * module, and a module-local guard would let a second registration stack onto the
 * process-global lifecycle registry. One slot → at most one listener, ever.
 */
const GUARD_SLOT = Symbol.for("@juicesharp/rpiv-pi:laneProgressGuard");

interface ProgressGuard {
	dispose: (() => void) | undefined;
}

function guard(): ProgressGuard {
	const g = globalThis as Record<symbol, unknown>;
	let s = g[GUARD_SLOT] as ProgressGuard | undefined;
	if (s === undefined) {
		s = { dispose: undefined };
		g[GUARD_SLOT] = s;
	}
	return s;
}

/**
 * Runs whose CURRENT loop generation is a fan-out. `onUnitStart`/`onUnitEnd`
 * fire for EVERY loop kind, but only concurrent fan-out units become individually-
 * addressable sub-rows — a sequential iterate/assess unit stays on the lane's single
 * slot (the host keys it to the sentinel). Seeded on a fan-out `onLoopStart`, dropped on
 * a non-fan-out `onLoopStart` and on the terminal events; cleared wholesale by
 * `__resetLaneProgress`. Module-local (the bridge runs only at the root launcher).
 */
const fanoutRuns = new Set<string>();

/**
 * runId → the current run instance's `ctx.state`. A resume reuses the runId but
 * starts a fresh `ctx.state`, so object identity distinguishes the predecessor
 * from its resumed successor — the basis of the `onWorkflowEnd` instance guard
 * below. Seeded on `onWorkflowStart`, deleted on the terminal-proceed path,
 * cleared wholesale by `__resetLaneProgress`. Module-local (the bridge runs only
 * at the root launcher).
 *
 * Residual (microtask-scale, accepted): a predecessor end landing between the
 * successor's `recordRun` and its `onWorkflowStart` seed-overwrite still slips
 * through.
 */
const activeInstances = new Map<string, object>();

/**
 * Wire the lifecycle→registry bridge to the ROOT launcher's session_start.
 * Skipped for a detached foreground child (branded relay ui) and any non-UI
 * session — the same gate the execution-host provider hook uses.
 */
export function registerLaneProgressHook(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event: unknown, ctx: { hasUI?: boolean; ui?: ExtensionUIContext }) => {
		if (!ctx.hasUI || isLaneRelayUiContext(ctx.ui)) return; // root launcher only
		await registerLaneProgress().catch((err) =>
			console.error("[rpiv-core] failed to register lane progress bridge:", err),
		);
	});
}

/**
 * Register the lifecycle listener ONCE. Idempotent via the process-global guard;
 * degrades silently when the sibling is absent (the missing-sibling banner +
 * /rpiv-setup guide the user).
 */
export async function registerLaneProgress(): Promise<void> {
	const g = guard();
	if (g.dispose) return; // already registered — never stack a duplicate listener
	// Claim the guard with a no-op sentinel BEFORE suspending on the import: the
	// guard read above and the real disposer assignment below are separated by an
	// await, and a session_start re-fired inside that window would pass the stale
	// check and stack a second lifecycle listener (mirrors
	// workflow-question-warp-bridge). Any failure releases the claim so a later
	// session_start can retry instead of bricking the bridge for the process.
	g.dispose = () => {};
	try {
		// Thin `/startup` entry (re-exports registerLifecycle) — keeps the
		// loader/DSL/runner graph off startup and avoids the barrel-import race.
		const { registerLifecycle, summarizeRun } = await import("@juicesharp/rpiv-workflow/startup");
		g.dispose = registerLifecycle({
			// Seed run-INSTANCE identity keyed by runId. A resume REUSES the runId, so a
			// runId-only gate is racy — but `reconstructState` hands the resumed successor a
			// FRESH ctx.state object, so the onWorkflowEnd instance guard compares identities to
			// drop a stale predecessor's late end (it must not re-retire/re-cap the resumed lane).
			onWorkflowStart: (ctx) => {
				activeInstances.set(ctx.runId, ctx.state);
			},
			// onStageStart fires for EVERY stage kind — a plain sequential stage (the single-stage
			// entry announcement, run-stage.ts:221) AND every loop stage, where it fires BEFORE
			// onLoopStart (announceLoopStart, loop.ts:75→78). So retiring the prior stage's fan-out
			// unit sub-rows HERE closes the c1 gap (fanout → plain sequential stage: the sequential
			// stage has no onLoopStart to clear them) and the c2 gap (fanout → non-fanout loop: the
			// loop's onLoopStart only drops the gate, it never cleared the prior generation).
			// clearUnitLanes is a no-op on an empty map, so the first stage of a run pays nothing.
			onStageStart: (stage, ctx) => {
				foldStageUsage(ctx.runId);
				clearUnitLanes(ctx.runId);
				setLaneProgress(ctx.runId, { stageName: stage.name, phase: "running" });
			},
			onStageRetry: (stage, attempt, ctx) =>
				setLaneProgress(ctx.runId, { stageName: stage.name, phase: "retry", attempt }),
			// Carry the stage's failure cause so the dock row can surface WHY
			// it failed before the run retires — no longer discarded.
			onStageError: (stage, error, ctx) => {
				// Orphan sweep (the asymmetric onUnitStart…onUnitEnd bracket): a fail-fast
				// halt fired onUnitStart for the halting unit (+ in-flight siblings) with no
				// onUnitEnd — flip every still-running sub-row to ✗ so none spins forever.
				sweepRunningUnits(ctx.runId, "failed");
				fanoutRuns.delete(ctx.runId);
				setLaneProgress(ctx.runId, { stageName: stage.name, phase: "error", reason: error });
			},
			onLoopStart: (stage, info, ctx) => {
				// A new fan-out generation REPLACES the prior one's sub-rows — the engine
				// resets cursor.slots per loop, so the registry mirrors only the current
				// generation. A non-fan-out loop (iterate/assess/verify) drops the gate so its
				// sequential units never materialize sub-rows.
				if (info.kind === "fanout") {
					foldStageUsage(ctx.runId);
					clearUnitLanes(ctx.runId);
					fanoutRuns.add(ctx.runId);
					// Fan out the generation's unit sub-rows as PENDING the instant onLoopStart
					// fires — BEFORE any onUnitStart. Fanout precomputes its unit list; pull loops
					// (iterate/assess/verify) carry none, so they seed nothing (the guard mirrors
					// the `units: info.units ?` seed below). The key is the declared array position,
					// which matches onUnitStart's unit.index (loop-parallel.ts:222-224).
					if (info.units)
						seedPendingUnits(
							ctx.runId,
							info.units.map((u, i) => ({ index: i, label: u.label })),
						);
				} else {
					fanoutRuns.delete(ctx.runId);
				}
				setLaneProgress(ctx.runId, {
					stageName: stage.name,
					phase: "running",
					// Fanout precomputes its unit list; pull loops (iterate/assess) discover
					// units one at a time, so seed total only when the list is known.
					units: info.units ? { done: 0, total: info.units.length } : undefined,
				});
			},
			// NEW — the previously-missing half of the bracket. Materialize a per-unit
			// sub-row (label + running) for fan-out units ONLY. The host publishes the
			// live session separately (setCurrentSession at this index); both upsert the
			// same key in either order. The lifecycle bus is the sole cross-package channel.
			onUnitStart: (_stage, unit, ctx) => {
				if (fanoutRuns.has(ctx.runId)) setUnitStarted(ctx.runId, unit.index, unit.label);
			},
			// A collect-all fanout unit soft-halted: NON-terminal (the run survives, the synthesis
			// fold skips its sentinel), so it fires neither onStageError (recordUnitHalt skips it)
			// nor onUnitEnd (the success path). Flip its sub-row ✗ HERE — otherwise it spins until
			// onWorkflowEnd, where a completed run's sweep paints it ✓ (a failed unit shown as
			// success). Fan-out only; a missing/unchanged sub-row is a no-op.
			onUnitHalt: (_stage, unit, _reason, ctx) => {
				if (fanoutRuns.has(ctx.runId)) markUnitDone(ctx.runId, unit.index, "failed");
			},
			onUnitEnd: (stage, unit, _output, ctx) => {
				// Flip THIS unit's sub-row terminal (fan-out only). The row stays viewable via
				// its snapshot/disk transcript.
				const isFanout = fanoutRuns.has(ctx.runId);
				if (isFanout) markUnitDone(ctx.runId, unit.index, "done");
				// Advance units.done by a TRUE completion count — FANOUT ONLY. onUnitEnd fires
				// in COMPLETION order (units finish out of declared order under
				// maxConcurrency > 1), so keying off `unit.index + 1` jumps and regresses
				// (e.g. 3/3 → 1/3 → 2/3); setLaneProgress replaces progress wholesale, so
				// read the prior count back and increment (`?? 0` matches the onLoopStart seed).
				// Pull loops (iterate/assess/verify) carry NO precomputed total — `onLoopStart`
				// seeds `units: undefined` for them, so `units` stays undefined here and the
				// dock omits the `· units x/y` segment (fanout-only sub-progress). The
				// `prev?.total ?? unit.index + 1` seed is thus unreachable on the pull-loop
				// path: a pull loop never has a seeded `prev.total`, so the inverted
				// "1/1 → 2/1 → 3/1" (total frozen at unit.index+1 while done climbed) is gone.
				let units: { done: number; total: number } | undefined;
				if (isFanout) {
					const prev = getLane(ctx.runId)?.progress?.units;
					units = { done: (prev?.done ?? 0) + 1, total: prev?.total ?? unit.index + 1 };
				}
				setLaneProgress(ctx.runId, { stageName: stage.name, phase: "running", units });
			},
			// The run terminated: RETAIN the lane with its terminal status (so
			// it stays visible + its transcript stays viewable) and PUSH a completion
			// toast to the launcher (the only signal the user gets if they walked away).
			// This is the single writer of a terminal LaneStatus.
			onWorkflowEnd: (result, ctx) => {
				const status = result.termination?.status;
				if (!status || status === "running") return; // still in-flight — nothing to retire
				// Run-instance guard: drop a superseded predecessor's late terminal event so it can't
				// re-stamp the resumed lane with the predecessor's outcome + recap (a resume reactivates
				// the lane to "running", re-arming retireRun's first-retire-wins gate). Fail-open when no
				// instance was recorded — see `activeInstances` for the identity basis + residual window.
				const recorded = activeInstances.get(ctx.runId);
				if (recorded !== undefined && recorded !== ctx.state) return; // stale predecessor end
				activeInstances.delete(ctx.runId); // keep the map bounded to in-flight runs
				const lane = getLane(ctx.runId);
				const name = lane?.name ?? ctx.workflow;
				// `termination.error` is the readable cause (the same text as the trail's
				// errMsg) — retain it on the lane for the dock chip + viewer header.
				const error = result.termination?.error;
				// `lastArtifact` is the primary artifact's canonical path (a `produces`
				// stage emitted one) — retained on the lane so a completed row can render
				// `→ <bucket>/<file>.md`. Undefined for side-effect-only runs.
				const lastArtifact = result.lastArtifact;
				// Sweep any unit that never fired onUnitEnd (abort/throw) to the run's terminal
				// kind BEFORE retiring, so a failed run's stuck sub-rows read ✗ (retireRun's
				// running→done fallback then no-ops on them). Drop the gate — the run is over.
				sweepRunningUnits(ctx.runId, status === "completed" ? "done" : "failed");
				fanoutRuns.delete(ctx.runId);
				// End-of-run summary off the on-disk JSONL trail (the post-mortem recap). Computed
				// for EVERY terminal outcome (completed/failed/cancelled/aborted), not only failures,
				// and BEFORE retirement so the lane is still live while the trail is read. The recap
				// does NOT gate retirement: a run whose recap resolved to undefined still retires.
				const recap = summarizeRun(ctx.cwd, ctx.runId);
				retireRun(ctx.runId, status, error, lastArtifact);
				// Land the recap on the (possibly already-terminal) lane. See `setRecap` for why it's
				// ungated by status. Fail-soft: an undefined recap stores nothing.
				if (recap !== undefined) setRecap(ctx.runId, recap);
				const ui = getCapturedUiContext();
				if (!ui) return;
				if (status === "completed") {
					// A "completed" termination whose recap reads "stopped" is a
					// gate-routed stop (a stop-on-fail preset's red gate): the run
					// halted before its chain's natural end, so a ✓ success toast
					// would misreport it. Surface the recap's reason instead.
					if (recap?.outcome === "stopped")
						ui.notify(`⚠ ${name} ${recap.failureReason ?? "stopped at a gate"} — /lanes to view`, "warning");
					else ui.notify(`✓ ${name} finished — /lanes to view`, "info");
				} else if (status === "failed") {
					// Inject the short reason into the toast so the user learns WHY without
					// opening the lane; falls back to the bare line when no cause is known.
					const short = shortFailureReason(error);
					ui.notify(
						short ? `⚠ ${name} failed: ${short} — /lanes to view` : `⚠ ${name} failed — /lanes to view`,
						"error",
					);
				} else ui.notify(`⊘ ${name} ${status}`, "warning"); // aborted / cancelled
			},
		});
	} catch (err) {
		g.dispose = undefined; // release the claim — the next session_start may retry
		if (isModuleNotFound(err)) return; // sibling absent — /rpiv-setup guides the user
		throw err;
	}
}

/**
 * Test reset — wired into test/setup.ts beforeEach. Disposes the active listener
 * (defensive; test/setup also clears rpiv-workflow's lifecycle registry) and clears
 * the guard so the next test's registration proceeds.
 */
export function __resetLaneProgress(): void {
	const g = guard();
	g.dispose?.();
	g.dispose = undefined;
	fanoutRuns.clear();
	activeInstances.clear();
}
