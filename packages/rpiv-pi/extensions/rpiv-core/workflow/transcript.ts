/**
 * Transcript helpers — shape + predicates for a session's branch entries.
 *
 * `sessionManager.getBranch()` returns a discriminated union from pi-coding-agent
 * whose internal variants aren't all re-exported. We model the slice this
 * package reads with a narrow local interface and apply the `as unknown as`
 * cast at this single boundary so the runner never repeats the awkward dance.
 *
 * Pure functions, no I/O — safe to import from anywhere.
 */

/** Mirror of pi-ai's StopReason union — the values Pi attaches to AssistantMessage. */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/** The shape of a branch entry we care to read. */
export type BranchEntry = {
	type: string;
	message?: {
		role?: string;
		content?: Array<{ type: string; text?: string }>;
		stopReason?: StopReason;
	};
};

/** Regex matching artifact paths inside assistant text content. */
const ARTIFACT_PATH_REGEX = /\.rpiv\/artifacts\/[\w-]+\/[\w.-]+\.md/g;

/**
 * Extract the last artifact path produced by the assistant in this branch.
 * Scans assistant messages in reverse, then text blocks within each in reverse,
 * returning the last `.rpiv/artifacts/...` match. Returns undefined if none.
 *
 * Only text content blocks are scanned (thinking / tool_call blocks are ignored)
 * because artifact paths the user should consume only appear in spoken text.
 */
export function extractArtifactPath(branch: BranchEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type !== "message") continue;
		if (!entry.message || entry.message.role !== "assistant") continue;

		const content = entry.message.content;
		if (!Array.isArray(content)) continue;

		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j]!;
			if (part.type === "text" && part.text) {
				const matches = part.text.match(ARTIFACT_PATH_REGEX);
				if (matches && matches.length > 0) {
					return matches[matches.length - 1];
				}
			}
		}
	}
	return undefined;
}

/**
 * Whether the branch contains at least one assistant message. The runner uses
 * this as the "did the agent actually respond" predicate — an empty or
 * user-only branch means the session was killed before the model spoke.
 */
export function hasAssistantMessage(branch: BranchEntry[]): boolean {
	return branch.some((e) => e.type === "message" && e.message?.role === "assistant");
}

/**
 * Stop reason on the LAST assistant message in the branch — the canonical
 * signal Pi gives us about how the agent loop ended. Pi's own bundled
 * `examples/extensions/subagent/index.ts` halts a chain when this value is
 * `"aborted"` (user pressed ESC) or `"error"` (LLM error); the runner uses
 * it the same way in `executeSession`.
 *
 * Returns undefined if the branch has no assistant message at all (caller
 * should treat that as a separate "no response" failure) or if the message
 * predates Pi's stopReason support.
 */
export function lastAssistantStopReason(branch: BranchEntry[]): StopReason | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type !== "message") continue;
		if (entry.message?.role !== "assistant") continue;
		return entry.message.stopReason;
	}
	return undefined;
}
