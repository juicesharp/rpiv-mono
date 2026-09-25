/**
 * rpiv-todo — Pi extension. Registers the `todo` tool, `/todos` slash
 * command, and the persistent TodoOverlay widget.
 *
 * TUI chrome strings localize at render time via the i18n bridge. Strings are
 * registered with rpiv-i18n here, once, at module init — but only when the
 * SDK is actually installed. If `@juicesharp/rpiv-i18n` is missing (standalone
 * install of just this package), the dynamic-load shim no-ops and the bridge's
 * `t(key, fallback)` returns the inline English literal at every call site.
 * The extension stays online either way.
 *
 * Adding a locale: drop `locales/<code>.json` next to en.json (mirroring the
 * key set). No edit needed here — `registerLocalesFromDir` iterates
 * `SUPPORTED_LOCALES` from the SDK. See `@juicesharp/rpiv-i18n` README →
 * "Contributing translations" for the full convention.
 *
 * Extracted from rpiv-pi@7525a5d. Tool name "todo" and widget key
 * "rpiv-todos" preserved verbatim so existing session history replays
 * correctly after upgrade.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, getReminderCooldownTurns, getStaleAfterTurns, resolveCollapseKey } from "./config.js";
import { getActivity } from "./state/activity-tracker.js";
import { I18N_NAMESPACE, t } from "./state/i18n-bridge.js";
import { replayFromBranch } from "./state/replay.js";
import {
	clearActiveRenderSession,
	evictSession,
	getActiveRenderSession,
	getRenderState,
	getState,
	replaceState,
	setActiveRenderSession,
	sid,
} from "./state/store.js";
import { registerTodosCommand, registerTodoTool, TOOL_NAME } from "./todo.js";
import type { TodoOverlay } from "./todo-overlay.js";

type I18nLoader = {
	registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => void;
};

/** Delay the overlay graph pre-warm until Pi's startup work has settled. */
export const PREWARM_DELAY_MS = 2000;

type TodoOverlayModule = typeof import("./todo-overlay.js");
type TodoOverlayImporter = () => Promise<TodoOverlayModule>;

/**
 * Marker shared by the loader's poisoned-namespace error and the
 * `isStaleOverlayModuleError` predicate that lets handlers re-throw it while
 * swallowing transient load failures.
 */
const STALE_OVERLAY_MESSAGE = "Todo overlay module cache is stale; restart Pi";

/** True for the loader's latched poisoned-namespace error (see below). */
export function isStaleOverlayModuleError(e: unknown): boolean {
	return String(e).includes(STALE_OVERLAY_MESSAGE);
}

/**
 * Memoize the overlay graph after a successful load, but drop a rejected
 * promise so a failed pre-warm does not permanently replay the same rejection.
 * The export guard turns jiti's poisoned-namespace failure into a useful restart
 * error instead of a bare "TodoOverlay is not a constructor" TypeError.
 */
export function makeTodoOverlayLoader(
	importOverlay: TodoOverlayImporter = () => import("./todo-overlay.js"),
): TodoOverlayImporter {
	let memo: Promise<TodoOverlayModule> | undefined;

	return async (): Promise<TodoOverlayModule> => {
		memo ??= importOverlay();
		const current = memo;
		let mod: TodoOverlayModule;
		try {
			mod = await current;
		} catch (error) {
			// Clear only OUR rejected promise: a late catch from a concurrent
			// awaiter must never clobber a fresh retry another caller installed.
			if (memo === current) memo = undefined;
			throw error;
		}
		if (typeof mod.TodoOverlay !== "function") {
			// Deliberately latched: the memo keeps this resolved-but-poisoned
			// namespace, so every subsequent load re-throws instead of retrying.
			// Re-importing would hand back the same cached jiti namespace — a
			// retry can never heal this; only the restart the error asks for can.
			const keys = JSON.stringify(Object.keys(mod));
			throw new Error(`${STALE_OVERLAY_MESSAGE} (resolved namespace keys: ${keys})`);
		}
		return mod;
	};
}

// Dynamic import keeps `@juicesharp/rpiv-i18n` a soft optional peer: when the
// SDK is installed alongside this package the strings register and
// `/languages` flips them live; when it isn't, the import rejects here, we
// no-op, and the bridge's English-fallback shim keeps the extension online.
//
// The `/loader` subpath is used instead of the SDK entry so the i18n-ui +
// pi-tui modules are not pulled into our load graph just to register strings.
try {
	const sdk = (await import("@juicesharp/rpiv-i18n/loader")) as I18nLoader;
	sdk.registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, { label: "rpiv-todo" });
} catch {
	// SDK absent — extension still loads with English-only UI.
}

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring so genuine
// replay bugs still propagate instead of being silently swallowed.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

/**
 * Render a caught `unknown` as a human-readable message — the `instanceof Error`
 * dance collapsed to one place. Local copy of the `formatError` in
 * packages/rpiv-workflow/internal-utils.ts:56-58 (that module disclaims its
 * public surface, so the cross-package import is not available). M2 boundary
 * duplication: tracked as a documented-constant seam.
 */
function formatError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export default function (pi: ExtensionAPI, importOverlay: TodoOverlayImporter = () => import("./todo-overlay.js")) {
	let todoOverlay: TodoOverlay | undefined;
	const loadTodoOverlay = makeTodoOverlayLoader(importOverlay);
	let uiCtx: ExtensionUIContext | undefined;
	let lifecycleGeneration = 0;

	async function updateTodoOverlay(
		resetCompletedDisplayState = false,
		generation = lifecycleGeneration,
	): Promise<void> {
		const hasVisibleTasks = getRenderState().tasks.some((task) => task.status !== "deleted");
		if (!uiCtx || (!todoOverlay && !hasVisibleTasks)) return;

		const { TodoOverlay } = await loadTodoOverlay();
		if (generation !== lifecycleGeneration || !uiCtx) return;

		todoOverlay ??= new TodoOverlay();
		todoOverlay.setUICtx(uiCtx);
		if (resetCompletedDisplayState) todoOverlay.resetCompletedDisplayState();
		todoOverlay.update();
	}

	registerTodoTool(pi);
	registerTodosCommand(pi);

	// Collapse/expand hotkey for the todo overlay. The key is resolved once at
	// factory scope from config (register-once contract: a config change needs
	// `/reload` to re-bind, same as lane-switcher's env hotkey) and the binding is
	// skipped entirely when collapseKey is "off". The handler closes over the
	// closure-local `todoOverlay` by reference and re-reads it at fire time, so an
	// overlay loaded after shortcut registration is picked up. No-op in headless
	// mode, before the overlay has loaded, or when the widget isn't currently
	// registered (auto-hidden on an empty list).
	const collapseKey = resolveCollapseKey();
	if (collapseKey !== COLLAPSE_KEY_OFF) {
		pi.registerShortcut(collapseKey as KeyId, {
			description: "Collapse or expand the todo overlay",
			handler: (ctx) => {
				if (!ctx.hasUI || !todoOverlay?.isRegistered()) return;
				todoOverlay.toggleCollapse();
			},
		});
	}

	// Re-key a session's slot from its branch, then refresh the overlay only when
	// the refreshed session IS the foreground. Shared by session_compact and
	// session_tree (verbatim-identical pre-extraction). A stale ctx (auto-compaction
	// races session disposal: pi-core invalidates the runner while still emitting the
	// event, so `ctx` may be a dead proxy whose getters throw) keeps current state —
	// the replacement session's session_start replays it. Other errors are real replay
	// bugs and must propagate. The render is sid-gated so a child never refreshes the
	// foreground overlay.
	const replayAndRefresh = async (
		ctx: Parameters<typeof sid>[0] & Parameters<typeof replayFromBranch>[0],
	): Promise<void> => {
		let isForeground = false;
		try {
			const id = sid(ctx);
			replaceState(id, replayFromBranch(ctx));
			isForeground = id === getActiveRenderSession();
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		if (isForeground) await updateTodoOverlay(true);
	};

	pi.on("session_start", async (_event, ctx) => {
		let id: string;
		try {
			id = sid(ctx);
			// Every session replays into its OWN data slot (Phase 1 isolation).
			replaceState(id, replayFromBranch(ctx));
		} catch (e) {
			// Parity with compact/tree/shutdown: session_start is the fresh-ctx event
			// so the stale risk is low, but a stale/throwing ctx has nothing to bind —
			// swallow the known stale error and bail; let real replay bugs propagate.
			if (!isStaleCtxError(e)) throw e;
			return;
		}
		if (!ctx.hasUI) return;
		// First UI-bearing session_start claims the foreground (the interactive
		// launcher, by spawn-ordering) without eagerly loading the overlay.
		if (getActiveRenderSession() === "") setActiveRenderSession(id);
		// Only the foreground re-binds/refreshes the shared overlay. A child
		// (distinct sid) is skipped — does not rebind to a relay/stale ui.
		if (id !== getActiveRenderSession()) return;
		const generation = ++lifecycleGeneration;
		uiCtx = ctx.ui;
		await updateTodoOverlay(true, generation);
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Remember the session needs one resync hint on its next agent start (the
		// model lost its working memory of the todo list across compaction; the
		// data itself survived via replay). Best-effort sid — a stale ctx (same
		// race as replayAndRefresh) just skips the flag; the replacement
		// session's session_start replays the store anyway.
		try {
			const id = sid(ctx);
			if (id) getActivity(id).compactionResyncPending = true;
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		await replayAndRefresh(ctx);
	});

	// `session_compact_failed` exists at runtime (Pi 0.84+) but is absent from the
	// package's pinned 0.80.6 ExtensionAPI overloads, so we register through a
	// narrow local port that accepts the extra event name, staying compile-compatible
	// with the pinned peer while still wiring the runtime handler. See
	// docs/extensions.md → session_compact_failed.
	(
		pi as unknown as {
			on(
				event: "session_compact_failed",
				handler: (event: unknown, ctx: { sessionManager: { getSessionId(): string } }) => Promise<void> | void,
			): void;
		}
	).on("session_compact_failed", async (_event, ctx) => {
		// A failed/aborted compaction means the session was NOT rewritten, so the
		// model's working memory was not lost — a "your todo list survived, call
		// list" resync hint would be a false claim. Clear the pending flag (if a
		// later compaction succeeds it sets it again). Best-effort sid, same stale
		// ctx handling as session_compact.
		try {
			const id = sid(ctx);
			if (id) delete getActivity(id).compactionResyncPending;
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		await replayAndRefresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Best-effort sid: disposal can race a stale ctx (like compact). An
		// unknown/stale sid resolves to "" and is treated as foreground — the
		// safe pre-isolation default that disposes as before.
		let s: string;
		try {
			s = sid(ctx);
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			s = "";
		}
		// The shutting-down session's own data slot is always evicted.
		evictSession(s);
		// Overlay teardown is sid-gated: a child shutdown (distinct sid) must not
		// dispose the foreground's overlay. Only the foreground's own shutdown
		// (or an unknown/stale sid) tears it down and clears the pointer.
		if (s === "" || s === getActiveRenderSession()) {
			// Invalidate pending imports before clearing the foreground binding so a
			// replaced session cannot inherit the stale overlay or UI context.
			lifecycleGeneration++;
			uiCtx = undefined;
			// `dispose()`'s first act is setWidget(KEY, undefined) on a possibly-stale
			// ui proxy, which can throw. evictSession(s) above already deleted this
			// slot, so leaving `activeRenderSession` pointing at it would resolve
			// getRenderState() to a fresh EMPTY_STATE (overlay silently renders empty).
			// try/finally guarantees the pointer-clear + overlay-drop run regardless.
			try {
				todoOverlay?.dispose();
			} finally {
				todoOverlay = undefined;
				clearActiveRenderSession();
			}
		}
	});

	// Reads getTodos() at render time; do NOT call replayFromBranch here
	// (branch is stale — message_end runs after tool_execution_end).
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		try {
			await updateTodoOverlay();
		} catch (e) {
			// The tool itself succeeded — a transient overlay-load failure only
			// costs this one refresh, and the loader's cleared memo lets the next
			// update retry. Don't surface that as an extension error. The latched
			// stale-namespace error still propagates: it never self-heals, and the
			// user needs its restart guidance.
			if (isStaleOverlayModuleError(e)) throw e;
			console.warn(`[rpiv-todo] overlay refresh failed (will retry on next update): ${formatError(e)}`);
		}
	});

	// Evaluate the lazy graph after startup while Pi's boot-time dependency paths
	// are still stable. This loads no widget and constructs no overlay; those stay
	// deferred until a foreground session has visible tasks. A rejected pre-warm
	// is intentionally swallowed after loadTodoOverlay clears its memo, allowing
	// the first real update to retry. unref avoids holding an embedder open.
	const prewarmTimer = setTimeout(() => void loadTodoOverlay().catch(() => undefined), PREWARM_DELAY_MS);
	prewarmTimer.unref?.();

	pi.on("agent_start", async () => {
		todoOverlay?.hideCompletedTasksFromPreviousTurn();
	});

	// -------------------------------------------------------------------------
	// Stale-todo activity tracking + reminders (Issue #159). The tracker is
	// runtime-only, per-session, and never persisted — see state/activity-tracker.ts.
	// A stale reminder is injected into an arbitrary tool result so the model
	// sees it WHILE busy (bash/edit gaps are exactly when todo updates drop),
	// not only on the next todo call.
	//
	// Turn-index scoping: Pi resets turnIndex to 0 on every agent_start, so the
	// "N turns without a todo call" count is only meaningful within ONE agent
	// run. Cross-run staleness (follow-up prompt / compaction retry / queued
	// continuation) is intentionally NOT tracked here: the human operator sees
	// the todo list in the TUI at all times, so reminding them adds no
	// information. Only the model's own in-run drift needs this tracker.
	// -------------------------------------------------------------------------

	pi.on("turn_start", (event, ctx) => {
		let id: string;
		try {
			id = sid(ctx);
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			return;
		}
		const activity = getActivity(id);
		activity.currentTurn = event.turnIndex;
	});

	pi.on("turn_end", (_event, ctx) => {
		let id: string;
		try {
			id = sid(ctx);
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			return;
		}
		const activity = getActivity(id);
		// A successful todo call during this turn advances the baseline. Only
		// commit on turn_end so a mid-turn failure (isError) never resets it.
		if (activity.todoSyncedThisTurn) {
			activity.lastTodoTurn = activity.currentTurn;
			activity.todoSyncedThisTurn = false;
		}
	});

	pi.on("tool_result", (event, ctx) => {
		let id: string;
		try {
			id = sid(ctx);
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			return;
		}
		const activity = getActivity(id);

		// A successful todo call marks this turn as synced (committed on turn_end)
		// AND short-circuits the stale check entirely: this turn already synced, so
		// injecting a "please call todo list" reminder onto the todo result itself
		// would be contradictory. A failed todo call must NOT reset the baseline.
		if (event.toolName === TOOL_NAME && !event.isError) {
			activity.todoSyncedThisTurn = true;
			return;
		}

		const state = getState(id);
		const hasInProgress = state.tasks.some((task) => task.status === "in_progress");
		// lastTodoTurn undefined = no successful todo call this run yet → no baseline,
		// so no staleness can be measured. (Must not use a numeric sentinel: a real
		// successful call in turn 0 legitimately stores 0.)
		if (!hasInProgress || activity.lastTodoTurn === undefined) return;

		const staleAfter = getStaleAfterTurns();
		const turnsSinceTodo = activity.currentTurn - activity.lastTodoTurn;
		if (turnsSinceTodo < staleAfter) return;

		// Cooldown: never remind twice in the same turn, and keep the minimum
		// gap between reminders for this session.
		const cooldown = getReminderCooldownTurns();
		if (activity.lastReminderTurn !== undefined && activity.currentTurn - activity.lastReminderTurn < cooldown) {
			return;
		}
		activity.lastReminderTurn = activity.currentTurn;

		const reminder = t(
			"reminder.stale",
			"Tasks have gone {n} turns without a todo sync. Call `todo list` to check whether they are still in progress, then update their status based on the actual result.",
		).replace("{n}", String(turnsSinceTodo));
		return { content: [...event.content, { type: "text", text: reminder }] };
	});

	// After compaction the todo DATA survives (replayed from the branch), but the
	// model's working memory of the list is gone. Inject one resync hint into the
	// first agent start after a compaction. We append to the system prompt for
	// this turn (no extra LLM call, no agent_end→sendMessage loop); the pending
	// flag is cleared here so it fires exactly once.
	pi.on("before_agent_start", (event, ctx) => {
		let id: string;
		try {
			id = sid(ctx);
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			return;
		}
		const activity = getActivity(id);
		if (!activity.compactionResyncPending) return;
		activity.compactionResyncPending = false;
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n" +
				t(
					"resync.after_compact",
					"Todo state has been restored from session history. Call `todo list` to re-read the current tasks; do not assume the pre-compaction task state is still in context.",
				),
		};
	});
}
