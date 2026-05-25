/**
 * URL collector — scans assistant text for a URL and emits it as a
 * `url` handle (not `fs`). Use when the stage produces a remote
 * reference: a Linear ticket URL, a deployed-preview link, a posted
 * PR/comment, etc.
 *
 * Default `pattern` is RFC-3986-flavoured `https?://` — genuinely
 * universal (every protocol-bearing URL the agent prints in markdown
 * matches). Authors needing a narrower shape (only github.com, only
 * linear.app) pass their own RegExp.
 */

import { url } from "../../handle.js";
import type { ArtifactCollector } from "../../outcome-types.js";
import { defineCollector } from "../../outcome-types.js";
import { lastMatchInBranch } from "../../transcript.js";

/**
 * Conservative URL matcher — `https?://` plus non-whitespace, stopping
 * at common terminator characters (`<>"'` and trailing punctuation
 * the model often appends in prose). Not RFC-3986 strict; tuned for
 * the assistant-prose case rather than for validating arbitrary input.
 */
const DEFAULT_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g;

export interface UrlCollectorOpts {
	/** Override the default URL pattern (e.g. narrow to one host). */
	pattern?: RegExp;
}

export function urlCollector(opts: UrlCollectorOpts = {}): ArtifactCollector {
	const pattern = opts.pattern ?? DEFAULT_URL_PATTERN;
	return defineCollector({
		collect: (ctx) => {
			const href = lastMatchInBranch(ctx.branch, pattern, ctx.branchOffset);
			if (!href) {
				return {
					kind: "fatal",
					message: `${ctx.skill} finished without producing a URL matching ${pattern.source}`,
				};
			}
			return { kind: "ok", artifacts: [{ handle: url(href), role: "primary" }] };
		},
	});
}
