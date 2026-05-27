/**
 * Branch-entry shape + predicates. `sessionManager.getBranch()` returns a
 * discriminated union from pi-coding-agent whose internal variants aren't
 * all re-exported; `readBranch(ctx)` is the single boundary that applies
 * the `as unknown as` cast — every consumer in the workflow module goes
 * through it.
 *
 * No artifact-path scanning lives here — discovery is the collector's
 * job (see `output-spec.ts:ArtifactCollector`). Collectors that scan the
 * transcript (`transcriptPathCollector`, `urlCollector`, `toolCallCollector`,
 * …) walk this shape themselves; `lastMatchInBranch` is the shared
 * "find the last regex match in assistant text" helper they reuse.
 */

/** Mirror of pi-ai's StopReason union — values pi attaches to AssistantMessage. */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/**
 * Normalised stop signal: `StopReason` plus `"noResponse"` for branches with
 * no assistant message at all (pi never set a reason because the model never
 * spoke). Pre-stopReason assistant messages collapse to `"stop"`.
 */
export type StopSignal = StopReason | "noResponse";

/** Single chokepoint that maps (hasAssistantMessage, lastAssistantStopReason) → StopSignal. */
export function classifyStop(branch: BranchEntry[], offsetStart?: number): StopSignal {
	if (!hasAssistantMessage(branch, offsetStart)) return "noResponse";
	return lastAssistantStopReason(branch, offsetStart) ?? "stop";
}

/**
 * One content part inside an assistant message. Pi's internal union
 * carries more variants than these two; we model the ones collectors
 * walk over and let unknown parts pass through structurally (every
 * field besides `type` is optional).
 *
 *   - `text` parts carry user-visible markdown via `text`.
 *   - `tool_use` parts carry a tool invocation: `name` + `input` (the
 *     JSON object the agent called the tool with).
 */
export type BranchContentPart = {
	type: string;
	text?: string;
	name?: string;
	input?: Record<string, unknown>;
};

export type BranchEntry = {
	type: string;
	message?: {
		role?: string;
		content?: BranchContentPart[];
		stopReason?: StopReason;
	};
};

/**
 * Read the current branch from `ctx.sessionManager`. SDK returns a discriminated
 * union with private discriminators; the cast is unavoidable but must live in
 * one place — calling `getBranch()` directly elsewhere bypasses the module's
 * type discipline.
 *
 * Tracked: when `@earendil-works/pi-coding-agent` exposes a public
 * `Branch.Entry` (or equivalent) type, switch to it and delete the local
 * `BranchEntry` narrowing above. Until then this cast is the single
 * documented coupling point to Pi's internal branch shape.
 */
export function readBranch(ctx: { sessionManager: { getBranch(): unknown } }): BranchEntry[] {
	return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
}

export function hasAssistantMessage(branch: BranchEntry[], offsetStart?: number): boolean {
	const start = Math.max(offsetStart ?? 0, 0);
	for (let i = start; i < branch.length; i++) {
		const e = branch[i]!;
		if (e.type === "message" && e.message?.role === "assistant") return true;
	}
	return false;
}

/** Undefined for empty branches or pre-stopReason assistant messages. */
export function lastAssistantStopReason(branch: BranchEntry[], offsetStart?: number): StopReason | undefined {
	const start = Math.max(offsetStart ?? 0, 0);
	for (let i = branch.length - 1; i >= start; i--) {
		const entry = branch[i]!;
		if (entry.type !== "message") continue;
		if (entry.message?.role !== "assistant") continue;
		return entry.message.stopReason;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Shared collector building blocks
// ---------------------------------------------------------------------------

/**
 * Scan assistant text blocks in reverse for `pattern`; return the last
 * match. Pure — no I/O. Used by `transcriptPathCollector`, `urlCollector`,
 * and any author building a transcript-scan collector.
 *
 * Reverse scan because the agent's final message is usually where the
 * actionable path/URL lands; iterating from the tail short-circuits on
 * the first hit. Thinking/tool_use blocks are ignored — only spoken
 * `text` parts count.
 *
 * `offsetStart` — continue-policy stages pass the prior branch length
 * so prior-stage entries don't leak into the result.
 *
 * The pattern's flags are caller-owned. `g` makes `String.match` return
 * every occurrence (this helper takes the last); without `g`, only the
 * first match in each block is considered. Both shapes work.
 */
export function lastMatchInBranch(branch: BranchEntry[], pattern: RegExp, offsetStart?: number): string | undefined {
	const start = Math.max(offsetStart ?? 0, 0);
	for (let i = branch.length - 1; i >= start; i--) {
		const entry = branch[i]!;
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j]!;
			if (part.type === "text" && typeof part.text === "string") {
				const matches = part.text.match(pattern);
				if (matches && matches.length > 0) return matches[matches.length - 1];
			}
		}
	}
	return undefined;
}

/**
 * Yield every tool_use part the assistant emitted in branch order
 * (forward — the typical "what did the agent do during this stage?"
 * scan direction). Pure — no I/O. `toolCallCollector` walks this to
 * apply the author's match/toArtifact pair.
 *
 * `offsetStart` — continue-policy stages pass the prior branch length.
 */
export function* iterToolUses(
	branch: BranchEntry[],
	offsetStart?: number,
): Generator<{ name: string; input: Record<string, unknown> }> {
	const start = Math.max(offsetStart ?? 0, 0);
	for (let i = start; i < branch.length; i++) {
		const entry = branch[i]!;
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part.type !== "tool_use") continue;
			if (typeof part.name !== "string") continue;
			yield { name: part.name, input: part.input ?? {} };
		}
	}
}
