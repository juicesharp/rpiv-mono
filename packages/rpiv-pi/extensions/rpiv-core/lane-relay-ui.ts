/**
 * lane-relay-ui — a deferring, leak-proof ExtensionUIContext for a floated run's
 * foreground-contract stage.
 *
 * Under detachment the launcher root is "the foreground"; a floated run's
 * foreground stage must NOT grab the real UI (the user may be elsewhere). The
 * host binds this relay instead of the real ctx. A detached child must produce
 * ZERO visible effect at root unless the user has switched into its lane, so the
 * relay is an explicit allow-policy over the launcher ctx:
 *
 *   - `custom`        → DEFERRED: capture the factory + options + an unresolved
 *                       resolver into the registry and park the child's tool turn
 *                       (the stall is free — the child stays isStreaming, the slot
 *                       stays held). The switcher replays the factory on the real
 *                       UI on switch-in (lane-switcher.drainPendingInput) and
 *                       resolves the promise. The enqueue notifies the registry, so
 *                       the always-on dock surfaces the ⚑ needs-input signal — no
 *                       separate chat toast (it would be redundant with the dock).
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
 * skip launcher-only work (isLaneRelayUiContext). The brand is reported as an own
 * enumerable key (ownKeys/getOwnPropertyDescriptor traps), so it SURVIVES a host
 * that re-wraps ctx.ui by spread — pi ≥0.84.4's wrapUIPromptContext does exactly
 * that, and a get-trap-only brand would silently un-gate every child.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { enqueueInput, getFocusedRun } from "./run-lane-registry.js";

/** Brand stamped on a relay so launcher-only session hooks can detect a detached
 *  child's ctx.ui and skip (session-capture / lane-switcher). */
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

export function createLaneRelayUiContext(
	real: ExtensionUIContext,
	runId: string,
	/** The depth-gated unit key the host bound this relay to (a fan-out index, or the
	 *  reserved single-unit key for a non-fan-out / nested child). A deferred question
	 *  enqueues onto THIS unit so it flags its own dock sub-row and "answer" drains only
	 *  its queue. */
	unitIndex: number,
): ExtensionUIContext {
	const relayCustom: ExtensionUIContext["custom"] = (factory, options) =>
		new Promise((resolve) => {
			// Queue onto this unit — notifies the registry, so the dock surfaces the ⚑ on
			// the unit's own sub-row (and the lane's aggregate heading) and ages it via the
			// heartbeat. The persistent dock IS the signal; a separate chat toast here
			// would be redundant with it, so we don't emit one.
			enqueueInput(runId, unitIndex, { factory, options, resolve: resolve as (r: unknown) => void });
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
		// Spread survival — pi ≥0.84.4 wraps every extension's ctx.ui via `{...ui}`
		// (wrapUIPromptContext, the ui_prompt_start/end feature; upstream #8829). A
		// spread enumerates OWN keys, so a brand served only by the `get` trap would
		// vanish from the copy, `isLaneRelayUiContext` would return false in every
		// detached child, and the launcher-only session hooks (lane-switcher,
		// session-capture) would run against the child's relay — hijacking the dock
		// editor and foreground capture. Reporting the brand as an own ENUMERABLE key
		// makes `{...relayProxy}` carry `[LANE_RELAY_BRAND]: true`; the relay's
		// behavioral overrides need no help (the spread `get`s them through the proxy).
		ownKeys(target) {
			const keys = Reflect.ownKeys(target);
			// A duplicate entry in an ownKeys result is a TypeError — guard the
			// (never-expected) case of an already-branded target.
			return keys.includes(LANE_RELAY_BRAND) ? keys : [...keys, LANE_RELAY_BRAND];
		},
		getOwnPropertyDescriptor(target, prop) {
			// `configurable: true` is REQUIRED by the Proxy invariant for a key the
			// target does not itself own.
			if (prop === LANE_RELAY_BRAND) return { value: true, writable: false, enumerable: true, configurable: true };
			return Reflect.getOwnPropertyDescriptor(target, prop);
		},
	});
}
