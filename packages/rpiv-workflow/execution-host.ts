/**
 * Execution-host injection seam. The /wf launcher + runner are Pi-agnostic; the
 * SDK-backed executor (`SdkWorkflowHost`) lives in rpiv-pi. rpiv-pi registers a
 * provider at startup; `runWorkflow` looks it up, builds the executor from the
 * live observer ctx, and threads it for stage execution (the executor relays UI
 * back to the live session). Absent provider ⇒ the live ctx executes directly
 * (graceful degrade for non-Pi embedders / tests).
 */
import type { ModelSelection, WorkflowHostContext } from "./host.js";
import { globalSlot } from "./internal-utils.js";
import type { BranchEntry } from "./transcript.js";

/** What the provider hands back per run: the detached executor, an optional
 *  cancellation `signal` (rpiv-pi wires it from `ctx.ui.onTerminalInput`),
 *  and a `dispose` the runner calls in `finally` to unsubscribe the keystroke
 *  tap. `signal`/`dispose` are absent in headless mode (no UI ⇒ no abort). */
export interface WorkflowExecution {
	host: WorkflowHostContext;
	signal?: AbortSignal;
	dispose?: () => void;
}

export interface WorkflowExecutionProvider {
	/** Build the detached executor host (+ abort signal/teardown) from the live
	 *  observer ctx + run identity. `childSessionsDir` is the RESOLVED run-scoped
	 *  session dir — the runner computes it from its internal layout helper so
	 *  rpiv-pi never imports a layout function across the package boundary. */
	createHost(
		observer: WorkflowHostContext,
		opts: {
			runId: string;
			childSessionsDir: string;
			name?: string;
			/** Workflow name — lets the lane dock render a `workflow:` tag. Threaded
			 *  from workflow.name (run path) / header.workflow (resume path). */
			workflow?: string;
			/** The run's original `/wf` input (the user prompt) — the dock renders it as the
			 *  descriptor label when no `--name` alias is set. Threaded from options.input /
			 *  header.input. */
			input?: string;
		},
	): WorkflowExecution | Promise<WorkflowExecution>;
	/** Per-stage model resolution (rpiv-pi's resolveStageModel) — threaded onto
	 *  RunContext.resolveModel so the dispatcher fills each child's ModelSelection. */
	resolveModel?(id: { workflow: string; stage: string; skill: string }): ModelSelection | undefined;
	/** Re-open a persisted child-session JSONL and return its branch
	 *  (`SessionManager.open(file).getBranch()` on the rpiv-pi side), narrowed
	 *  to `BranchEntry[]`. Threaded onto `RunContext.readSessionBranch` so the
	 *  death-scene artifact writer can read the just-failed session's transcript
	 *  WITHOUT re-querying the live child (which is already torn down). Returns
	 *  `undefined` on any open/read failure (fail-soft). Absent for programmatic
	 *  embedders / no provider ⇒ the writer degrades silently. */
	readSessionBranch?(file: string): BranchEntry[] | undefined;
}

// Use the SAME globalThis[Symbol.for(...)] slot mechanism as
// `registerLifecycle`/the built-in registry (internal-utils.globalSlot), NOT a
// plain module-level `let`. rpiv-pi reaches this seam via a dynamic
// `import("@juicesharp/rpiv-workflow/startup")` while the runner reaches it via a
// static `../execution-host.js`; if those ever resolve to two module instances
// of rpiv-workflow (peer-dependency duplication), a module-local `let` would put
// `register` and `get` on DIFFERENT slots and the lookup would silently return
// `undefined` (degrade-to-live — a quiet correctness bug, not a crash). A
// process-global Symbol slot is instance-independent and matches the precedent
// this seam claims to mirror.
//
// globalSlot signature: `globalSlot<T>(key: symbol, init: () => T): () => T` — a
// lazily-initialised getter. Because the provider must be resettable to
// `undefined` (and globalSlot never re-runs init once seeded), anchor a MUTABLE
// BOX, exactly like the lifecycle flush-box pattern (internal-utils.ts).
const getProviderBox = globalSlot(Symbol.for("@juicesharp/rpiv-workflow:executionHostProvider"), () => ({
	provider: undefined as WorkflowExecutionProvider | undefined,
}));

export function registerWorkflowExecutionHost(p: WorkflowExecutionProvider): void {
	getProviderBox().provider = p;
}
export function getWorkflowExecutionProvider(): WorkflowExecutionProvider | undefined {
	return getProviderBox().provider;
}
/** Test reset — re-exported from `internal.ts` and called in `test/setup.ts` beforeEach. */
export function __resetWorkflowExecutionHost(): void {
	getProviderBox().provider = undefined;
}
