/**
 * Session opening — the child-spawn primitives every stage and loop unit runs
 * through. With every stage isolated in its own child session, "send into an
 * existing session" doesn't exist, so there's no stale-ctx fallback ladder,
 * no registry-host fallback param, and no defensive `sendUserMessage` guards.
 *
 * Three open modes, all routed through `ctx.spawnChild`:
 *   - FRESH (`spawnChildAndRun`)   — a brand-new child; the host sends the prompt.
 *   - REATTACH (`reattachChildSession`) — open a persisted file IN PLACE
 *     (session-backed resume); the host skips the prompt, the body promotes/nudges.
 *   - FORK (`forkChildSession`)    — copy a PREDECESSOR's persisted session into a
 *     NEW file carrying its full transcript (`sessionPolicy: "continue"`); the host
 *     skips the prompt, the body re-derives the inherited-prefix offset and sends
 *     the continuation turn. This is the detached continuation mechanism — prior-
 *     session lineage survives detachment via `SessionManager.forkFrom`, resolving
 *     the original OQ1 (which assumed it could not). The source file is never
 *     mutated, so DAG forks are safe and the continue child has its own resumable
 *     identity.
 */

import type { SessionPolicy } from "../api.js";
import type { StageSession, WorkflowHostContext, WorkflowSessionContext } from "../types.js";

/**
 * The per-policy branch offset — fresh ignores the stage-captured value;
 * continue flows it through so a continue stage's outcome still skips the prior
 * transcript its forked child inherited (trail / replay symmetry). The sole
 * surviving policy divergence.
 *
 * The `captured` value is sourced from the continuation's ACTUAL branch:
 *   - live (`continueStageSession`) re-derives it from the forked child's branch
 *     length before the continuation turn is sent, and threads it through `postStage`;
 *   - resume takes it from the persisted row (`SessionRef.branchOffset`) of the
 *     continue stage's own forked session.
 * Never the launcher's branch (the bug the fork redesign removed).
 */
export function branchOffsetFor(policy: SessionPolicy | undefined, captured: number | undefined): number | undefined {
	return policy === "continue" ? captured : undefined;
}

/** Optional open mode — absent ⇒ FRESH; `reattach` opens a persisted file in
 *  place; `fork` copies a predecessor's session into a new file. The two carry
 *  the same `{ sessionFile }` shape; only the host's open semantics differ. */
type OpenMode = { reattach: { sessionFile: string } } | { fork: { sessionFile: string } };

/**
 * THE child-spawn primitive every mode below reduces to. Open an isolated child
 * (parent stays valid) in the requested `mode`, let the host apply the
 * prompt/model/signal (+ reattach/fork), wait for the agent to settle, then run
 * `body` on the guaranteed-in-session child ctx. The await-idle-then-body
 * sequence — load-bearing for the IDLE-BEFORE-REPROMPT invariant — lives here
 * once, so the three named entries can't drift on it. Up to `ctx.maxConcurrency`
 * may be in flight (the loop's semaphore bounds fanout; single stages run one).
 */
function openChild(
	ctx: WorkflowHostContext,
	s: Pick<StageSession, "prompt" | "model" | "signal" | "laneUnitIndex">,
	body: (child: WorkflowSessionContext) => Promise<void>,
	mode?: OpenMode,
): Promise<void> {
	return ctx.spawnChild({
		prompt: s.prompt, // FRESH: host sends it. REATTACH/FORK: carried for parity; host skips auto-replay.
		model: s.model,
		signal: s.signal,
		// The lane key for a lane-aware host's per-unit slot — set only for fan-out units.
		// Undefined for sequential loop units / single stages / reattach / fork, all
		// of which map to the host's reserved single-unit slot so the lane row keeps
		// showing the one live session. Inert on a non-lane host.
		unitIndex: s.laneUnitIndex,
		...mode,
		withSession: async (child) => {
			await child.waitForIdle();
			await body(child);
		},
	});
}

/**
 * FRESH open. Open a brand-new isolated child session; the host sends the prompt
 * and applies the model. The default stage/loop-unit entry.
 */
export function spawnChildAndRun(
	ctx: WorkflowHostContext,
	s: Pick<StageSession, "prompt" | "model" | "signal" | "laneUnitIndex">,
	body: (child: WorkflowSessionContext) => Promise<void>,
): Promise<void> {
	return openChild(ctx, s, body);
}

/**
 * THE reattach primitive — the detached replacement for the deleted
 * live-session swap (`ctx.switchSession`). Spawn a child bound to the PERSISTED
 * session at `sessionFile` (the host opens it, no fresh creation, no initial `prompt`),
 * then run `body` on the in-session child ctx whose `getBranch` reflects the
 * prior transcript. `body` is `reattachStageSession` (sessions/reattach.ts),
 * which promotes from the loaded branch or nudges via `resendIntoChild`.
 *
 * `sessionFile` is supplied by the resume entry (a `locateSessionFile` hit), so
 * the host always has a real file; a missing/in-memory case is gated upstream.
 * There is NO `{ cancelled }` arm — a detached reattach has no live-session swap
 * for the user to dismiss.
 */
export function reattachChildSession(
	ctx: WorkflowHostContext,
	s: Pick<StageSession, "prompt" | "model" | "signal" | "laneUnitIndex">,
	sessionFile: string,
	body: (child: WorkflowSessionContext) => Promise<void>,
): Promise<void> {
	return openChild(ctx, s, body, { reattach: { sessionFile } });
}

/**
 * THE fork primitive — the detached continuation mechanism for
 * `sessionPolicy: "continue"`. Spawn a child by FORKING the PREDECESSOR's
 * persisted session at `sessionFile` (`SessionManager.forkFrom`: a new file +
 * new id carrying the predecessor's full transcript, source left intact), then
 * run `body` on the in-session child ctx whose `getBranch` reflects that prior
 * transcript. The host opens the fork and does NOT send the carried `prompt` —
 * `body` (`continueStageSession`, sessions.ts) measures the inherited prefix and
 * sends the continuation turn via `resendIntoChild`.
 *
 * `sessionFile` is the predecessor stage's persisted session (a
 * `locateSessionFile` hit gated by the caller, from `run.state.lastSession`), so
 * the host always has a real file. Distinct from `reattachChildSession` (which
 * opens the SAME file IN PLACE for resume): a fork must not mutate the
 * predecessor's file and gives the continue stage its own resumable identity.
 */
export function forkChildSession(
	ctx: WorkflowHostContext,
	s: Pick<StageSession, "prompt" | "model" | "signal" | "laneUnitIndex">,
	sessionFile: string,
	body: (child: WorkflowSessionContext) => Promise<void>,
): Promise<void> {
	return openChild(ctx, s, body, { fork: { sessionFile } });
}

/**
 * Re-prompt an already-open child and wait for it to settle — the
 * validation-retry path (`askAgentToFix`) and the resume reattach nudge.
 * The child ctx always exposes `sendUserMessage`, so no guard.
 *
 * IDLE-BEFORE-REPROMPT INVARIANT: uses `sendUserMessage` (which QUEUES, safe
 * mid-stream), NOT `prompt()` — the SDK THROWS "Agent is already processing" if
 * `prompt()` is called while streaming. Every entry point honors this:
 * `spawnChildAndRun` calls `waitForIdle()` before `body`, and the host's
 * `prompt()` is only the single initial send. Callers must never call a child's
 * `prompt()` again after the first; re-prompts go through `sendUserMessage` here.
 */
export async function resendIntoChild(child: WorkflowSessionContext, msg: string): Promise<void> {
	await child.sendUserMessage(msg);
	await child.waitForIdle();
}
