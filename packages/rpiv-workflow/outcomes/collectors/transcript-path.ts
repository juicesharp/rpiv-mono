/**
 * Transcript-path collector — the lowest-level text-scan primitive.
 *
 * Scans the assistant's spoken text (in reverse) for `pattern`, emits
 * the LAST match as a single `fs` artifact. Caller supplies the regex
 * verbatim — the framework knows zero about any project's layout
 * conventions. Build domain-specific collectors (rpiv-pi's
 * `rpivArtifactCollector`, an `adrCollector` for `docs/adr/...`, etc.) by
 * wrapping this and supplying the appropriate pattern.
 *
 * The pattern's `g` flag is honoured: with `g`, every occurrence in
 * each text block is considered (helper takes the last one); without
 * `g`, only the first per block. Authors who want N matches → N
 * artifacts compose with `unionCollectors` or write a bespoke collector.
 *
 * Fatal when no match is found — produces stages that wire this
 * promise an output, and silently returning zero artifacts hides the
 * agent's failure mode behind a stale primary-artifact.
 */

import { fs } from "../../handle.js";
import type { ArtifactCollector } from "../../output-spec.js";
import { defineCollector } from "../../output-spec.js";
import { lastMatchInBranch } from "../../transcript.js";

export interface TranscriptPathCollectorOpts {
	/**
	 * Pattern to match against assistant text. REQUIRED — the framework
	 * has no default (path layouts are project-specific). Use `g` to scan
	 * for all matches per block (helper takes the last); without `g`,
	 * only the first match per block is considered.
	 */
	pattern: RegExp;
}

export function transcriptPathCollector(opts: TranscriptPathCollectorOpts): ArtifactCollector {
	if (!(opts.pattern instanceof RegExp)) {
		throw new Error("transcriptPathCollector: `pattern` is required and must be a RegExp");
	}
	const pattern = opts.pattern;
	return defineCollector({
		collect: (ctx) => {
			const path = lastMatchInBranch(ctx.branch, pattern, ctx.branchOffset);
			if (!path) {
				return {
					kind: "fatal",
					message: `${ctx.skill} finished without producing a path matching ${pattern.source}`,
				};
			}
			return { kind: "ok", artifacts: [{ handle: fs(path), role: "primary" }] };
		},
	});
}
