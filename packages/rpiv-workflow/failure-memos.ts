/**
 * failure-memos.ts — bounded log of stage/unit failures, surfaced as an
 * additive prompt suffix on every subsequently-built stage/unit session.
 *
 * Two writers feed it: `recordFatalFailure` (the terminal path — first
 * failure wins) and `recordUnitHalt` (a collect-all fanout soft-halt). The
 * suffix is appended at the two session-construction chokepoints
 * (`buildSingleStageSession` + `buildUnitSession`). Zero memos ⇒ the suffix
 * is `""` ⇒ byte-identical prompt to a clean run.
 *
 * Leaf module: type-only imports of `RunState`/`FailureMemo` (types.js) and
 * `AuditContext` (audit-ctx.js), value import of `nowIso` (internal-utils.js).
 * No back-edges — the value-import DAG stays acyclic.
 */

import type { AuditContext } from "./audit-ctx.js";
import { nowIso } from "./internal-utils.js";
import type { FailureMemo, RunState } from "./types.js";

/**
 * Maximum number of memos retained on `RunState.failureMemos`. The array is
 * bounded so a long collect-all fanout with many failing units does not grow
 * the suffix without limit; the OLDEST entry is dropped when the cap is
 * exceeded. The rendered block lists at most this many, newest-first.
 */
export const MAX_FAILURE_MEMOS = 3;

/**
 * Maximum character length of a single memo's `errMsg`. Longer messages are
 * truncated to this length with a trailing ellipsis so the prompt suffix stays
 * bounded even when the failure reason is a multi-KB stack trace.
 */
export const MAX_FAILURE_MEMO_ERR_LEN = 500;

/**
 * Append a failure memo to `state.failureMemos`, bounded by `MAX_FAILURE_MEMOS`
 * (oldest dropped) and with `errMsg` length-bounded by `MAX_FAILURE_MEMO_ERR_LEN`.
 *
 * `stage` resolves to the unit's PARENT (machine identity) for a loop-unit
 * failure and to the audit `stageName` for a non-unit failure. `unitId` is set
 * only for a loop-unit failure (the unit's stable audit id).
 */
export function appendFailureMemo(state: RunState, audit: AuditContext, errMsg: string): void {
	const memo: FailureMemo = {
		stage: audit.unit?.parent ?? audit.stageName,
		...(audit.unit?.id ? { unitId: audit.unit.id } : {}),
		errMsg: truncateErr(errMsg),
		ts: nowIso(),
	};
	state.failureMemos.push(memo);
	if (state.failureMemos.length > MAX_FAILURE_MEMOS) {
		state.failureMemos.shift(); // drop oldest — newest memos win the bounded slot
	}
}

/**
 * Render the additive prompt suffix for `state.failureMemos`, newest-first.
 * Returns `""` when there are no memos so the host prompt is byte-identical to
 * a clean run (no separator, no fence, no newline).
 */
export function failureMemoSuffix(state: RunState): string {
	const memos = state.failureMemos;
	if (memos.length === 0) return "";
	const lines = [...memos]
		.reverse()
		.map((m) => `- ${m.unitId ? `${m.stage} (unit ${m.unitId})` : m.stage}: ${m.errMsg}`);
	return `\n\nPrior failures in this run (do not repeat these — the run already tried them and they failed):\n${lines.join("\n")}`;
}

/** Truncate `errMsg` to `MAX_FAILURE_MEMO_ERR_LEN` with a trailing ellipsis when longer. */
function truncateErr(errMsg: string): string {
	if (errMsg.length <= MAX_FAILURE_MEMO_ERR_LEN) return errMsg;
	return `${errMsg.slice(0, MAX_FAILURE_MEMO_ERR_LEN)}…`;
}
