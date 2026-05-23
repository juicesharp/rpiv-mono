/**
 * User-facing message constants for the /rpiv workflow runtime.
 *
 * Two channels:
 * - `STATUS_*`: persistent status-line text written via `ctx.ui.setStatus`.
 *   Survives the `newSession` transition.
 * - `MSG_*` / `ERR_*`: one-shot announcements via `ctx.ui.notify`. Some may be
 *   repainted by Pi's session transition; the persistent status line above
 *   guarantees the user always knows where the workflow currently is.
 *
 * No imports beyond TS primitives — safe to consume from any layer.
 */

/** Key under which the workflow writes its persistent status line. */
export const STATUS_KEY = "rpiv-workflow";

export const STATUS_STAGE = (stage: number, total: number, skill: string) => `rpiv: stage ${stage}/${total} — ${skill}`;

export const STATUS_PHASE = (stage: number, total: number, phase: number, phaseCount: number) =>
	`rpiv: stage ${stage}/${total} — implement (phase ${phase}/${phaseCount})`;

export const MSG_STAGE_COMPLETE = (skill: string) => `✓ ${skill} completed`;
export const MSG_STAGE_FAILED = (skill: string) => `✗ ${skill} failed — stopping workflow`;
export const MSG_STAGE_ABORTED = (skill: string) => `⏸ ${skill} aborted (ESC) — stopping workflow`;
export const MSG_STAGE_TRUNCATED = (skill: string) =>
	`✗ ${skill} truncated — model hit output cap mid-reply, stopping workflow`;
export const MSG_STAGE_TOOL_STALLED = (skill: string) => `✗ ${skill} tool loop did not settle — stopping workflow`;
export const MSG_STAGE_NO_RESPONSE = (skill: string) => `✗ ${skill} produced no response — stopping workflow`;

export const MSG_WORKFLOW_COMPLETE = (stages: number) => `rpiv: workflow complete (${stages} stages)`;
export const MSG_WORKFLOW_CANCELLED = "rpiv: workflow cancelled";

export const MSG_VALIDATION_RETRY = (skill: string, attempt: number) =>
	`rpiv: ${skill} output validation failed — asking agent to fix (attempt ${attempt})`;
export const MSG_VALIDATION_EXHAUSTED = (skill: string) => `rpiv: ${skill} output validation exhausted retries`;
export const ERR_VALIDATION_FAILED = (skill: string, failures: string) =>
	`${skill} output validation failed after retries: ${failures}`;

export const MSG_INPUT_VALIDATION_FAILED = (currentSkill: string, prevSkill: string) =>
	`✗ ${currentSkill} input validation failed — upstream ${prevSkill} produced invalid data`;
export const ERR_INPUT_VALIDATION_FAILED = (currentSkill: string, prevSkill: string, failures: string) =>
	`Input validation failed for '${currentSkill}': upstream '${prevSkill}' produced invalid data: ${failures}`;

/** Hard cap on backward-jump iterations (prevents infinite recursion). */
export const MAX_BACKWARD_JUMPS = 2;

export const MSG_BACKWARD_JUMP_EXHAUSTED = (jumps: number, max: number) =>
	`rpiv: backward-jump limit exceeded (${jumps}/${max}) — stopping workflow to prevent infinite loop`;

export const ERR_BACKWARD_JUMP_EXHAUSTED = (jumps: number, max: number) =>
	`Backward-jump limit exceeded: ${jumps} backward jumps (max ${max})`;
