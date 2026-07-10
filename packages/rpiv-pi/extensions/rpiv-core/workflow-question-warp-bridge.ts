/**
 * workflow-question-warp-bridge — surfaces a parked workflow question in Warp's
 * badge by bridging the question-lifecycle stream into rpiv-warp's OSC 777
 * transport.
 *
 * A workflow run parks a question via `ask_user_question`; the lifecycle stream
 * (packages/rpiv-pi/extensions/rpiv-core/question-lifecycle.ts) emits `asked`/
 * `resolved` per `(runId, unitIndex)`. This bridge aggregates those into the
 * per-run badge transitions Warp already understands:
 *
 *   - 0→≥1 outstanding (first parked unit): emit `session_start` (defensive)
 *     then `question_asked` — Warp shows the Blocked badge for this runId.
 *   - ≥1→≥1 (a second unit parks while one is already outstanding): no-op — the
 *     badge stays Blocked. (Holds under the ≤1-parked-question-per-unitIndex
 *     invariant: r2; the presence-keyed Set is only exact under it.)
 *   - ≥1→0 (last outstanding unit resolved, answered OR cleared): emit
 *     `tool_complete` — Warp clears the badge. `reason` is intentionally unused
 *     (both `answered` and `cleared` drop the unitIndex).
 *
 * session_id is the workflow runId (Warp's logical session for a run's parked
 * question), NOT the launcher session — so concurrent runs each get their own
 * badge keyed by their own session_id (r1: state machine correct by construction;
 * multi-run display unverified without a live Warp).
 *
 * Clean-install contract: the bridge dynamically `import("@juicesharp/rpiv-warp")`
 * (guarded by `isModuleNotFound`) so a clean install — where the opt-in rpiv-warp
 * sibling is absent — registers, subscribes, and is a silent no-op. Lifecycle
 * listeners still fire; only the OSC emission is absent.
 *
 * Root-gated + idempotent: registered only on the ROOT launcher's session_start
 * (`ctx.hasUI && !isLaneRelayUiContext`, mirroring registerLaneProgressHook) so a
 * re-loading child never double-subscribes; a process-global guard slot holds the
 * disposer so a re-fired session_start (`/reload`) never stacks a duplicate
 * listener. `__resetWorkflowQuestionWarpBridge` is wired into test/setup.ts
 * beforeEach (next to `laneProgress.__resetLaneProgress()`).
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isLaneRelayUiContext } from "./lane-relay-ui.js";
import { type QuestionLifecycleEvent, subscribeQuestionLifecycle } from "./question-lifecycle.js";
import { isModuleNotFound } from "./utils.js";

/**
 * Process-global guard holding the active lifecycle unsubscribe fn + a ref to the
 * outstanding tracker (so the reset can clear it without holding a separate
 * closure). Anchored on a `globalThis[Symbol.for(...)]` slot (NOT a module-local
 * `let`) for the same reason lane-progress is: a `/reload` or a detached child
 * may re-evaluate this module, and a module-local guard would let a second
 * registration stack onto question-lifecycle's process-global listener Set. One slot → at
 * most one subscription, ever.
 */
const GUARD_SLOT = Symbol.for("@juicesharp/rpiv-pi:workflowQuestionWarpBridgeGuard");

interface BridgeGuard {
	dispose: (() => void) | undefined;
	/** Clears the outstanding tracker; stored on the guard so __reset can reach it
	 *  without re-reading module-local state a /reload may have re-bound. */
	clearOutstanding: (() => void) | undefined;
}

function guard(): BridgeGuard {
	const g = globalThis as Record<symbol, unknown>;
	let s = g[GUARD_SLOT] as BridgeGuard | undefined;
	if (s === undefined) {
		s = { dispose: undefined, clearOutstanding: undefined };
		g[GUARD_SLOT] = s;
	}
	return s;
}

/**
 * Wire the lifecycle→Warp bridge to the ROOT launcher's session_start. Skipped
 * for a detached foreground child (branded relay ui) and any non-UI session —
 * the same gate registerLaneProgressHook uses. Captures the launcher cwd so the
 * emitted payloads carry the project the user is actually running from.
 */
export function registerWorkflowQuestionWarpBridgeHook(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event: unknown, ctx: { hasUI?: boolean; ui?: ExtensionUIContext; cwd?: string }) => {
		if (!ctx.hasUI || isLaneRelayUiContext(ctx.ui)) return; // root launcher only
		const cwd = ctx.cwd;
		if (cwd === undefined) return; // nothing to attribute the project to — skip
		await registerWorkflowQuestionWarpBridge(cwd).catch((err) =>
			console.error("[rpiv-core] failed to register workflow question warp bridge:", err),
		);
	});
}

/**
 * Subscribe to the question-lifecycle stream ONCE and drive the per-run badge
 * transitions through rpiv-warp's transport. Idempotent via the process-global
 * guard; degrades silently when the rpiv-warp sibling is absent (it is an opt-in
 * package — the bridge is a clean-install-safe no-op without it; lifecycle
 * listeners still fire).
 */
export async function registerWorkflowQuestionWarpBridge(cwd: string): Promise<void> {
	const g = guard();
	if (g.dispose) return; // already registered — never stack a duplicate listener
	// Claim the guard with a no-op sentinel BEFORE suspending on the import: the
	// guard read above and the real disposer assignment below are separated by an
	// await, and a session_start re-fired inside that window would pass the stale
	// check and stack a second lifecycle listener. Any import failure releases the
	// claim so a later session_start can retry (rpiv-warp installed mid-session,
	// transient load error) instead of bricking the bridge for the process.
	g.dispose = () => {};
	let transport: { asked(runId: string): void; resolved(runId: string): void };
	try {
		const mod = await import("@juicesharp/rpiv-warp");
		transport = mod.createWorkflowQuestionTransport(cwd);
	} catch (err) {
		g.dispose = undefined; // release the claim — the next session_start may retry
		if (isModuleNotFound(err)) return; // sibling absent — clean-install no-op
		throw err;
	}

	// Outstanding parked unitIndices per run. Presence-keyed (NOT count-keyed):
	// a `resolved` event of EITHER reason drops the unitIndex, and the badge
	// transition is driven by the run's set going empty. Exact under the
	// ≤1-parked-question-per-unitIndex invariant (r2). A `cleared` event for a
	// unit that was never parked is a harmless no-op (Set.delete on a missing key).
	const outstanding = new Map<string, Set<number>>();
	g.clearOutstanding = () => outstanding.clear();

	g.dispose = subscribeQuestionLifecycle((event: QuestionLifecycleEvent) => {
		if (event.kind === "asked") {
			const set = outstanding.get(event.runId);
			if (set === undefined) {
				// 0→≥1: first outstanding unit for this run — show the badge.
				outstanding.set(event.runId, new Set([event.unitIndex]));
				transport.asked(event.runId);
			} else {
				// ≥1→≥1: a second unit parks while the run is already Blocked — no-op.
				set.add(event.unitIndex);
			}
			return;
		}
		// resolved (answered | cleared) — reason-agnostic: drop the unitIndex.
		const set = outstanding.get(event.runId);
		if (set === undefined) return; // nothing outstanding for this run — defensive no-op
		set.delete(event.unitIndex);
		if (set.size === 0) {
			// ≥1→0: last outstanding unit cleared — clear the badge.
			outstanding.delete(event.runId);
			transport.resolved(event.runId);
		}
	});
}

/**
 * Test reset — wired into test/setup.ts beforeEach (next to
 * `laneProgress.__resetLaneProgress()`). Disposes the active listener
 * (question-lifecycle's `__resetQuestionLifecycle` also clears the listener Set,
 * independently), clears the outstanding
 * tracker, and resets the guard so the next test's registration proceeds.
 */
export function __resetWorkflowQuestionWarpBridge(): void {
	const g = guard();
	g.dispose?.();
	g.dispose = undefined;
	g.clearOutstanding?.();
	g.clearOutstanding = undefined;
}
