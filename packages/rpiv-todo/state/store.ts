import type { Task } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * Module-level live state cell. Pre-refactor this lived as bare `tasks` /
 * `nextId` consts in `todo.ts`; centralizing here keeps the store as the
 * single mutation seam and lets the reducer remain pure.
 */
let state: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };

/**
 * Live tasks accessor. Returned `readonly Task[]` so callers (overlay render
 * hook, `/todos` command, `renderCall` subject lookup) cannot mutate the live
 * cell. Consumers must not cast back.
 */
export function getTodos(): readonly Task[] {
	return state.tasks;
}

export function getNextId(): number {
	return state.nextId;
}

/** Snapshot accessor used by reducer callers to pass canonical state in. */
export function getState(): TaskState {
	return state;
}

/**
 * Replay seam. Lifecycle handlers in `index.ts` call this on
 * `session_start` / `session_compact` / `session_tree` after
 * `replayFromBranch` decodes the latest snapshot.
 */
export function replaceState(next: TaskState): void {
	state = next;
}

/**
 * Post-reducer commit seam. Tool execute() calls this with the reducer's
 * `state` output to publish the new canonical state to live readers (overlay,
 * `/todos`, renderCall).
 */
export function commitState(next: TaskState): void {
	state = next;
}

/**
 * Test-setup reset. Wired into the global `test/setup.ts` `beforeEach` via
 * the existing `__resetState` import path. Name preserved verbatim — see
 * Plan §Decisions §Decision 7.
 */
export function __resetState(): void {
	state = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}
