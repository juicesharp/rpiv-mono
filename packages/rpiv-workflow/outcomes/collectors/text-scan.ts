/**
 * The neutral text-scan primitive — scan assistant text (reverse) for `pattern`,
 * then, on a miss, tool-call arguments (the agent's recorded actions), fatal
 * only when BOTH surfaces miss, single `role: "primary"` artifact via `toHandle`.
 * The shared body `transcriptPathCollector` and `urlCollector` share here
 * (byte-identical modulo the handle constructor + the "path"/"URL" noun). Build
 * domain-specific collectors by wrapping this + supplying a pattern + handle
 * constructor (`directoryPathCollector` already delegates this way to
 * `transcriptPathCollector`).
 *
 * Fatal when no match is found on either surface — produces stages that wire
 * this promise an output, and silently returning zero artifacts hides the
 * agent's failure mode behind a stale primary-artifact. The tool-argument
 * fallback exists because the actionable string can ride a write tool-call's
 * input (the recorded action) while the spoken announcement is mangled or
 * typo'd — the two surfaces disagree in BOTH directions, so the union of both
 * is the honest "what did the agent actually produce" scan. The tool-arg
 * fallback can be narrowed per tool call via the optional `match` predicate —
 * no default; the primitive stays host-agnostic (tool-name conventions live
 * in wrapping layers, never here).
 */

import type { ArtifactHandle } from "../../handle.js";
import type { ArtifactCollector } from "../../output-spec.js";
import { defineCollector } from "../../output-spec.js";
import { type BranchEntry, iterToolUses, lastMatchInBranch } from "../../transcript.js";
import { requireOpt } from "./require-opt.js";
import type { ToolCall } from "./tool-call.js";

export interface TextScanCollectorOpts {
	/**
	 * Pattern to match against assistant text (and, on a text miss, tool-call
	 * argument values). REQUIRED — the framework has no default (layouts are
	 * project-specific). Use `g` to scan for all matches per block (helper takes
	 * the last); without `g`, only the first per block.
	 */
	pattern: RegExp;
	/** Constructs the artifact handle from the matched string (e.g. `fs`, `url`). */
	toHandle: (hit: string) => ArtifactHandle;
	/** Noun for the fatal-on-miss message ("path" / "URL"). */
	noun: string;
	/**
	 * Narrows the tool-argument fallback to matching tool calls (the
	 * assistant-text scan is unaffected). No default — the primitive stays
	 * host-agnostic; a convention layer pins tool names via this predicate.
	 */
	match?: (tc: ToolCall) => boolean;
	/**
	 * Narrows the tool-argument fallback to these argument KEYS of a matching
	 * call (e.g. `["path"]` so a `write` call's `content` — which may quote a
	 * sibling artifact's path — can never outrank the path it actually wrote
	 * to). Absent ⇒ every string-valued argument is scanned, as before. Must be
	 * a non-empty array of strings when provided (construction-time guard).
	 */
	argKeys?: readonly string[];
}

/** Last match of `pattern` against the branch's tool-use INPUT values — the
 *  fallback surface. Forward scan, last hit wins, mirroring the text scan's
 *  reverse-last-match semantics over the agent's recorded actions instead of
 *  its narration. `argKeys` restricts which argument values are consulted. */
function lastToolArgMatch(
	branch: BranchEntry[],
	pattern: RegExp,
	offsetStart?: number,
	match?: (tc: ToolCall) => boolean,
	argKeys?: readonly string[],
): string | undefined {
	let last: string | undefined;
	for (const use of iterToolUses(branch, offsetStart)) {
		if (match !== undefined && !match(use)) continue;
		for (const [key, value] of Object.entries(use.input)) {
			if (argKeys !== undefined && !argKeys.includes(key)) continue;
			if (typeof value !== "string") continue;
			const matches = value.match(pattern);
			if (matches !== null && matches.length > 0) last = matches[matches.length - 1];
		}
	}
	return last;
}

export function textScanCollector(opts: TextScanCollectorOpts): ArtifactCollector {
	requireOpt(
		"textScanCollector",
		"match",
		"must be a function when provided",
		opts.match === undefined || typeof opts.match === "function",
	);
	requireOpt(
		"textScanCollector",
		"argKeys",
		"must be a non-empty array of strings when provided",
		opts.argKeys === undefined ||
			(Array.isArray(opts.argKeys) && opts.argKeys.length > 0 && opts.argKeys.every((k) => typeof k === "string")),
	);
	const { pattern, toHandle, noun, match, argKeys } = opts;
	return defineCollector({
		collect: (ctx) => {
			const hit =
				lastMatchInBranch(ctx.branch, pattern, ctx.branchOffset) ??
				lastToolArgMatch(ctx.branch, pattern, ctx.branchOffset, match, argKeys);
			if (!hit) {
				return {
					kind: "fatal",
					message: `${ctx.skill} finished without producing a ${noun} matching ${pattern.source} (scanned assistant text and tool-call arguments)`,
				};
			}
			return { kind: "ok", artifacts: [{ handle: toHandle(hit), role: "primary" }] };
		},
	});
}
