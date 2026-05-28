/** `Date.now()` (ms) → MLflow's expected nanosecond integer. */
export function msToNs(ms: number): number {
	return ms * 1_000_000;
}

/** Composite key for tool spans: pairs sessionId + toolCallId so cleanup can scope by session. */
export function toolSpanKey(sessionId: string, toolCallId: string): string {
	return `${sessionId}\0${toolCallId}`;
}

/** Composite key for LLM-request spans: pairs sessionId + requestSeq. */
export function llmSpanKey(sessionId: string, requestSeq: number): string {
	return `${sessionId}\0${requestSeq}`;
}

/** Prefix used by session-scoped sweeps. Matches the prefix of every composite key for the session. */
export function sessionPrefix(sessionId: string): string {
	return `${sessionId}\0`;
}
