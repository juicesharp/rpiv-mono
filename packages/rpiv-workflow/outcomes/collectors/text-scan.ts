/**
 * The neutral text-scan primitive — scan assistant text (reverse) for `pattern`,
 * fatal-on-miss, single `role: "primary"` artifact via `toHandle`. The shared
 * body `transcriptPathCollector` and `urlCollector` used to spell by hand
 * (byte-identical modulo the handle constructor + the "path"/"URL" noun).
 * Build domain-specific collectors by wrapping this + supplying a pattern +
 * handle constructor (`directoryPathCollector` already delegates this way to
 * `transcriptPathCollector`; the three now share one base scanner).
 *
 * Fatal when no match is found — produces stages that wire this
 * promise an output, and silently returning zero artifacts hides the
 * agent's failure mode behind a stale primary-artifact.
 */

import type { ArtifactHandle } from "../../handle.js";
import type { ArtifactCollector } from "../../output-spec.js";
import { defineCollector } from "../../output-spec.js";
import { lastMatchInBranch } from "../../transcript.js";

export interface TextScanCollectorOpts {
	/**
	 * Pattern to match against assistant text. REQUIRED — the framework has no
	 * default (layouts are project-specific). Use `g` to scan for all matches per
	 * block (helper takes the last); without `g`, only the first per block.
	 */
	pattern: RegExp;
	/** Constructs the artifact handle from the matched string (e.g. `fs`, `url`). */
	toHandle: (hit: string) => ArtifactHandle;
	/** Noun for the fatal-on-miss message ("path" / "URL"). */
	noun: string;
}

export function textScanCollector(opts: TextScanCollectorOpts): ArtifactCollector {
	const { pattern, toHandle, noun } = opts;
	return defineCollector({
		collect: (ctx) => {
			const hit = lastMatchInBranch(ctx.branch, pattern, ctx.branchOffset);
			if (!hit) {
				return {
					kind: "fatal",
					message: `${ctx.skill} finished without producing a ${noun} matching ${pattern.source}`,
				};
			}
			return { kind: "ok", artifacts: [{ handle: toHandle(hit), role: "primary" }] };
		},
	});
}
