/**
 * Identifies what triggered a workflow run. Recorded in the JSONL
 * header (`WorkflowHeader.trigger`), threaded into every lifecycle
 * event (`LifecycleContext.trigger`), and surfaced on past-run
 * enumeration (`RunSummary.trigger`).
 *
 * `/wf` sets `{ kind: "command", name: "wf" }`. Programmatic embedders
 * default to `{ kind: "programmatic" }`. External trigger sources
 * (webhook, cron, sibling-extension spawn) set `{ kind: "external",
 * source, ref? }` so post-hoc readers can filter / route by origin.
 *
 * `meta` is an open escape hatch for trigger-specific payload (webhook
 * headers, cron expression, ticket id). Kept untyped to avoid growing
 * the union per consumer.
 *
 * Concurrency note: Pi is single-active-session. External triggers
 * (cron, webhook, sibling-extension spawn) MUST gate their own
 * spawning if a run is already in flight — the runtime does not
 * enforce a process-wide mutex.
 */
export type RunTrigger =
	| { kind: "command"; name: string; meta?: Record<string, unknown> }
	| { kind: "programmatic"; source?: string; meta?: Record<string, unknown> }
	| { kind: "external"; source: string; ref?: string; meta?: Record<string, unknown> };

/** Default when `RunWorkflowOptions.trigger` is omitted. */
export const DEFAULT_TRIGGER: RunTrigger = { kind: "programmatic" };
