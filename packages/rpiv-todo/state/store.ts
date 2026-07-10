import type { Task } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * Per-session live state. Pre-refactor this was a single scalar `let state`
 * cell; it is now a Map partitioned by session id so a detached/child session
 * (distinct sid) can never read or clobber another session's tasks.
 *
 * The Map is the single mutation seam — only `commitState` / `replaceState` /
 * `evictSession` write it; the reducer (`state/state-reducer.ts`) stays pure.
 */
const sessions = new Map<string, TaskState>();

/**
 * Ctx-less render pointer: which slot do the ctx-free readers (the overlay's
 * `getSnapshot()`, the tool's `renderCall()`) render? Set when the first UI
 * session claims the foreground, before the overlay is loaded (creator-ownership
 * — see `index.ts`). A *distinct* concept from the three task-state mutation
 * seams; it is not a 4th writer of task state.
 */
let activeRenderSession = "";

/**
 * Session-id extractor. Structural ctx type (no Pi-runtime import) —
 * mirrors `replay.ts`'s ctx shape so `state/` stays Pi-import-free. Returns
 * `… ?? ""` so an unknown/empty session resolves to "" rather than undefined
 * (keeps the key a plain string for callers and the Phase 2 sid-gate).
 */
export function sid(ctx: { sessionManager: { getSessionId(): string } }): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

/** Fresh, non-aliasing EMPTY_STATE copy (never returns `EMPTY_STATE.tasks`). */
function freshState(): TaskState {
	return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

/** Get-or-read a session's slot: the committed slot by identity, or a fresh
 * EMPTY_STATE copy (not stored) when the slot is absent. */
function slotFor(sessionId: string): TaskState {
	return sessions.get(sessionId) ?? freshState();
}

/**
 * Live tasks accessor for a session. Returned `readonly Task[]` so callers
 * (overlay render hook, `/todos` command, `renderCall` subject lookup) cannot
 * mutate the live slot. Consumers must not cast back.
 */
export function getTodos(sessionId: string): readonly Task[] {
	return slotFor(sessionId).tasks;
}

export function getNextId(sessionId: string): number {
	return slotFor(sessionId).nextId;
}

/** Snapshot accessor used by reducer callers to pass canonical state in. */
export function getState(sessionId: string): TaskState {
	return slotFor(sessionId);
}

/**
 * Replay seam. Lifecycle handlers in `index.ts` call this on
 * `session_start` / `session_compact` / `session_tree` after
 * `replayFromBranch` decodes the latest snapshot, keyed to the session.
 */
export function replaceState(sessionId: string, next: TaskState): void {
	sessions.set(sessionId, next);
}

/**
 * Post-reducer commit seam. Tool `execute()` calls this with the reducer's
 * `state` output to publish the new canonical state to live readers (overlay,
 * `/todos`, `renderCall`), keyed to the calling session.
 */
export function commitState(sessionId: string, next: TaskState): void {
	sessions.set(sessionId, next);
}

/** Drop a session's slot on `session_shutdown`. No-op if the slot is absent. */
export function evictSession(sessionId: string): void {
	sessions.delete(sessionId);
}

/**
 * Ctx-less render reader: the slot the overlay / `renderCall` render.
 * Resolves to the `activeRenderSession` slot, or a fresh EMPTY_STATE copy when
 * no foreground has been set yet.
 */
export function getRenderState(): TaskState {
	return slotFor(activeRenderSession);
}

/** Set the ctx-less render pointer when the first UI session claims foreground. */
export function setActiveRenderSession(sessionId: string): void {
	activeRenderSession = sessionId;
}

/**
 * Reads the foreground render pointer — the sid the `index.ts` sid-gate compares
 * against, and the slot `getRenderState()` resolves to. Distinct from
 * `setActiveRenderSession` (the writer): Slice 1 only ever *set* the pointer;
 * Slice 2's gate must also *read* it, and foreground teardown must *clear* it.
 */
export function getActiveRenderSession(): string {
	return activeRenderSession;
}

/**
 * Foreground teardown (session_shutdown of the foreground session). Resets the
 * pointer to "" so the next `hasUI` session_start reclaims the foreground.
 */
export function clearActiveRenderSession(): void {
	activeRenderSession = "";
}

/**
 * Test-setup reset. Wired into the global `test/setup.ts` `beforeEach` via
 * the existing `__resetState` import path. Signature unchanged ⇒ no
 * `test/setup.ts` edit needed. Clears BOTH the session Map and the render
 * pointer so filesystem/detect resets start from a clean state.
 */
export function __resetState(): void {
	sessions.clear();
	activeRenderSession = "";
}
