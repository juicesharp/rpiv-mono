/**
 * sdk-workflow-host — the SOLE module importing the Pi SDK's session machinery.
 *
 * Implements the rpiv-workflow executor port (`WorkflowHostContext`) over
 * `createAgentSession`: every stage / fanout unit runs in a child `AgentSession`
 * this host owns, the interactive session never executes a stage and is never
 * swapped, units run in bounded parallel (`maxConcurrency`), and a fired signal
 * aborts in-flight children.
 *
 * Service sourcing: the host BORROWS only `modelRegistry` (captured
 * from session_start, carrying auth/OAuth state); `authStorage` is defaulted
 * per child from disk. The `resourceLoader` is SUPPLIED per child (not
 * defaulted) so it can filter out launcher-only ambient extensions — see
 * `withoutAmbientExtensions` (A). The per-unit model is resolved through the
 * borrowed registry and applied at child-session creation — NEVER via global
 * `pi.setModel()`.
 *
 * Child teardown emits `session_shutdown` BEFORE `dispose()` (B) so loaded
 * extensions run their cleanup; `dispose()` alone only invalidates the runner.
 *
 * The lane decides the UI binding: a "foreground" child binds the real
 * interactive `ExtensionUIContext` (so `ask_user_question` reaches the human);
 * a "background" child binds none ⇒ the SDK's `noOpUIContext` ⇒ `hasUI:false` ⇒
 * UI-requiring tools degrade instead of blocking, which is what makes the
 * background lane safe to fan out.
 *
 * The executor-port satisfaction assertion lives in this package's
 * `sdk-workflow-host.test.ts`, NOT in rpiv-workflow (which must not import
 * rpiv-pi).
 */

import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type Extension,
	type ExtensionUIContext,
	getAgentDir,
	type LoadExtensionsResult,
	type ModelRegistry,
	SessionManager,
	type SessionShutdownEvent,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { parseModelKey } from "@juicesharp/rpiv-config";
import type {
	ExecutionLane,
	ModelSelection,
	WorkflowHostContext,
	WorkflowSessionContext,
} from "@juicesharp/rpiv-workflow";

/**
 * Launcher-only "ambient observer" extensions: they register session-lifecycle
 * handlers + side effects (timers, intervals, OSC/terminal writers, spinners)
 * but expose NO tools or commands a stage skill invokes. A detached child has
 * no terminal of its own, so loading one per child is pure cost AND a hazard —
 * `rpiv-warp` arms a 300ms idle timer on `agent_end` that calls
 * `buildIdlePromptPayload(ctx)` reading `ctx.cwd`; once the child is disposed
 * the orphaned timer fires against the invalidated runner → uncaught stale-ctx
 * crash. Matched by package dir anywhere in the extension's path. Extend this
 * list as other terminal/UI observer extensions appear; `session_shutdown`-on-
 * teardown (B) is the general safety net for anything not listed here.
 */
export const CHILD_AMBIENT_EXTENSION_DENYLIST: readonly string[] = ["rpiv-warp"];

/** True when an extension is a launcher-only ambient observer (denylisted). */
export function isAmbientChildExtension(ext: Pick<Extension, "path" | "resolvedPath">): boolean {
	const haystack = `${ext.path ?? ""}\n${ext.resolvedPath ?? ""}`;
	return CHILD_AMBIENT_EXTENSION_DENYLIST.some((name) => haystack.includes(name));
}

/**
 * `extensionsOverride` for a child's resource loader (A): drop ambient observer
 * extensions BEFORE the runner invokes their factories, so they never register
 * a handler or arm a timer in a child session.
 */
export function withoutAmbientExtensions(base: LoadExtensionsResult): LoadExtensionsResult {
	return { ...base, extensions: base.extensions.filter((e) => !isAmbientChildExtension(e)) };
}

/**
 * What the launcher borrows from the live interactive session + the run
 * identity. Sourcing: ONLY `modelRegistry` is borrowed; `authStorage`
 * and `resourceLoader` are NOT (they are absent from this context) — they are
 * defaulted per child by `createAgentSession` from disk.
 *
 * `childSessionsDir` is passed in as a RESOLVED STRING, not imported. The
 * layout helper (`state/paths.ts`) stays internal to rpiv-workflow (alongside
 * `runsDir`/`stateFilePath`, deliberately kept off the public barrel so
 * external packages can't synthesize layout-coupled paths). The runner computes
 * the dir from cwd+runId and hands rpiv-pi the concrete path.
 */
export interface SdkWorkflowHostDeps {
	/** The interactive ctx — observer (ui/sessionManager) + the hasUI source. */
	live: Pick<WorkflowHostContext, "ui" | "sessionManager" | "hasUI">;
	/** Borrowed at session_start (carries auth/OAuth state). */
	modelRegistry: ModelRegistry;
	/** The real foreground UI (bound to foreground children; captured at session_start). */
	uiContext: ExtensionUIContext;
	cwd: string;
	runId: string;
	/** Run-scoped persisted-session dir, resolved by the runner. Passed
	 *  verbatim to `SessionManager.create(cwd, dir)` / `SessionManager.open(file, dir)`. */
	childSessionsDir: string;
	maxConcurrency: number;
}

/**
 * Detached executor host. Every stage / fanout unit runs in a child
 * `AgentSession` this host owns; the interactive session never executes a stage
 * and is never swapped. The model is resolved per child (NO `pi.setModel()`);
 * the lane decides the UI binding.
 */
export class SdkWorkflowHost implements WorkflowHostContext {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly maxConcurrency: number;

	constructor(private readonly deps: SdkWorkflowHostDeps) {
		this.cwd = deps.cwd;
		this.hasUI = deps.live.hasUI;
		this.maxConcurrency = deps.maxConcurrency;
	}

	/** Host-level ui relays to the launcher (aggregates per-unit). */
	get ui() {
		return this.relayUi();
	}

	/** The outer ctx never backs a stage — delegate reads to the live observer. */
	get sessionManager() {
		return this.deps.live.sessionManager;
	}

	/** Host level is not a session — idle is per child (see the private overload). */
	waitForIdle(): Promise<void> {
		return Promise.resolve();
	}

	async spawnChild<T>(options: {
		prompt: string;
		lane: ExecutionLane;
		model?: ModelSelection;
		signal?: AbortSignal;
		reattach?: { sessionFile: string };
		withSession: (child: WorkflowSessionContext) => Promise<T>;
	}): Promise<T> {
		// (A) Build the child's resource loader with the SAME discovery
		// createAgentSession would do when omitted (cwd + agentDir + settings),
		// but filtered: ambient launcher-only observers (rpiv-warp et al.) are
		// dropped before their factories run. A FRESH loader per child is
		// mandatory — `LoadExtensionsResult` carries a shared `runtime`, so
		// reusing one loader across concurrent children would cross-wire their
		// extension runtimes.
		const agentDir = getAgentDir();
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.cwd,
			agentDir,
			settingsManager: SettingsManager.create(this.cwd, agentDir),
			extensionsOverride: withoutAmbientExtensions,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: this.cwd,
			// Borrow ONLY the registry; authStorage is still defaulted per child
			// from ~/.pi/agent/auth.json. resourceLoader is SUPPLIED (filtered),
			// not defaulted, so children skip launcher-only observer extensions.
			modelRegistry: this.deps.modelRegistry,
			resourceLoader,
			// FRESH child: run-scoped persistence (a new file under childSessionsDir,
			// keyed by the new sessionId). REATTACH: OPEN the
			// persisted file so the child carries the prior transcript/branch — the
			// detached replacement for the deleted ctx.switchSession adopt.
			sessionManager: options.reattach
				? SessionManager.open(options.reattach.sessionFile, this.deps.childSessionsDir)
				: SessionManager.create(this.cwd, this.deps.childSessionsDir),
			model: this.resolveModelKey(options.model?.model),
			thinkingLevel: options.model?.thinking,
		});

		// session.abort() does NOT reject prompt(); the SDK catches the abort,
		// writes a stopReason:"aborted" transcript message, and RESOLVES the run
		// (@earendil-works/pi-agent-core/dist/agent.js). So abort here just
		// interrupts the in-flight model turn; the run continues normally into
		// withSession, where postStage detects the aborted stop and throws
		// WorkflowAbortError (the abort signal of record).
		const onAbort = () => void session.abort();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			// foreground binds the real UI (ask_user_question works as today);
			// background binds none ⇒ hasUI:false ⇒ ask_user_question degrades.
			await session.bindExtensions({
				uiContext: options.lane === "foreground" ? this.deps.uiContext : undefined,
			});
			// FRESH child: send the initial prompt (/skill: text-expansion; resolves
			// even on abort). REATTACH: the prior turn already ran and its
			// transcript is loaded, so DO NOT replay the prompt — withSession's body
			// promotes from the branch or re-prompts via sendUserMessage. Replaying
			// here would double-run the stage.
			if (!options.reattach) await session.prompt(options.prompt);
			return await options.withSession(this.adapt(session, options.lane));
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
			await this.teardownChild(session); // (B) session_shutdown → dispose
		}
	}

	/**
	 * Tear a child down lifecycle-correctly (B): emit `session_shutdown` so any
	 * loaded extension runs its cleanup (cancel timers/intervals, restore the
	 * terminal) BEFORE `dispose()` invalidates the runner. `dispose()` alone only
	 * calls `extensionRunner.invalidate()` — it never fires `session_shutdown` —
	 * so a captured-ctx timer (e.g. rpiv-warp's idle prompt) would otherwise leak
	 * and fire against a stale ctx. Mirrors the SDK runtime's own teardown order
	 * (shutdown → dispose). Best-effort: a throwing handler must not block
	 * release, and `dispose()` always runs.
	 */
	private async teardownChild(session: AgentSession): Promise<void> {
		try {
			if (session.hasExtensionHandlers("session_shutdown")) {
				const shutdown: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" };
				await session.extensionRunner.emit(shutdown);
			}
		} catch {
			// teardown is best-effort; never block dispose.
		} finally {
			session.dispose();
		}
	}

	/** A child ctx — the guaranteed-in-session surface the stage machinery holds. */
	private adapt(session: AgentSession, lane: ExecutionLane): WorkflowSessionContext {
		return {
			cwd: this.cwd,
			hasUI: lane === "foreground" && this.deps.live.hasUI,
			ui: this.relayUi(),
			maxConcurrency: this.maxConcurrency,
			spawnChild: this.spawnChild.bind(this), // a child may itself fan out (depth budget — deferred)
			sessionManager: {
				// The transcript reader (`transcript.ts`) expects the ENVELOPED branch
				// shape `{ type: "message", message: {...} }` (SessionEntry[]) — the same
				// `sessionManager.getBranch()` returns and the old `ctx.sessionManager`
				// path delivered. `session.messages` is the RAW un-enveloped
				// `AgentMessage[]` ({ role, content, stopReason }), so reading it made
				// `hasAssistantMessage` see zero assistant messages and every stage halt
				// with FAIL_STAGE_NO_RESPONSE even after a full, successful run.
				getBranch: () => session.sessionManager.getBranch(),
				getSessionId: () => session.sessionId,
				getSessionFile: () => session.sessionFile,
			},
			waitForIdle: () => this.waitForChildIdle(session),
			sendUserMessage: (content) => session.sendUserMessage(content),
		};
	}

	/** The idle signal: settle when streaming ends. */
	private waitForChildIdle(session: AgentSession): Promise<void> {
		if (!session.isStreaming) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const unsub = session.subscribe(() => {
				if (!session.isStreaming) {
					unsub();
					resolve();
				}
			});
		});
	}

	/** Model key string → registry Model, applied at session creation — never
	 *  via global `pi.setModel()`. */
	private resolveModelKey(key?: string): Model<any> | undefined {
		if (!key) return undefined;
		const parsed = parseModelKey(key);
		return parsed
			? (this.deps.modelRegistry.find(parsed.provider, parsed.modelId) as Model<any> | undefined)
			: undefined;
	}

	private relayUi() {
		return {
			notify: (message: string, level?: "info" | "warning" | "error") => this.deps.live.ui.notify(message, level),
			setStatus: (key: string, text: string | undefined) => this.deps.live.ui.setStatus(key, text),
		};
	}
}
