/**
 * Branch-entry shape + predicates. `sessionManager.getBranch()` returns a
 * discriminated union from pi-coding-agent whose internal variants aren't
 * all re-exported; `readBranch(ctx)` is the single boundary that applies
 * the `as unknown as` cast — every consumer in the workflow module goes
 * through it.
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

/** Exhaustiveness guard for discriminated-union switches. */
export function assertNever(value: never): never {
	throw new Error(`assertNever: unreachable value ${String(value)}`);
}

export type BranchEntry = {
	type: string;
	message?: {
		role?: string;
		content?: Array<{ type: string; text?: string }>;
		stopReason?: StopReason;
	};
};

/**
 * Read the current branch from `ctx.sessionManager`. SDK returns a discriminated
 * union with private discriminators; the cast is unavoidable but must live in
 * one place — calling `getBranch()` directly elsewhere bypasses the module's
 * type discipline.
 */
export function readBranch(ctx: { sessionManager: { getBranch(): unknown } }): BranchEntry[] {
	return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
}

const ARTIFACT_PATH_REGEX = /\.rpiv\/artifacts\/[\w-]+\/[\w.-]+\.md/g;

/**
 * Last `.rpiv/artifacts/...` mentioned in assistant text content. Scans
 * messages + blocks in reverse. Thinking/tool_call blocks ignored —
 * artifact paths the user is meant to consume only appear in spoken text.
 *
 * `offsetStart` — continue stages pass the prior branch length so prior-
 * stage entries don't leak into the result.
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
