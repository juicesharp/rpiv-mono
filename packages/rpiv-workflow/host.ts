/**
 * Host ports — the contract the workflow runtime needs from its host
 * environment, expressed in workflow-domain vocabulary.
 *
 * The package never re-exports `@earendil-works/pi-coding-agent` types
 * from its public surface. Two host shapes implement these ports:
 *
 *  - The interactive Pi launcher (`ExtensionCommandContext`) — satisfies the
 *    OBSERVER surface (`ui`/`sessionManager`/`hasUI`/`waitForIdle`) and is
 *    retained as a progress observer only; it no longer executes stages.
 *  - The detached executor host (`SdkWorkflowHost`, in rpiv-pi) — satisfies the
 *    FULL surface including `spawnChild`/`maxConcurrency`; it owns the child
 *    `AgentSession` pool every stage runs in.
 *
 *  - `WorkflowHost`        — registry-level host (default-export ctor +
 *                            skill-registration preflight).
 *  - `WorkflowHostContext` — per-command ctx passed into `runWorkflow`; spawns
 *                            child sessions and never swaps itself out.
 *
 * Compile-time tripwire: `host.test.ts` asserts Pi's concrete observer types
 * extend the observer surface; `rpiv-pi`'s `sdk-workflow-host.test.ts` asserts
 * `SdkWorkflowHost` satisfies the full executor port (the satisfaction
 * assertion lives there because rpiv-workflow must not import rpiv-pi).
 */

/**
 * Registry-level host. Default-exported function receives this; the runner
 * uses it for skill-registration preflight (enumerating registered commands).
 *
 * The two methods we touch on Pi's `ExtensionAPI`. Anything beyond these is
 * invisible to the runtime. (`sendUserMessage` was removed with the
 * continue-policy host-fallback ladder — every stage now holds a live child
 * ctx, so the registry-level sender has no caller.)
 */
export interface WorkflowHost {
	/** Register a slash command. Used by the `/wf` entry point. The handler
	 *  receives the LAUNCHER ctx (observer surface) — the interactive Pi
	 *  `ExtensionCommandContext` Pi delivers; it constructs the executor host
	 *  that actually runs stages. Typing the ctx as the executor
	 *  `WorkflowHostContext` here would demand `spawnChild`/`maxConcurrency` of
	 *  Pi's ctx and break the `host.test.ts` tripwire (Pi's ctx is an OBSERVER). */
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: WorkflowLauncherContext) => Promise<void>;
		},
	): void;
	/** Enumerate currently registered slash commands. Used by skill-registration preflight. */
	getCommands(): ReadonlyArray<{ name: string; source: string }>;
}

/**
 * The observer-only ctx the registry-level host hands the `/wf` handler. The
 * launcher relays progress through it and constructs the executor host that
 * runs stages; it excludes the executor additions (`spawnChild`/
 * `maxConcurrency`) so Pi's `ExtensionCommandContext` structurally satisfies it
 * (and `ExtensionAPI` therefore satisfies `WorkflowHost` — the tripwire).
 */
export type WorkflowLauncherContext = Omit<WorkflowHostContext, "spawnChild" | "maxConcurrency">;

/**
 * Resolved per-unit model override, applied by the host at child-session
 * creation — NOT via global mutation. `model` is a host-opaque model key the
 * host's adapter resolves through its own registry; `thinking` mirrors Pi's
 * thinking levels. Both optional — absent means "host default".
 */
export interface ModelSelection {
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

/**
 * Per-command host ctx. Embedders hand this to `runWorkflow`; the runner
 * threads it (and the child ctx delivered to each `spawnChild`'s `withSession`)
 * through stages.
 *
 * Exhaustive list of members the runtime touches — adding any reach outside
 * this list is a port-widening decision, not an oversight.
 */
export interface WorkflowHostContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
	};
	sessionManager: {
		/**
		 * The session transcript (Pi: a message-union array with private
		 * discriminators). DELIBERATELY `unknown` — naming a workflow-domain
		 * type here would break the no-cast structural pass-through of Pi's
		 * ctx. The runtime never calls this directly: `readBranch(ctx)`
		 * (transcript.ts) is the single boundary that narrows the value to
		 * `BranchEntry[]`.
		 */
		getBranch(): unknown;
		/**
		 * Session identity + on-disk location of the active session — read by
		 * `readSessionRef` (transcript.ts) so every stage row records which
		 * session backed it. `getSessionFile` is `undefined` for non-persisting
		 * (in-memory) sessions.
		 */
		getSessionId(): string;
		getSessionFile(): string | undefined;
	};
	waitForIdle(): Promise<void>;

	/** Cooperative cancellation handle the launcher forwards into `runWorkflow`.
	 *  On Pi this is `ExtensionCommandContext.signal`; optional so non-Pi
	 *  embedders / the observer-only surface need not provide it. */
	signal?: AbortSignal;

	/** Max child sessions runnable at once. 1 ⇒ sequential. The loop reads this;
	 *  it never invents a number. */
	readonly maxConcurrency: number;

	/**
	 * Spawn an isolated child session, send `prompt`, run `body` on its ctx,
	 * return body's result. The PARENT ctx STAYS VALID (no swap). The runner may
	 * have up to `maxConcurrency` spawnChild calls in flight at once.
	 *
	 * `model` is the resolved per-unit override, applied by the host at session
	 * creation — NOT via global mutation. `signal`, when provided, lets the host abort THIS
	 * child mid-flight (`session.abort()`/`dispose()`) the moment it fires —
	 * the dispatcher threads `run.signal` here so an aborted run interrupts
	 * in-flight children, not just between stages.
	 *
	 * `reattach`, when provided, makes the host OPEN the persisted session at
	 * `sessionFile` IN PLACE (appending to it) instead of creating a fresh one,
	 * and DELIVER it to `withSession` WITHOUT sending `prompt` — the prior turn
	 * already ran, so the body promotes from the existing branch or re-prompts via
	 * `sendUserMessage`. This is the detached replacement for the deleted
	 * adopt-a-file session-swap path: session-backed resume of a failed
	 * single stage (`resumeWithSessionLadder`) and per-unit reattach
	 * both spawn a reattaching child rather than swapping the live session.
	 * On a non-persisting (in-memory) host or a missing
	 * file the host falls back to a fresh child; the runner already gates
	 * `reattach` on a `locateSessionFile` hit, so the file is known to exist.
	 *
	 * `fork`, when provided, makes the host FORK the persisted session at
	 * `sessionFile` into a NEW child session (new id, new file) carrying the full
	 * prior transcript as context, WITHOUT mutating the source file and WITHOUT
	 * sending `prompt` (the body sends the continuation turn via `sendUserMessage`,
	 * then measures the inherited prefix). This is how `sessionPolicy: "continue"`
	 * continues its predecessor's conversation under detachment — the predecessor's
	 * file stays intact (DAG-fork-safe; the continue child has its own resumable
	 * identity). The runner gates `fork` on a `locateSessionFile` hit, so the file
	 * is known to exist. At most one of `reattach` / `fork` is set; both suppress
	 * the host's initial `prompt` send.
	 */
	spawnChild<T>(options: {
		prompt: string;
		model?: ModelSelection;
		signal?: AbortSignal;
		reattach?: { sessionFile: string };
		fork?: { sessionFile: string };
		withSession: (child: WorkflowSessionContext) => Promise<T>;
	}): Promise<T>;
}

/**
 * The child ctx delivered to `spawnChild`'s `withSession` callback. The parent
 * `WorkflowHostContext` declares NO sender; this session subtype ADDS
 * `sendUserMessage` as the guaranteed in-session sender — the host always wires
 * one into a freshly-spawned child session. So any caller operating inside a
 * session can send without a presence check, a compile-time fact of the subtype.
 */
export interface WorkflowSessionContext extends WorkflowHostContext {
	sendUserMessage(content: string): Promise<void>;
}
