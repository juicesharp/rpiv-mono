/**
 * Lifecycle callbacks — typed observation surface for in-flight runs.
 *
 * Two subscription paths converge through the same `LifecycleListeners`
 * shape:
 *
 *   - **Per-call** — embedders set `RunWorkflowOptions.lifecycle?` when
 *     driving `runWorkflow` directly.
 *   - **Global** — sibling extensions (rpiv-pi widget, future metrics)
 *     call `registerLifecycle(listeners)` at extension load. Returns a
 *     disposer; multiple registrations fan out per event.
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
 *   - `"script"` — stage runs a TS function; no skill body.
 */
export type StageRef =
	| { kind: "skill"; name: string; stageNumber: number; skill: string }
	| { kind: "script"; name: string; stageNumber: number };

/**
 * Opt-in lifecycle listeners. Single subscriber per slot per bundle —
 * fan-out is a userland wrapper. Every callback may return a Promise;
 * the runner awaits it before advancing (back-pressure for free).
 *
 * Every event fires AFTER its corresponding JSONL row lands on disk
 * (onStageEnd / onStageError / onRoute / onFanoutUnitEnd), so a
 * listener that calls `readLastStage(cwd, ctx.runId)` from inside the
 * callback is guaranteed to observe the just-recorded row.
 *
 * Listener throws are caught + surfaced via `ctx.ui.notify(..., "warning")`
 * and never halt the run — listeners are observers, not gates.
 *
 * @example Per-call observation from an embedder
 * ```ts
 * import { runWorkflow, type LifecycleListeners } from "@juicesharp/rpiv-workflow";
 *
 * const listeners: LifecycleListeners = {
 *   onWorkflowStart: (ctx) =>
 *     console.log(`▶ ${ctx.workflow} (${ctx.totalStages} stages) [${ctx.trigger.kind}]`),
 *   onStageStart:    (stage)               => console.log(`  → ${stage.stageNumber}. ${stage.name}`),
 *   onStageEnd:      (stage, output)       => console.log(`  ✓ ${stage.name}: ${output.kind}`),
 *   onStageRetry:    (stage, attempt)      => console.warn(`  ⟲ ${stage.name} retry #${attempt}`),
 *   onStageError:    (stage, error)        => console.error(`  ✗ ${stage.name}: ${error}`),
 *   onRoute:         (from, to)            => console.log(`  ↪ ${from.name} → ${to}`),
 *   onFanoutStart:   (stage, units)        => console.log(`  ⇉ ${stage.name} × ${units.length}`),
 *   onFanoutUnitEnd: (stage, _u, i)        => console.log(`     · ${stage.name} #${i}`),
 *   onWorkflowEnd:   (result)              =>
 *     console.log(result.success ? "✓ done" : `✗ ${result.error ?? "halted"}`),
 * };
 *
 * await runWorkflow({ workflow, input, host, lifecycle: listeners });
 * ```
 *
 * @example Cross-package fan-out via `registerLifecycle`
 * ```ts
 * import { registerLifecycle } from "@juicesharp/rpiv-workflow";
 *
 * const dispose = registerLifecycle({
 *   onWorkflowStart: (ctx) => widget.open(ctx.runId, ctx.workflow),
 *   onStageEnd:      (stage, _o, ctx) => widget.markDone(ctx.runId, stage.name),
 * });
 * ```
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

/** Subset of `WorkflowHostContext` the dispatcher needs for throw-safe logging. */
export interface DispatchHost {
	ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
}

/**
 * Fan-out + throw-safe invoker for one event across every registered
 * listener bundle. Constructed once per `runWorkflow` call and threaded
 * through `RunContext` so every firing site uses the same instance.
 *
 * Snapshot semantics: `collectBundles` is called per `fire(...)`, so a
 * registration made mid-event (`registerLifecycle` from inside a
 * callback) applies to subsequent events but not the in-flight one.
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

// ---------------------------------------------------------------------------
// Global registry — cross-package fan-out
// ---------------------------------------------------------------------------

/**
 * Anchored on a `Symbol.for` slot so a duplicate module load (extension +
 * sibling cross-package resolution) shares one registry. Same pattern
 * `registerBuiltIns` uses for the workflow registry.
 */
const REGISTRY_KEY = Symbol.for("@juicesharp/rpiv-workflow:lifecycle");

type Global = Record<symbol, unknown>;

function getRegistry(): LifecycleListeners[] {
	const g = globalThis as unknown as Global;
	let registry = g[REGISTRY_KEY] as LifecycleListeners[] | undefined;
	if (!registry) {
		registry = [];
		g[REGISTRY_KEY] = registry;
	}
	return registry;
}

/**
 * Register a cross-package lifecycle-listener bundle. Returns a disposer
 * that removes it. Multiple registrations coexist — every fired event walks
 * the full registry in registration order, then the per-call bundle.
 *
 * Snapshot semantics: each `fire(...)` call observes the registry as it
 * stands at that instant. A registration made mid-event applies to
 * subsequent events but not the in-flight one.
 *
 * Throws from listeners are caught + logged via `ctx.ui.notify(..., "warning")`
 * and never halt the run. One listener bug never affects other listeners
 * or the run itself.
 */
export function registerLifecycle(listeners: LifecycleListeners): () => void {
	const registry = getRegistry();
	registry.push(listeners);
	return () => {
		const idx = registry.indexOf(listeners);
		if (idx >= 0) registry.splice(idx, 1);
	};
}

/**
 * Test reset — wired into the repo-wide test setup so cross-test
 * registration leaks don't bias the next case.
 */
export function __resetLifecycleRegistry(): void {
	getRegistry().length = 0;
}

/**
 * Globally-registered bundles fire first (in registration order), then
 * the per-call bundle. Snapshot at fire time — a registration made
 * inside a listener body applies to subsequent events, not the
 * in-flight one.
 */
function collectBundles(perCall: LifecycleListeners | undefined): readonly LifecycleListeners[] {
	const global = getRegistry();
	return perCall ? [...global, perCall] : [...global];
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

/** Build the `"skill"` arm of `StageRef`. */
export function skillStageRef(name: string, stageNumber: number, skill: string): StageRef {
	return { kind: "skill", name, stageNumber, skill };
}

/** Build the `"script"` arm of `StageRef` — skillless TS stages. */
export function scriptStageRef(name: string, stageNumber: number): StageRef {
	return { kind: "script", name, stageNumber };
}
