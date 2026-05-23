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
