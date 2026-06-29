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
 * (onStageEnd / onStageError / onRoute / onUnitEnd). Listeners
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

import type { CapPolicy, Unit, UnitRole } from "./api.js";
import { formatError, globalSlot } from "./internal-utils.js";
import { MSG_LIFECYCLE_THREW } from "./messages.js";
import type { Output, RunView } from "./output.js";
import type { RunTrigger } from "./triggers.js";
import type { RunWorkflowResult } from "./types.js";

/**
 * Run-scoped context shared by every lifecycle callback. Mirrors the
 * shape `EdgeContext` and `FanoutContext` already use (frozen identity
 * + the deep-readonly `RunView`) so listeners reconstruct "where am I" without
 * widening the per-event payload.
 */
export interface LifecycleContext {
	cwd: string;
	runId: string;
	workflow: string;
	totalStages: number;
	/** What triggered this run; defaulted at `runWorkflow` entry if `options.trigger` was omitted. */
	trigger: RunTrigger;
	state: RunView;
	/**
	 * Distinct stage names already executed in this run — the engine's
	 * authoritative `RunContext.visited`, RECONSTRUCTED from the JSONL trail on a
	 * resume. Populated only on the run-level projection (`lifecycleCtxFor`, which
	 * backs `onWorkflowStart`/`onWorkflowEnd`, script-stage `onStageStart`, and the
	 * loop/route fires); UNDEFINED on session-fired events (`lifecycleCtxFromSession`
	 * carries `runIdentity` only, never the live visited set).
	 *
	 * Exists so a status-line bridge can SEED its own distinct-visited accumulator
	 * at `onWorkflowStart`: a resumed run kicks the chain at its reconstructed walk
	 * position (a deep `stageNumber`), but only re-fires per-stage events from that
	 * point forward — without this, the bridge would recount `visited` from zero and
	 * a near-done resume would render a misleadingly tiny `visited/totalStages`.
	 */
	visited?: readonly string[];
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
 * Payload for `onLoopStart`. `units` is present only when the loop
 * precomputes its unit list (fanout) — pull loops (iterate/assess) discover
 * units one at a time, so listeners observe them via `onUnitStart`.
 * `kind: "verify"` is a verify-bearing stage (a desugared attempt→verify
 * loop) — verified stages follow loop semantics: observe units, not
 * `onStageEnd`.
 */
export interface LoopStartInfo {
	kind: "fanout" | "iterate" | "assess" | "verify";
	units?: readonly Unit[];
}

/**
 * Per-unit event payload. `skill` is the unit's DISPATCHED skill body — the
 * parent stage's skill for produce units, the judge's own skill (or the
 * synthetic `<parent>-judge` label for prompt judges) for judge units — so a
 * model-override listener can resolve a per-unit model through the existing
 * `models.json` cascade (`skills.<name>`) without new configuration axes.
 */
export interface UnitEvent {
	role: UnitRole;
	/** 0-based generation cursor (== the round index for assess loops). */
	index: number;
	/** Stable audit identity (`unit.id ?? unit.label`); undefined for assess units. */
	unitId?: string;
	/** Display tag (`"phase 2/5"`, `"r0·judge"`). */
	label: string;
	/** Dispatched skill body. */
	skill: string;
}

/** Payload for `onLoopCap` — fired when a loop's effective cap trips. */
export interface LoopCapInfo {
	kind: LoopStartInfo["kind"];
	/** Units run (fanout/iterate) or rounds run (assess) when the cap tripped. */
	count: number;
	/** The effective cap: `min(loop.max, run.maxIterations)`. */
	max: number;
	policy: CapPolicy;
}

/**
 * Opt-in lifecycle listeners. Single subscriber per slot per bundle —
 * fan-out is a userland wrapper. Every callback may return a Promise;
 * the runner awaits it before advancing (back-pressure for free).
 *
 * Every event fires AFTER its corresponding JSONL row lands on disk
 * (onStageEnd / onStageError / onRoute / onUnitEnd), so a
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
 *   onLoopStart:     (stage, info)         => console.log(`  ⇉ ${stage.name} [${info.kind}]`),
 *   onUnitStart:     (stage, u)            => console.log(`     → ${u.label} (${u.role})`),
 *   onUnitEnd:       (stage, u)            => console.log(`     · ${stage.name} #${u.index}`),
 *   onUnitHalt:      (stage, u, reason)    => console.warn(`     ✗ ${stage.name} #${u.index}: ${reason}`),
 *   onLoopCap:       (stage, c)            => console.warn(`  ⚠ ${stage.name} capped at ${c.max}`),
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

	/**
	 * After an `EdgeFn` picks and its routing-decision row lands. `to` may be the
	 * `STOP` sentinel literal `"stop"`. `bypassed` lists the decision edge's
	 * not-taken RECOVERY arms — failure loops the chosen arm skipped for good (see
	 * `bypassedRecoveryArms` in routing.ts). A progress listener credits them so
	 * the bar reaches full while the terminal stage runs; empty for deterministic
	 * (string) edges and gates with no loop-back alternative.
	 */
	onRoute?(from: StageRef, to: string, ctx: LifecycleContext, bypassed?: readonly string[]): void | Promise<void>;

	/** After `onStageStart`, before unit 1's session (after the unit list is computed for fanout). */
	onLoopStart?(stage: StageRef, info: LoopStartInfo, ctx: LifecycleContext): void | Promise<void>;

	/**
	 * Per unit, BEFORE the unit's session opens — fired uniformly for produce
	 * AND judge units (closing the judge pre-session gap). This is the seam a
	 * model-override listener flips `pi.setModel` on; units run strictly
	 * sequentially, so the global flip is race-free.
	 */
	onUnitStart?(stage: StageRef, unit: UnitEvent, ctx: LifecycleContext): void | Promise<void>;

	/** Per unit, after the unit's JSONL row lands. Loop units never fire `onStageEnd`. */
	onUnitEnd?(stage: StageRef, unit: UnitEvent, output: Output, ctx: LifecycleContext): void | Promise<void>;

	/**
	 * Per unit, after a collect-all fanout unit's NON-TERMINAL `collected:true`
	 * failed row lands — the unit halted but the run survives (the synthesis fold
	 * skips its sentinel slot). Fired ONLY on the soft-halt path; a fail-fast unit
	 * fires `onStageError` (terminal) instead, and a successful unit fires
	 * `onUnitEnd`. Distinct from both so a lane surface can flip the unit's sub-row
	 * ✗ rather than leaving it to spin (then be swept ✓ at `onWorkflowEnd`).
	 * `reason` is the halt cause — the same text the `collected:true` row's
	 * `errMsg` carries.
	 */
	onUnitHalt?(stage: StageRef, unit: UnitEvent, reason: string, ctx: LifecycleContext): void | Promise<void>;

	/** After an `onCap: "advance"` trip — fired after the `{type:"loop-cap"}` telemetry row append attempt. */
	onLoopCap?(stage: StageRef, info: LoopCapInfo, ctx: LifecycleContext): void | Promise<void>;

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
				host.ui.notify(MSG_LIFECYCLE_THREW(event, formatError(e)), "warning");
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

const getRegistry = globalSlot(REGISTRY_KEY, () => [] as LifecycleListeners[]);

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
	state: RunView;
	visited?: readonly string[];
}): LifecycleContext {
	return args;
}

/**
 * Build a `LifecycleContext` from the current `RunContext` (typed
 * structurally so this base-layer module never imports the runtime types).
 * Captured per fire so listeners always see the latest `state` snapshot.
 * THE one RunContext → LifecycleContext projection — the runner, the loop
 * driver, and the resume entries all share it; no per-module clones to keep
 * aligned by convention.
 */
export function lifecycleCtxFor(run: {
	cwd: string;
	runId: string;
	workflow: { name: string };
	totalStages: number;
	trigger: RunTrigger;
	state: RunView;
	visited: ReadonlySet<string>;
}): LifecycleContext {
	return buildLifecycleContext({
		cwd: run.cwd,
		runId: run.runId,
		workflow: run.workflow.name,
		totalStages: run.totalStages,
		trigger: run.trigger,
		state: run.state,
		// Snapshot the live set — listeners must not mutate the engine's accumulator,
		// and a fired ctx is captured per fire so a later `visited.add` is irrelevant.
		visited: [...run.visited],
	});
}

/**
 * Build a `LifecycleContext` from any SessionContext/AuditCtx-shaped object
 * (cwd + runId + the frozen `runIdentity` + live state). The session, audit,
 * and extraction layers all fire through this projection instead of
 * re-spelling the six-field literal.
 */
export function lifecycleCtxFromSession(s: {
	cwd: string;
	runId: string;
	runIdentity: { workflow: string; totalStages: number; trigger: RunTrigger };
	state: RunView;
}): LifecycleContext {
	return buildLifecycleContext({
		cwd: s.cwd,
		runId: s.runId,
		workflow: s.runIdentity.workflow,
		totalStages: s.runIdentity.totalStages,
		trigger: s.runIdentity.trigger,
		state: s.state,
	});
}

/** Build the `"skill"` arm of `StageRef`. */
export function skillStageRef(name: string, stageNumber: number, skill: string): StageRef {
	return { kind: "skill", name, stageNumber, skill };
}

/** Build the `"script"` arm of `StageRef` — skillless TS stages. */
export function scriptStageRef(name: string, stageNumber: number): StageRef {
	return { kind: "script", name, stageNumber };
}
