/**
 * Host ports — the contract the workflow runtime needs from its host
 * environment, expressed in workflow-domain vocabulary.
 *
 * The package never re-exports `@earendil-works/pi-coding-agent` types
 * from its public surface. Pi's `ExtensionAPI` / `ExtensionCommandContext`
 * / `ReplacedSessionContext` structurally satisfy these ports, so
 * embedders pass their Pi handles directly without casting; consumers
 * wanting to drive the runtime from a non-Pi adapter implement these two
 * interfaces.
 *
 *  - `WorkflowHost`    — registry-level host (default-export ctor + continue-policy sender).
 *  - `WorkflowHostContext` — per-command ctx passed into `runWorkflow`, also the
 *                        replacement ctx delivered to `newSession`'s `withSession`
 *                        callback. `sendUserMessage` is optional at the type
 *                        level (the outer command ctx may not carry one) but
 *                        the runtime guarantees it is present inside
 *                        `withSession`.
 *
 * Compile-time tripwire: `host.test.ts` asserts Pi's concrete types
 * extend these ports. If Pi's API drifts (a method renames, a signature
 * tightens), `npm run check` fails immediately on that file.
 */

/**
 * Registry-level host. Default-exported function receives this; the
 * runner also uses it for continue-policy stages (sends into the
 * already-streaming agent) and for skill-registration preflight.
 *
 * The three methods we touch on Pi's `ExtensionAPI`. Anything beyond
 * these is invisible to the runtime.
 */
export interface WorkflowHost {
	/** Register a slash command. Used by the `/wf` entry point. */
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: WorkflowHostContext) => Promise<void>;
		},
	): void;
	/**
	 * Send a user message into the active agent stream. Used by the
	 * continue-policy session handler.
	 *
	 * Pi declares this `void` at the type level but returns a Promise at
	 * runtime; we declare `void | Promise<void>` so `await` is safe in
	 * either world.
	 */
	sendUserMessage(content: string): void | Promise<void>;
	/** Enumerate currently registered slash commands. Used by skill-registration preflight. */
	getCommands(): ReadonlyArray<{ name: string; source: string }>;
}

/**
 * Per-command host ctx. Embedders hand this to `runWorkflow`; the
 * runner threads it (and any replacement ctx returned by `newSession`)
 * through stages.
 *
 * Exhaustive list of members the runtime touches — adding any reach
 * outside this list is a port-widening decision, not an oversight.
 *
 * `sendUserMessage` is declared optional HERE because the outer command
 * ctx Pi delivers to a `/wf` handler does not carry one. The replacement
 * ctx delivered inside `newSession`'s `withSession` callback always does
 * — that stronger guarantee is modelled by the `WorkflowSessionContext`
 * subtype below, which `withSession` delivers. Code holding a bare
 * `WorkflowHostContext` (the workflow-start path before any session
 * opens) must still null-check before calling.
 */
export interface WorkflowHostContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
	};
	sessionManager: {
		getBranch(): unknown;
	};
	waitForIdle(): Promise<void>;
	/**
	 * Open a fresh session and run `withSession` on the replacement ctx.
	 * Returns `{ cancelled: true }` if the host declined to spawn (user
	 * dismissed the swap, etc.). `cancelled: false` implies the outer
	 * ctx is now invalidated — all further work runs on the replacement
	 * delivered to `withSession`.
	 */
	newSession(options: {
		withSession: (replacement: WorkflowSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;
	/**
	 * Optional on the base port — only the outer command ctx lacks it.
	 * Inside a session use `WorkflowSessionContext`, where it is required.
	 */
	sendUserMessage?(content: string): Promise<void>;
}

/**
 * The replacement ctx delivered to `newSession`'s `withSession` callback.
 * Identical to `WorkflowHostContext` except `sendUserMessage` is
 * GUARANTEED present — Pi always wires a sender into a freshly-opened
 * session. Narrowing the optional to required here turns what used to be
 * a runtime `if (!ctx.sendUserMessage) throw` guard into a compile-time
 * fact for every caller operating inside a session. `host.test.ts`
 * asserts Pi's internal replacement ctx still satisfies this.
 */
export interface WorkflowSessionContext extends WorkflowHostContext {
	sendUserMessage(content: string): Promise<void>;
}
