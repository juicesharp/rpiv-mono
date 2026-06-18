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

import type { ModelSelection, WorkflowHostContext } from "@juicesharp/rpiv-workflow";
import { loadModelsConfig, resolveStageModel } from "./models-config.js";
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
	{ runId, childSessionsDir }: { runId: string; childSessionsDir: string },
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

	const ac = new AbortController();
	const off = observer.hasUI
		? uiContext.onTerminalInput((data: string) => {
				if (data === "\x1b" || data === "\x03") {
					// ESC or Ctrl-C
					ac.abort();
					return { consume: true }; // abort IS the interrupt
				}
				return undefined; // pass every other key through
			})
		: undefined;
	return { host, signal: observer.hasUI ? ac.signal : undefined, dispose: off };
}

/**
 * Register the SDK execution-host provider with the rpiv-workflow `/startup`
 * seam. Fire-and-forget from `index.ts`; degrades silently when the sibling is
 * absent (the missing-sibling banner + /rpiv-setup guide the user).
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
