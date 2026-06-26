/**
 * lane-progress — bridges rpiv-workflow's lifecycle bus into the run-lane
 * registry so the ambient overlay shows LIVE stage progress (Phase 8).
 *
 * The base plan deferred "rich progress" on the premise it needed a new
 * runner→host→registry report path. That path already exists: rpiv-workflow
 * publicly exports `registerLifecycle`, whose docstring literally describes "a
 * rpiv-pi widget" marking stage progress by runId. So this bridge is a cheap,
 * clean-install-safe increment — no host plumbing.
 *
 * Each lifecycle event maps to `setLaneProgress(ctx.runId, …)`:
 *   - onStageStart → { stageNumber, totalStages, stageName, phase: "running" }
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
	getLane,
	markUnitDone,
	noteVisitedStage,
	retireRun,
	setLaneProgress,
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
 * Runs whose CURRENT loop generation is a fan-out (D8 gate). `onUnitStart`/`onUnitEnd`
 * fire for EVERY loop kind, but only concurrent fan-out units become individually-
 * addressable sub-rows — a sequential iterate/assess unit stays on the lane's single
 * slot (the host keys it to the sentinel). Seeded on a fan-out `onLoopStart`, dropped on
 * a non-fan-out `onLoopStart` and on the terminal events; cleared wholesale by
 * `__resetLaneProgress`. Module-local (the bridge runs only at the root launcher).
 */
const fanoutRuns = new Set<string>();

/**
 * Wire the lifecycle→registry bridge to the ROOT launcher's session_start.
 * Skipped for a detached foreground child (branded relay ui) and any non-UI
 * session — the same gate the execution-host provider hook uses (Phase 7.2).
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
	try {
		// Thin `/startup` entry (re-exports registerLifecycle) — keeps the
		// loader/DSL/runner graph off startup and avoids the barrel-import race.
		const { registerLifecycle } = await import("@juicesharp/rpiv-workflow/startup");
		g.dispose = registerLifecycle({
			// `noteVisitedStage` is idempotent per stage name, so calling it from every
			// per-stage event keeps `visited` (the distinct-nodes-visited fraction
			// numerator) correct without inflating on a loop-back — see LaneProgress.
			onStageStart: (stage, ctx) =>
				setLaneProgress(ctx.runId, {
					stageNumber: stage.stageNumber,
					totalStages: ctx.totalStages,
					visited: noteVisitedStage(ctx.runId, stage.name),
					stageName: stage.name,
					phase: "running",
				}),
			onStageRetry: (stage, attempt, ctx) =>
				setLaneProgress(ctx.runId, {
					stageNumber: stage.stageNumber,
					totalStages: ctx.totalStages,
					visited: noteVisitedStage(ctx.runId, stage.name),
					stageName: stage.name,
					phase: "retry",
					attempt,
				}),
			// Carry the stage's failure cause (Problem 1) so the dock row can surface WHY
			// it failed before the run retires — no longer discarded.
			onStageError: (stage, error, ctx) => {
				// Orphan sweep (the asymmetric onUnitStart…onUnitEnd bracket): a fail-fast
				// halt fired onUnitStart for the halting unit (+ in-flight siblings) with no
				// onUnitEnd — flip every still-running sub-row to ✗ so none spins forever.
				sweepRunningUnits(ctx.runId, "failed");
				fanoutRuns.delete(ctx.runId);
				setLaneProgress(ctx.runId, {
					stageNumber: stage.stageNumber,
					totalStages: ctx.totalStages,
					visited: noteVisitedStage(ctx.runId, stage.name),
					stageName: stage.name,
					phase: "error",
					reason: error,
				});
			},
			onLoopStart: (stage, info, ctx) => {
				// A new fan-out generation REPLACES the prior one's sub-rows (D2) — the engine
				// resets cursor.slots per loop, so the registry mirrors only the current
				// generation. A non-fan-out loop (iterate/assess/verify) drops the gate so its
				// sequential units never materialize sub-rows (D8).
				if (info.kind === "fanout") {
					clearUnitLanes(ctx.runId);
					fanoutRuns.add(ctx.runId);
				} else {
					fanoutRuns.delete(ctx.runId);
				}
				setLaneProgress(ctx.runId, {
					stageNumber: stage.stageNumber,
					totalStages: ctx.totalStages,
					visited: noteVisitedStage(ctx.runId, stage.name),
					stageName: stage.name,
					phase: "running",
					// Fanout precomputes its unit list; pull loops (iterate/assess) discover
					// units one at a time, so seed total only when the list is known.
					units: info.units ? { done: 0, total: info.units.length } : undefined,
				});
			},
			// NEW — the previously-missing half of the bracket. Materialize a per-unit
			// sub-row (label + running) for fan-out units ONLY (D8). The host publishes the
			// live session separately (setCurrentSession at this index); both upsert the
			// same key in either order. The lifecycle bus is the sole cross-package channel.
			onUnitStart: (_stage, unit, ctx) => {
				if (fanoutRuns.has(ctx.runId)) setUnitStarted(ctx.runId, unit.index, unit.label);
			},
			onUnitEnd: (stage, unit, _output, ctx) => {
				// Flip THIS unit's sub-row terminal (fan-out only). The row stays viewable via
				// its snapshot/disk transcript.
				if (fanoutRuns.has(ctx.runId)) markUnitDone(ctx.runId, unit.index, "done");
				// Advance units.done by a TRUE completion count. onUnitEnd fires in
				// COMPLETION order (units finish out of declared order under
				// maxConcurrency > 1), so keying off `unit.index + 1` jumps and
				// regresses (e.g. 3/3 → 1/3 → 2/3). setLaneProgress replaces progress
				// wholesale, so read the prior count back and increment; the `?? 0`
				// baseline matches the onLoopStart seed and the `?? unit.index + 1`
				// total fallback matches the pre-existing pull-loop (unseeded) path.
				const prev = getLane(ctx.runId)?.progress?.units;
				const total = prev?.total ?? unit.index + 1;
				const done = (prev?.done ?? 0) + 1;
				setLaneProgress(ctx.runId, {
					stageNumber: stage.stageNumber,
					totalStages: ctx.totalStages,
					visited: noteVisitedStage(ctx.runId, stage.name),
					stageName: stage.name,
					phase: "running",
					units: { done, total },
				});
			},
			// Phase A — the run terminated: RETAIN the lane with its terminal status (so
			// it stays visible + its transcript stays viewable) and PUSH a completion
			// toast to the launcher (the only signal the user gets if they walked away).
			// This is the single writer of a terminal LaneStatus.
			onWorkflowEnd: (result, ctx) => {
				const status = result.termination?.status;
				if (!status || status === "running") return; // still in-flight — nothing to retire
				const lane = getLane(ctx.runId);
				const name = lane?.name ?? ctx.workflow;
				// `termination.error` is the readable cause (the same text as the trail's
				// errMsg) — retain it on the lane (Problem 1) for the dock chip + viewer header.
				const error = result.termination?.error;
				// A completed run is 100% by definition. The bar's fraction is
				// distinct-stages-visited / reachable-stages, and a successful path skips
				// branch-exclusive stages (carve's `reslice`/`refine` only fire on a gate
				// loop-back), so `visited` caps BELOW `totalStages` — the last live snapshot
				// would otherwise freeze at e.g. 13/14 under the ✓. Paint the bar full on
				// clean completion only; `failed`/`aborted` keep their last real snapshot so
				// the row stays frozen at the stage that died.
				const prog = lane?.progress;
				if (status === "completed" && prog && prog.visited !== prog.totalStages) {
					setLaneProgress(ctx.runId, { ...prog, visited: prog.totalStages });
				}
				// Sweep any unit that never fired onUnitEnd (abort/throw) to the run's terminal
				// kind BEFORE retiring, so a failed run's stuck sub-rows read ✗ (retireRun's
				// running→done fallback then no-ops on them). Drop the gate — the run is over.
				sweepRunningUnits(ctx.runId, status === "completed" ? "done" : "failed");
				fanoutRuns.delete(ctx.runId);
				retireRun(ctx.runId, status, error);
				const ui = getCapturedUiContext();
				if (!ui) return;
				if (status === "completed") ui.notify(`✓ ${name} finished — /lanes to view`, "info");
				else if (status === "failed") {
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
}
