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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { I18N_NAMESPACE } from "./state/i18n-bridge.js";
import { replayFromBranch } from "./state/replay.js";
import {
	clearActiveRenderSession,
	evictSession,
	getActiveRenderSession,
	replaceState,
	setActiveRenderSession,
	sid,
} from "./state/store.js";
import { registerTodosCommand, registerTodoTool, TOOL_NAME } from "./todo.js";
import { TodoOverlay } from "./todo-overlay.js";

type I18nLoader = {
	registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => void;
};

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

export default function (pi: ExtensionAPI) {
	// Todo overlay widget — constructed lazily at the first session_start with UI.
	let todoOverlay: TodoOverlay | undefined;

	registerTodoTool(pi);
	registerTodosCommand(pi);

	pi.on("session_start", async (_event, ctx) => {
		const id = sid(ctx);
		// Every session replays into its OWN data slot (Phase 1 isolation).
		replaceState(id, replayFromBranch(ctx));
		if (!ctx.hasUI) return;
		// First UI-bearing session_start claims the foreground (the interactive
		// launcher, by spawn-ordering). A child hitting a live overlay cannot
		// clobber the pointer — `todoOverlay` is already set.
		if (todoOverlay === undefined) {
			todoOverlay = new TodoOverlay();
			setActiveRenderSession(id);
		}
		// Only the foreground re-binds/refreshes the shared overlay. A child
		// (distinct sid) is skipped — does not rebind to a relay/stale ui.
		if (id !== getActiveRenderSession()) return;
		todoOverlay.setUICtx(ctx.ui);
		todoOverlay.resetCompletedDisplayState();
		todoOverlay.update();
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Auto-compaction races session disposal: pi-core invalidates the
		// extension runner while still emitting session_compact, so `ctx` may be
		// a dead proxy whose getters throw the stale error. The compacting session
		// is being discarded — the replacement session's session_start replays
		// state — so keep current state on a stale ctx. Other errors are real
		// replay bugs and must propagate. The render below is sid-gated so a child
		// compacting never refreshes the foreground overlay.
		let isForeground = false;
		try {
			const id = sid(ctx);
			replaceState(id, replayFromBranch(ctx));
			isForeground = id === getActiveRenderSession();
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		if (isForeground) {
			todoOverlay?.resetCompletedDisplayState();
			todoOverlay?.update();
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		let isForeground = false;
		try {
			const id = sid(ctx);
			replaceState(id, replayFromBranch(ctx));
			isForeground = id === getActiveRenderSession();
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		if (isForeground) {
			todoOverlay?.resetCompletedDisplayState();
			todoOverlay?.update();
		}
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
			todoOverlay?.dispose();
			todoOverlay = undefined;
			clearActiveRenderSession();
		}
	});

	// Reads getTodos() at render time; do NOT call replayFromBranch here
	// (branch is stale — message_end runs after tool_execution_end).
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		todoOverlay?.update();
	});

	pi.on("agent_start", async () => {
		todoOverlay?.hideCompletedTasksFromPreviousTurn();
	});
}
