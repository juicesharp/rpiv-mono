/**
 * Session-backed resume continuation — runs INSIDE the interrupted stage's
 * reopened child session (the `withSession` callback of `reattachChildSession`,
 * which the host opens from the persisted session file; wired by
 * `resumeWithSessionLadder` in runner/run-stage.ts). Companion to `sessions.ts`,
 * reusing its exported pipeline pieces instead of duplicating them.
 *
 * Two arms, tried in order:
 *
 *  1. PROMOTION — adopt the session's existing branch and run the entire
 *     collector → parser → contract pipeline over it
 *     (`produceAndValidateOutput`, verbatim — including the frontmatter
 *     parser's disk-existence check). Success ⇒ a normal completed row via
 *     `recordStageSuccess` and the chain advances — the interrupted turn's
 *     work is adopted without sending anything. Deliberately NO
 *     `classifyStop` here: the old tail is an interrupted turn by
 *     definition; promotion only asks "did the artifact land".
 *
 *  2. REATTACH — on collector-fatal (the artifact pipeline found nothing),
 *     continue the session from its leaf with a nudge prompt, wait for the
 *     agent to settle, then run the standard `postStage` — from there the
 *     flow is byte-identical to live: stop classification, extraction
 *     (original offset, so a pre-interrupt announcement still counts),
 *     success persistence or halt. A second failure writes a normal
 *     failure row — itself session-backed, so the run stays resumable.
 *
 * Validation-exhausted from promotion halts exactly as live does.
 */

import { MSG_RESUME_PROMOTED, MSG_RESUME_REATTACHED, REATTACH_PROMPT } from "../messages.js";
import { readBranch, readSessionRef } from "../transcript.js";
import type { StageSession, WorkflowHostContext, WorkflowSessionContext } from "../types.js";
import { produceAndValidateOutput } from "./extraction.js";
import { haltStageWithValidationFailure, postStage, recordStageSuccess } from "./sessions.js";
import { branchOffsetFor, resendIntoChild } from "./spawn.js";

// Same two-ctx split as `postStage`: `obsCtx` is the long-lived launcher/observer
// (user-facing notifications + record + the chain continuation that spawns the
// next stage); `child` is the reopened persisted session (branch reads + the
// reattach nudge).
export async function reattachStageSession(
	obsCtx: WorkflowHostContext,
	child: WorkflowSessionContext,
	s: StageSession,
): Promise<void> {
	// Promotion: extraction over the adopted branch, scoped by the SAME
	// offset the interrupted activation ran under (persisted on its row and
	// threaded back via `s.branchOffset`; fresh stages scan the whole branch).
	const offset = branchOffsetFor(s.stage.sessionPolicy, s.branchOffset);
	const session = readSessionRef(child, offset);
	const result = await produceAndValidateOutput(child, s, readBranch(child), offset);

	if (result.kind === "ok") {
		obsCtx.ui.notify(MSG_RESUME_PROMOTED(s.skill), "info");
		if (!(await recordStageSuccess(obsCtx, s, result.output, session))) return;
		await s.onSuccess(obsCtx, result.output);
		return;
	}
	if (result.kind === "validation-exhausted") {
		return haltStageWithValidationFailure(obsCtx, s, result.failureSummary, session);
	}

	// Promotion missed (collector-fatal) — reattach: nudge the session from
	// its leaf, let the agent finish with full prior context, then run the
	// standard post-session pipeline.
	obsCtx.ui.notify(MSG_RESUME_REATTACHED(s.skill), "info");
	await resendIntoChild(child, REATTACH_PROMPT(s.skill));
	await postStage(obsCtx, child, s);
}
