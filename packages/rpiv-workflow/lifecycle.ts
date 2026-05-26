/**
 * Lifecycle callbacks — typed observation surface for in-flight runs.
 *
 * Two subscription paths converge through the same `LifecycleListeners`
 * shape:
 *
 *   - **Per-call** — embedders set `RunWorkflowOptions.lifecycle?` (Phase A.3)
 *     when driving `runWorkflow` directly.
 *   - **Global** — sibling extensions (rpiv-pi widget, future metrics)
 *     call `registerLifecycle(listeners)` (Phase A.4) at extension load.
 *     Returns a disposer; multiple registrations fan out per event.
 *
 * Every event fires AFTER the corresponding JSONL row lands on disk
 * (onStageEnd / onStageError / onRoute / onFanoutUnitEnd). Listeners
 * thus see consistent state when they read past rows via
 * `readLastStage` / `readAllStages`.
 *
 * Listener throws are caught + logged via `ctx.ui.notify(..., "warning")`
 * and never halt the run — listeners are observers, not gates. Other
 * registered listeners still fire normally.
 *
 * Pre-flight rejections (`workflow.start` not declared, continue-policy
 * without a host) fire ZERO lifecycle events — the run never acquired
 * a `runId` and lifecycle events would deliver an incomplete context.
 * The `RunWorkflowResult` envelope still surfaces the error to the
 * caller through the existing path.
 */

import type { FanoutUnit } from "./api.js";
import { MSG_LIFECYCLE_THREW } from "./messages.js";
import type { Output } from "./output.js";
import type { RunWorkflowResult } from "./runner/runner.js";
import type { RunTrigger } from "./triggers.js";
import type { RunState } from "./types.js";

/**
 * Run-scoped context shared by every lifecycle callback. Mirrors the
 * shape `EdgeContext` and `FanoutContext` already use (frozen identity
 * + `Readonly<RunState>`) so listeners reconstruct "where am I" without
 * widening the per-event payload.
 */
export interface LifecycleContext {
	cwd: string;
	runId: string;
	workflow: string;
	totalStages: number;
	/** What triggered this run; defaulted at `runWorkflow` entry if `options.trigger` was omitted. */
	trigger: RunTrigger;
	state: Readonly<RunState>;
}

/**
 * Projection of a stage as observed by a listener — the runner's
 * internal resolved view minus its `def` field (which leaks DSL
 * internals). Distinct from `StageDef` (authored shape) and
 * `WorkflowStage` (JSONL row).
 *
 * Discriminated on `kind`:
 *   - `"skill"`  — stage dispatches a Pi skill body (`/skill:<skill>`).
 *   - `"script"` — stage runs a TS function (Phase B); no skill body.
 *
 * Phase A.3 only ever constructs the `"skill"` branch; Phase B.4
 * activates the `"script"` branch.
 */
export type StageRef =
	| { kind: "skill"; name: string; stageNumber: number; skill: string }
	| { kind: "script"; name: string; stageNumber: number };

/**
 * Opt-in lifecycle listeners. Single subscriber per slot per bundle —
 * fan-out is a userland wrapper. Every callback may return a Promise;
 * the runner awaits it before advancing (back-pressure for free).
 *
 * Listener throws are caught + surfaced via `ctx.ui.notify` but never
 * halt the run.
 */
export interface LifecycleListeners {
	/** After JSONL header lands; before the start stage's preflight. */
	onWorkflowStart?(ctx: LifecycleContext): void | Promise<void>;

	/** After preflight + skill check; before the Pi session opens (or `run()` is called for script stages). */
	onStageStart?(stage: StageRef, ctx: LifecycleContext): void | Promise<void>;

	/** After the stage's success row lands in JSONL. `output` is the validated envelope. */
	onStageEnd?(stage: StageRef, output: Output, ctx: LifecycleContext): void | Promise<void>;

	/** After `outputSchema` rejection, before the runner re-prompts. `attempt` is 1-based. */
	onStageRetry?(stage: StageRef, attempt: number, ctx: LifecycleContext): void | Promise<void>;

	/** After the stage's "failed"/"aborted" row lands in JSONL. Terminal for the run. */
	onStageError?(stage: StageRef, error: string, ctx: LifecycleContext): void | Promise<void>;

	/** After an `EdgeFn` picks and its routing-decision row lands. `to` may be the `STOP` sentinel literal `"stop"`. */
	onRoute?(from: StageRef, to: string, ctx: LifecycleContext): void | Promise<void>;

	/** After the `FanoutFn` returns ≥1 units; before unit 1's session opens. */
	onFanoutStart?(stage: StageRef, units: readonly FanoutUnit[], ctx: LifecycleContext): void | Promise<void>;

	/** Per-unit, before the unit's session opens. `unitIndex` is 1-based. */
	onFanoutUnitStart?(
		stage: StageRef,
		unit: FanoutUnit,
		unitIndex: number,
		ctx: LifecycleContext,
	): void | Promise<void>;

	/** Per-unit, after the unit's JSONL row lands. */
	onFanoutUnitEnd?(stage: StageRef, unit: FanoutUnit, unitIndex: number, ctx: LifecycleContext): void | Promise<void>;

	/** Last call — `result` is the same envelope `runWorkflow` returns. */
	onWorkflowEnd?(result: RunWorkflowResult, ctx: LifecycleContext): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal — dispatcher (consumed by the runner; not exported publicly)
// ---------------------------------------------------------------------------

/** Subset of `WorkflowContext` the dispatcher needs for throw-safe logging. */
export interface DispatchHost {
	ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
}

/**
 * Fan-out + throw-safe invoker for one event across every registered
 * listener bundle. Constructed once per `runWorkflow` call and threaded
 * through `RunContext` so every firing site uses the same instance.
 *
 * Snapshot semantics: `collectBundles` is called per `fire(...)`, so a
 * registration made mid-event (Phase A.4 — `registerLifecycle` from
 * inside a callback) applies to subsequent events but not the in-flight
 * one.
 *
 * Sequential await: bundles run in registration order; the per-call
 * bundle (when present) fires after every globally-registered bundle.
 * `await` between them gives listeners back-pressure for free.
 */
export class LifecycleDispatcher {
	constructor(private readonly perCall: LifecycleListeners | undefined) {}

	async fire<E extends keyof LifecycleListeners>(
		host: DispatchHost,
		event: E,
		...args: Parameters<NonNullable<LifecycleListeners[E]>>
	): Promise<void> {
		for (const bundle of collectBundles(this.perCall)) {
			const fn = bundle[event];
			if (!fn) continue;
			try {
				await (fn as (...a: unknown[]) => unknown)(...(args as unknown[]));
			} catch (e) {
				const reason = e instanceof Error ? e.message : String(e);
				host.ui.notify(MSG_LIFECYCLE_THREW(event, reason), "warning");
			}
		}
	}
}

/** Phase A.4 extends this to prepend the global registry. */
function collectBundles(perCall: LifecycleListeners | undefined): readonly LifecycleListeners[] {
	return perCall ? [perCall] : [];
}

/** Build a `LifecycleContext` from the runner's per-run identity. */
export function buildLifecycleContext(args: {
	cwd: string;
	runId: string;
	workflow: string;
	totalStages: number;
	trigger: RunTrigger;
	state: Readonly<RunState>;
}): LifecycleContext {
	return args;
}

/** Build the `"skill"` arm of `StageRef`. Phase B.4 adds a `script` builder. */
export function skillStageRef(name: string, stageNumber: number, skill: string): StageRef {
	return { kind: "skill", name, stageNumber, skill };
}
