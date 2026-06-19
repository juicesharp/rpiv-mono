/**
 * workflow-execution-host — wires rpiv-pi's SDK-backed detached executor into
 * rpiv-workflow's execution-host seam.
 *
 * `registerWorkflowExecutionHostProvider` registers a provider with the sibling's
 * `/startup` seam. Per `/wf` run, `createWorkflowExecution` builds a
 * `SdkWorkflowHost` from the live observer ctx (closing over the
 * `session_start`-captured `modelRegistry` + `uiContext`) and wires the ESC/Ctrl-C
 * abort tap: the ONLY working interrupt trigger during orchestration is
 * `ctx.ui.onTerminalInput` (ahead of the editor) — `ctx.signal` is dead while no
 * agent run is active. The tap fires a per-run `AbortController` whose
 * `signal` the runner threads onto `RunContext.signal`, interrupting in-flight
 * children; `dispose` unsubscribes the keystroke tap in the runner's `finally`.
 *
 * The provider replaces the retired workflow-path model lifecycle latch:
 * per-child models are now resolved through `resolveModel` and applied at child
 * session creation by `SdkWorkflowHost` — no global `pi.setModel()` flip.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ModelSelection, WorkflowHostContext } from "@juicesharp/rpiv-workflow";
import { isLaneRelayUiContext } from "./lane-relay-ui.js";
import { loadModelsConfig, resolveStageModel } from "./models-config.js";
import { getFocusedRun, getLane, recordRun, retireRun, setLaneAbort } from "./run-lane-registry.js";
import { SdkWorkflowHost } from "./sdk-workflow-host.js";
import { getCapturedModelRegistry, getCapturedUiContext } from "./session-capture.js";
import { isModuleNotFound } from "./utils.js";

/** Build the detached executor + abort tap from the live observer ctx + run identity. */
type WorkflowExecution = {
	host: WorkflowHostContext;
	signal?: AbortSignal;
	dispose?: () => void;
};

/**
 * Background-lane concurrency cap. Rate limits, not CPU, are the real cap.
 * 4 is the default; a later step can make it config-driven
 * via the models/workflow config. Declared once, here, at the registration site.
 */
export const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Map the config layer's `ResolvedModelConfig` ({ model?, thinking? }) to the
 * Pi-agnostic domain `ModelSelection` ({ model?, thinking? }). Identity-shaped
 * today, but the explicit boundary keeps rpiv-workflow free of the config type.
 */
export function toModelSelection(
	r: { model?: string; thinking?: ModelSelection["thinking"] } | undefined,
): ModelSelection | undefined {
	if (!r || (r.model === undefined && r.thinking === undefined)) return undefined;
	return { model: r.model, thinking: r.thinking };
}

/**
 * Build the per-run detached executor + cancellation handle. Called lazily by
 * `runWorkflow` (via the provider) — by the first `/wf` the `session_start`
 * capture has populated `modelRegistry` + `uiContext`.
 *
 * Tap raw keystrokes ahead of the editor for the ONLY working interrupt
 * during orchestration; `ctx.signal` is dead here (no active agent run).
 * `onTerminalInput` (types.d.ts:77) is a REQUIRED method that ALWAYS returns an
 * unsubscribe fn, so gating on `observer.hasUI` (the codebase convention,
 * session-hooks.ts:125) — not the always-truthy `onTerminalInput` return — is
 * what degrades a headless/RPC run to `signal: undefined`.
 */
export function createWorkflowExecution(
	observer: WorkflowHostContext,
	{ runId, childSessionsDir, name }: { runId: string; childSessionsDir: string; name?: string },
): WorkflowExecution {
	// session_start capture — uiContext also backs the abort tap, modelRegistry
	// resolves per-child models. A miss here means session_start never ran (an
	// embedder without the hook, or a registration-ordering bug); fail with a
	// named, actionable error at the boundary instead of an opaque NPE deep in
	// SdkWorkflowHost.
	const uiContext = getCapturedUiContext();
	const modelRegistry = getCapturedModelRegistry();
	if (!uiContext || !modelRegistry) {
		throw new Error(
			"rpiv: session_start capture missing — ensure registerSessionCapture runs before the first /wf run",
		);
	}
	const host = new SdkWorkflowHost({
		live: observer,
		modelRegistry, // session_start capture (real ctx field)
		uiContext, // foreground-child UI binding
		// authStorage + resourceLoader intentionally NOT passed — createAgentSession
		// defaults them per child: auth from disk, own resourceLoader per child.
		cwd: observer.cwd,
		runId,
		childSessionsDir, // resolved by the runner; rpiv-pi does not synthesize the path
		maxConcurrency: DEFAULT_MAX_CONCURRENCY, // 4 — background-lane cap
	});

	// FR1: record this run as a switchable lane at launch (appears in the ambient
	// overlay while in-flight). Done unconditionally (headless too) so eviction is symmetric.
	recordRun(runId, name ?? runId);

	// Abort tap — FOCUS-GATED (the float fix). Pre-float, /wf awaited and the run
	// WAS the foreground, so a global ESC/Ctrl-C abort was correct. Once the run
	// floats (Phase 3), the editor is the foreground and N runs can be in-flight at
	// once — a global tap would (a) steal the editor's ESC/Ctrl-C and (b) abort an
	// arbitrary one of N runs. So: consume Ctrl-C ONLY when THIS run is the lane the
	// user has switched into (getFocusedRun() === runId); abort then targets exactly
	// the run on screen. ESC is never consumed here — it belongs to the editor at
	// root and to the viewer (esc = back to root) when switched in. At root
	// (focus undefined) every keystroke passes through untouched.
	const ac = new AbortController();
	const off = observer.hasUI
		? uiContext.onTerminalInput((data: string) => {
				if (data === "\x03" && getFocusedRun() === runId) {
					// Ctrl-C while switched into THIS lane — abort IS the interrupt.
					ac.abort();
					return { consume: true };
				}
				return undefined; // pass through (editor / focused overlay / sibling taps)
			})
		: undefined;
	// Phase D — expose this run's abort so the manager can cancel it WITHOUT the user
	// switching in (the Ctrl-C tap above is focus-gated). Headless runs have no tap, so
	// only wire it with a UI.
	if (observer.hasUI) setLaneAbort(runId, () => ac.abort());

	// dispose runs in the runner's `finally` when the (floated) run settles — unsubscribe
	// the keystroke tap. The lane is RETAINED on terminal status (Phase A): `onWorkflowEnd`
	// is the normal retirement path; this is the fallback for a throw/crash that bypassed it
	// (a still-"running" lane at dispose means no terminal event fired → retire as aborted),
	// so a lane can never be stranded "running" forever.
	const dispose = () => {
		off?.();
		if (getLane(runId)?.status === "running") retireRun(runId, "aborted");
	};
	return { host, signal: observer.hasUI ? ac.signal : undefined, dispose };
}

/**
 * Wire the execution-host provider to the ROOT launcher's session_start (Phase 7.2).
 *
 * The provider lives in a process-global, last-writer-wins box
 * (rpiv-workflow/execution-host.ts). A detached child re-loads rpiv-core, so if
 * it registered the provider it would OVERWRITE the box with its own
 * `createWorkflowExecution` closure — and the next /wf would then dispatch through
 * the child instance (reading the child's empty session_start capture → a thrown
 * "capture missing"), while the first run's lane vanished into a duplicate
 * registry. So registration is gated to the root launcher: skipped for a
 * foreground child (its `ctx.ui` is a branded lane relay) and for any non-UI
 * session (`!hasUI` — a background fanout child, which can never own the box
 * either; /wf is interactive-only, command-run.ts). Registering on session_start
 * (not the module-load IIFE) keeps the box pointed at the CURRENT root instance
 * across `/reload` — last-writer-wins, but only the root ever writes.
 */
export function registerWorkflowExecutionHostProviderHook(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event: unknown, ctx: { hasUI?: boolean; ui?: ExtensionUIContext }) => {
		if (!ctx.hasUI || isLaneRelayUiContext(ctx.ui)) return; // root launcher only
		await registerWorkflowExecutionHostProvider().catch((err) =>
			console.error("[rpiv-core] failed to register workflow execution host:", err),
		);
	});
}

/**
 * Register the SDK execution-host provider with the rpiv-workflow `/startup`
 * seam. Invoked from the root-gated session_start hook above; degrades silently
 * when the sibling is absent (the missing-sibling banner + /rpiv-setup guide the user).
 */
export async function registerWorkflowExecutionHostProvider(): Promise<void> {
	try {
		// Thin `/startup` entry — keeps the loader/DSL/runner graph off startup.
		const { registerWorkflowExecutionHost } = await import("@juicesharp/rpiv-workflow/startup");
		registerWorkflowExecutionHost({
			createHost: createWorkflowExecution,
			resolveModel: ({ stage, skill }) => toModelSelection(resolveStageModel(loadModelsConfig(), { stage, skill })),
		});
	} catch (err) {
		if (isModuleNotFound(err)) return; // sibling absent — /rpiv-setup guides the user
		throw err;
	}
}
