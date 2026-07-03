/**
 * Audit ctx + identity — the pure half of the audit layer.
 *
 * Moved out of `audit.ts` so the ctx construction this layer shares with the
 * runner + sessions has its own module, decoupled from the impure
 * terminal-outcome orchestration (`terminate`, the row writers, the notify
 * + lifecycle fires) that stayed behind in `audit.ts`. `audit.ts` re-exports
 * every symbol below, so existing `from "../audit.js"` import sites are
 * unchanged; new code imports directly from `audit-ctx.ts`.
 *
 * Depends on events (value: `skillStageRef`) + types + state (type-only).
 * Neither events nor the orchestrator imports back — one-way edges only.
 */

import { skillStageRef } from "./events.js";
import type { SessionRef } from "./state/index.js";
import type { RunContext, SessionContext, UnitRef } from "./types.js";

/**
 * Minimal bookkeeping ctx. Structurally derived from `SessionContext` so any
 * future field added to the base lands here too — no duplicate
 * maintenance. Every `StageSession` (single stage or loop unit) collapses to this.
 *
 * `isScript` toggles the `onStageError` ref construction in
 * `recordTerminalFailure` from `skillStageRef` to `scriptStageRef` (the
 * script branch carries no `skill` field). Defaulting to `undefined`
 * preserves the skill-path behaviour for every existing caller.
 *
 * `unit` is present iff the failure/cancellation belongs to a loop unit — its
 * identity is spread into the JSONL row so failed trailers carry the
 * structured fields the resume guard consumes.
 *
 * `session` is REQUIRED (`null` = explicitly sessionless) — the compiler
 * forces every audit-row writer to make the provenance decision; the value
 * lands verbatim on the JSONL row (`WorkflowStage.session`), which is what
 * session-backed resume dispatches on.
 */
export type AuditCtx = Pick<
	SessionContext,
	"cwd" | "runId" | "state" | "stageName" | "skill" | "lifecycle" | "runIdentity" | "allocatedStageNumber"
> & {
	session: SessionRef | null;
	isScript?: boolean;
	unit?: UnitRef;
};

/**
 * The read-only run identity (`workflow` name + `totalStages` + `trigger`)
 * threaded onto every `SessionContext` and `AuditCtx`. Single source for the
 * `runIdentity` sub-literal that session/audit constructions across the runner
 * would otherwise re-spell by hand.
 */
export function runIdentityOf(run: RunContext): SessionContext["runIdentity"] {
	return { workflow: run.workflow.name, totalStages: run.totalStages, trigger: run.trigger };
}

/**
 * Build the `AuditCtx` `recordTerminalFailure` needs for a stage failure that
 * escaped a session (preflight halts, downstream throws, routing errors,
 * resume-time refusals). One source for the shape so every halt path records
 * a uniform row. `isScript: true` drops the `skill` field from the JSONL row
 * and switches `onStageError` to `scriptStageRef`.
 *
 * `session` is pinned to `null` here BY CONSTRUCTION: every caller of this
 * builder records a failure that escaped (or never reached) a session —
 * preflight halts, seam aborts, entry throws, routing errors, resume drift,
 * script halts. In-session writers build their `AuditCtx` via `auditFor`
 * (sessions/sessions.ts), which threads the captured `SessionRef`.
 */
export function auditCtxFor(
	run: RunContext,
	stageName: string,
	skill: string,
	opts?: { isScript?: boolean; unit?: UnitRef; allocatedStageNumber?: number },
): AuditCtx {
	return {
		cwd: run.cwd,
		runId: run.runId,
		state: run.state,
		stageName,
		skill,
		session: null,
		lifecycle: run.lifecycle,
		runIdentity: runIdentityOf(run),
		...(opts?.isScript ? { isScript: true } : {}),
		...(opts?.unit ? { unit: opts.unit } : {}),
		...(opts?.allocatedStageNumber !== undefined ? { allocatedStageNumber: opts.allocatedStageNumber } : {}),
	};
}

/**
 * Lifecycle ref for the CURRENT activation — ONE numbering base (the
 * allocator value) for every event of one execution, so a listener can
 * correlate a retry ref with the end/error ref it belongs to. Valid once the
 * activation allocated its number (`allocatedStageNumber`); falls back to the
 * last allocated number for record-time allocators (failure paths that never
 * reached output production).
 */
export function currentStageRef(
	s: Pick<SessionContext, "stageName" | "skill" | "state" | "allocatedStageNumber">,
): ReturnType<typeof skillStageRef> {
	return skillStageRef(s.stageName, s.allocatedStageNumber ?? s.state.lastAllocatedStageNumber, s.skill);
}
