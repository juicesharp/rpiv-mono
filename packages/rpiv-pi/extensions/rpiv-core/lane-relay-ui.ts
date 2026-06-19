/**
 * lane-relay-ui — a deferring, leak-proof ExtensionUIContext for a floated run's
 * foreground-contract stage (FR5).
 *
 * Under detachment the launcher root is "the foreground"; a floated run's
 * foreground stage must NOT grab the real UI (the user may be elsewhere). The
 * host binds this relay instead of the real ctx. A detached child must produce
 * ZERO visible effect at root unless the user has switched into its lane, so the
 * relay is an explicit allow-policy over the launcher ctx (Phase 7.1):
 *
 *   - `custom`        → DEFERRED: capture the factory + options + an unresolved
 *                       resolver into the registry and park the child's tool turn
 *                       (the stall is free — the child stays isStreaming, the slot
 *                       stays held). The switcher replays the factory on the real
 *                       UI on switch-in (lane-switcher.drainPendingInput) and
 *                       resolves the promise. Plus a one-shot "needs input" toast.
 *   - `notify`        → FOCUS-GATED: forwarded to the real ctx ONLY while the user
 *                       is switched into THIS lane (getFocusedRun() === runId);
 *                       otherwise dropped, so a parked/background child's notifies
 *                       ("Advisor restored", etc.) never reach root.
 *   - `setWidget` / `setStatus` / `setWorkingMessage` / `setHiddenThinkingLabel`
 *     / `pasteToEditor` → SUPPRESSED (no-op). Ambient surfaces never belong at
 *                       root; a child's TODO overlay / status / working-message
 *                       must not paint on the launcher. When switched in, the
 *                       lane's surface is the read-only viewer (getBranch()).
 *   - `onTerminalInput` → no-op unsubscribe: a child must never tap the launcher's
 *                       keystrokes (the run's abort tap uses the CAPTURED ui
 *                       directly in createWorkflowExecution, not this relay).
 *   - read-only members (`theme`, getters) and the rest → forwarded, `this`-bound.
 *
 * Direct blocking prompts (`confirm`/`input`/`select`/`editor`) stay forwarded:
 * workflow skills route human checkpoints through ask_user_question → `custom`
 * (deferred), so the residual is rare; deferring those is future work.
 *
 * A Proxy (not a hand-written delegate) keeps the relay drift-proof. The relay is
 * BRANDED (LANE_RELAY_BRAND) so the launcher's own session hooks
 * (session-capture, lane-switcher) can detect a detached-child session_start and
 * skip launcher-only work (Phase 7.2, isLaneRelayUiContext).
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { enqueueInput, getFocusedRun } from "./run-lane-registry.js";

/** Brand stamped on a relay so launcher-only session hooks can detect a detached
 *  child's ctx.ui and skip (session-capture / lane-switcher, Phase 7.2). */
const LANE_RELAY_BRAND = Symbol.for("rpiv:laneRelayUiContext");

/** True when `ui` is a lane relay (a detached child's bound ctx.ui). */
export function isLaneRelayUiContext(ui: unknown): boolean {
	return typeof ui === "object" && ui !== null && (ui as Record<symbol, unknown>)[LANE_RELAY_BRAND] === true;
}

/** Ambient-surface mutators a child must never apply to the launcher — suppressed. */
const SUPPRESSED_AT_ROOT = new Set<string>([
	"setWidget",
	"setStatus",
	"setWorkingMessage",
	"setHiddenThinkingLabel",
	"pasteToEditor",
]);

export function createLaneRelayUiContext(real: ExtensionUIContext, runId: string): ExtensionUIContext {
	const relayCustom: ExtensionUIContext["custom"] = (factory, options) =>
		new Promise((resolve) => {
			// Queue the request (notifies → ambient overlay shows the ⚑ needs-input badge)
			// and toast once so the user knows a background run is waiting on them. This
			// toast is the LAUNCHER's own signal (not a child notify) — it always fires.
			enqueueInput(runId, { factory, options, resolve: resolve as (r: unknown) => void });
			real.notify("⚑ a background run needs input — /lanes to switch in", "warning");
		});

	// Forwarded to the real ctx ONLY while the user is switched into THIS lane.
	const focusedNotify: ExtensionUIContext["notify"] = (message, level) => {
		if (getFocusedRun() === runId) real.notify(message, level);
	};

	const noop = (): void => {};
	const noopUnsub = (): (() => void) => () => {};

	return new Proxy(real, {
		get(target, prop) {
			if (prop === LANE_RELAY_BRAND) return true;
			if (prop === "custom") return relayCustom;
			if (prop === "notify") return focusedNotify;
			if (prop === "onTerminalInput") return noopUnsub;
			if (typeof prop === "string" && SUPPRESSED_AT_ROOT.has(prop)) return noop;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
