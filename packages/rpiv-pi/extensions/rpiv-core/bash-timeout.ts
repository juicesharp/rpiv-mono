/**
 * bash-timeout — a per-command wall-clock watchdog over a child AgentSession's bash
 * tool calls, the host's defense against a runaway command stranding a fan-out gate.
 *
 * A workflow stage runs in a detached child session (sdk-workflow-host); the SDK's
 * bash tool honours an AbortSignal but enforces NO timeout of its own, so a model that
 * issues e.g. `find / ...` blocks the unit for as long as the scan runs. A fan-out
 * gate finalizes only once EVERY unit settles, so one wedged bash freezes the whole
 * run with nothing to break it.
 *
 * `armBashWatchdog` subscribes to the child's `tool_execution_start`/`_end` stream and,
 * per bash call, arms a timer; the matching result disarms it. On expiry it records the
 * reason and `session.abort()`s — which signals the in-flight subprocess AND resolves
 * the turn with `stopReason:"aborted"`. The host exposes the recorded reason to the
 * runner via `WorkflowSessionContext.toolTimeout`, where `postStage` routes it to the
 * soft-halt gate (collect-all unit survives; non-fan-out stage fails terminally) rather
 * than re-dispatching the same command on resume.
 *
 * Per-command, not per-unit: the clock is the time a SINGLE bash call has been running,
 * so a stage may issue many quick commands without ever tripping it; only one that
 * overruns on its own does.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** The event the session's subscribe listener receives — derived from the SDK signature
 *  so this module imports no SDK event-type value (mirrors lane-streaming.ts). */
type AgentSessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

/** Only the slice of AgentSession the watchdog touches — keeps the unit test trivial to fake. */
type WatchableSession = Pick<AgentSession, "subscribe" | "abort">;

const DEFAULT_BASH_TOOL_TIMEOUT_MS = 180_000; // 3 min — tight enough to cut a wedged scan well before it strands a gate.
const MIN_BASH_TOOL_TIMEOUT_MS = 5_000; // a sub-5s ceiling would scythe ordinary commands.
const MAX_BASH_TOOL_TIMEOUT_MS = 30 * 60_000; // 30 min — the hard upper bound; mirrors MAX_VALIDATION_RETRY_TIMEOUT_MS in packages/rpiv-workflow/validation-bounds.ts (same 30-min value, separately owned).

/**
 * The resolved per-command ceiling: the 3-minute default, overridable via
 * `RPIV_BASH_TIMEOUT_MS` and clamped to [5s, 30min]. A non-numeric / non-positive
 * override falls back to the default. Resolved once at module load (env is fixed for a
 * process); tests pass an explicit `timeoutMs` to `armBashWatchdog` instead of mutating env.
 */
export const BASH_TOOL_TIMEOUT_MS = resolveBashTimeoutMs(process.env.RPIV_BASH_TIMEOUT_MS);

export function resolveBashTimeoutMs(raw: string | undefined): number {
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BASH_TOOL_TIMEOUT_MS;
	return Math.min(Math.max(parsed, MIN_BASH_TOOL_TIMEOUT_MS), MAX_BASH_TOOL_TIMEOUT_MS);
}

/**
 * `bashTimeoutReason` echoes the offending command capped at SNIPPET_MAX_LEN chars — the reason is
 * operator-grade one-line row text, so the command is truncated instead of flooding the row with a
 * runaway pipeline. The cap INCLUDES the trailing ellipsis; SNIPPET_ELLIPSIS_LEN is that ellipsis's
 * length — the ASCII three-period form (`...`), never the single-glyph one, for byte-stable row text.
 */
const SNIPPET_MAX_LEN = 120;
const SNIPPET_ELLIPSIS_LEN = 3;

/** Operator-grade row text — names the ceiling and echoes the offending command (truncated). */
export function bashTimeoutReason(command: string, timeoutMs: number): string {
	const secs = Math.round(timeoutMs / 1000);
	const snippet =
		command.length > SNIPPET_MAX_LEN ? `${command.slice(0, SNIPPET_MAX_LEN - SNIPPET_ELLIPSIS_LEN)}...` : command;
	return `bash command exceeded the ${secs}s per-command timeout and was aborted${snippet ? `: \`${snippet}\`` : ""}`;
}

export interface BashWatchdog {
	/** The recorded timeout reason once the watchdog has fired, else `undefined`. Wired to
	 *  `WorkflowSessionContext.toolTimeout` so the runner can divert the abort to soft-halt. */
	timedOut(): { reason: string } | undefined;
	/**
	 * Clear the recorded verdict (`fired` → undefined) AND every pending per-`toolCallId`
	 * timer WITHOUT unsubscribing — the `subscribe` listener stays live so a resumed turn's
	 * new bash `tool_execution_start` re-arms a fresh timer. The strike-recovery path calls
	 * this after consuming a strike (before re-prompting the child); `dispose()` (unsubscribe
	 * + clear) still runs in the per-stage `finally`. Mirrors `dispose()` minus the unsubscribe.
	 */
	reset(): void;
	/** Unsubscribe + clear any pending timers. The host calls this in its per-stage `finally`. */
	dispose(): void;
}

/**
 * Arm the watchdog on `session`. Returns a handle whose `timedOut()` reports the reason
 * (once) and whose `dispose()` tears the subscription + timers down. The FIRST overrun
 * wins — concurrent bash calls (parallel tool execution) each get their own timer, but
 * only one abort + reason is recorded.
 */
export function armBashWatchdog(session: WatchableSession, timeoutMs: number = BASH_TOOL_TIMEOUT_MS): BashWatchdog {
	let fired: { reason: string } | undefined;
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	const clear = (id: string): void => {
		const timer = timers.get(id);
		if (timer) {
			clearTimeout(timer);
			timers.delete(id);
		}
	};

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "tool_execution_start" && event.toolName === "bash") {
			const id = event.toolCallId;
			const command = typeof event.args?.command === "string" ? event.args.command : "";
			const timer = setTimeout(() => {
				timers.delete(id);
				if (fired) return; // first overrun wins — one abort, one reason.
				fired = { reason: bashTimeoutReason(command, timeoutMs) };
				void session.abort();
			}, timeoutMs);
			// Don't let a pending watchdog keep the event loop alive on its own.
			timer.unref?.();
			timers.set(id, timer);
		} else if (event.type === "tool_execution_end") {
			clear(event.toolCallId);
		}
	});

	return {
		timedOut: () => fired,
		// Recovery: clear the verdict + pending timers but KEEP the subscribe listener armed,
		// so the resumed turn's next bash call re-arms a fresh per-toolCallId timer. dispose()
		// (below) is the only path that unsubscribes.
		reset: () => {
			fired = undefined;
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
		},
		dispose: () => {
			unsubscribe();
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
		},
	};
}
