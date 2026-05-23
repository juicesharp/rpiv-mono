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

/**
 * How the agent loop ended, normalised so consumers can switch exhaustively.
 *
 * Adds `"noResponse"` on top of pi-ai's `StopReason` to cover the case where
 * the branch has no assistant message at all — pi-ai never set a `stopReason`
 * because the model never spoke (e.g. session killed before the first turn).
 * That case shows up at the transport layer as `undefined`, but the
 * orchestrator needs a value it can switch on.
 *
 * Pre-stopReason assistant messages (legacy/empty field) collapse to `"stop"`,
 * matching the historical default before pi-ai attached the reason.
 */
export type StopSignal = StopReason | "noResponse";

/**
 * Inspect a branch and return the single signal the orchestrator should
 * branch on. Combines `hasAssistantMessage` + `lastAssistantStopReason` so
 * callers do not relitigate the "did the model speak / what reason did pi
 * attach" question at every site.
 */
export function classifyStop(branch: BranchEntry[], offsetStart?: number): StopSignal {
	if (!hasAssistantMessage(branch, offsetStart)) return "noResponse";
	return lastAssistantStopReason(branch, offsetStart) ?? "stop";
}

/**
 * Exhaustiveness helper for discriminated-union switches. Place at the
 * `default` arm of a switch over a closed union; the call is well-typed iff
 * every variant is handled. If a future union widening leaves a gap, the
 * argument fails to narrow to `never` and the build breaks at the call site —
 * forcing the gap to be addressed instead of silently fallen through.
 */
export function assertNever(value: never): never {
	throw new Error(`assertNever: unreachable value ${String(value)}`);
}

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
 *
 * When `offsetStart` is provided, only entries at or after that index are
 * scanned — used by "continue" stages to ignore entries from prior stages.
 */
export function extractArtifactPath(branch: BranchEntry[], offsetStart?: number): string | undefined {
	const start = Math.max(offsetStart ?? 0, 0);
	for (let i = branch.length - 1; i >= start; i--) {
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
 *
 * When `offsetStart` is provided, only entries at or after that index are
 * considered — used by "continue" stages to ignore entries from prior stages.
 */
export function hasAssistantMessage(branch: BranchEntry[], offsetStart?: number): boolean {
	const start = Math.max(offsetStart ?? 0, 0);
	for (let i = start; i < branch.length; i++) {
		const e = branch[i]!;
		if (e.type === "message" && e.message?.role === "assistant") return true;
	}
	return false;
}

/**
 * Stop reason on the LAST assistant message in the branch — the canonical
 * signal Pi gives us about how the agent loop ended. Pi's own bundled
 * `examples/extensions/subagent/index.ts` halts a chain when this value is
 * `"aborted"` (user pressed ESC) or `"error"` (LLM error); the runner uses
 * it the same way in `executeSession`.
 *
 * When `offsetStart` is provided, only entries at or after that index are
 * scanned — used by "continue" stages to ignore entries from prior stages.
 *
 * Returns undefined if the branch has no assistant message at all (caller
 * should treat that as a separate "no response" failure) or if the message
 * predates Pi's stopReason support.
 */
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
