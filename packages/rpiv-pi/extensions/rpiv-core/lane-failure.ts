/**
 * lane-failure — pure helpers for rendering a run's terminal failure reason.
 *
 * The reason string is rpiv-workflow's `termination.error` (types.ts) — the SAME
 * text that lands in the JSONL trail's `errMsg` (messages.ts `FailureText.error`),
 * so the dock chip / viewer header / toast can never drift from the audit record.
 * This module invents NO message text; it only TRIMS the existing string for the
 * width-constrained dock chip, leaving the full string for the viewer header.
 */

/** Separator FailureText uses between the headline clause and its elaboration. */
const CLAUSE_SEPARATOR = " — ";

/**
 * The leading clause of a terminal failure reason — the headline a width-budgeted
 * dock chip shows (the full string stays for the viewer header). Cuts at the first
 * ` — ` separator (the form every `FailureText.error` uses) so a long elaboration
 * is dropped before the row even reaches its width budget; falls back to the whole
 * (trimmed) string when there is no separator. Returns undefined for an empty/absent
 * reason so callers can branch on "no reason to show".
 */
export function shortFailureReason(error: string | undefined): string | undefined {
	if (!error) return undefined;
	const trimmed = error.trim();
	if (!trimmed) return undefined;
	const clause = trimmed.split(CLAUSE_SEPARATOR)[0]?.trim();
	return clause || trimmed;
}
