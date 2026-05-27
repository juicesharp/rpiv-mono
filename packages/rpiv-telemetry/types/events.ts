// ---------------------------------------------------------------------------
// TelemetryEvent — discriminated union for all Pi + sub-agent events
// ---------------------------------------------------------------------------

export type TelemetryEvent =
	| SessionStartEvent
	| SessionCompactEvent
	| SessionShutdownEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionEndEvent
	| ModelSelectEvent
	| LlmRequestStartEvent
	| LlmRequestEndEvent
	| MessageEndEvent
	| SubAgentCreatedEvent
	| SubAgentStartedEvent
	| SubAgentCompletedEvent
	| SubAgentFailedEvent
	| SubAgentCompactedEvent
	| SubAgentSteeredEvent;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** Fields present on every telemetry event. */
export interface TelemetryEventBase {
	sessionId: string;
	timestamp: number;
}

/** Unified token-usage shape. Optional cache + cost fields ride alongside the always-reported input/output/total counts. */
export interface LlmUsage {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens: number;
	cost?: number;
}

// -- Pi lifecycle events --

export interface SessionStartEvent extends TelemetryEventBase {
	kind: "session_start";
	reason: "startup" | "reload" | "new" | "resume" | "fork";
}

export interface SessionCompactEvent extends TelemetryEventBase {
	kind: "session_compact";
	fromExtension: boolean;
}

export interface SessionShutdownEvent extends TelemetryEventBase {
	kind: "session_shutdown";
	reason: "quit" | "reload" | "new" | "resume" | "fork";
}

export interface BeforeAgentStartEvent extends TelemetryEventBase {
	kind: "before_agent_start";
	prompt?: string;
}

export interface AgentStartEvent extends TelemetryEventBase {
	kind: "agent_start";
}

export interface AgentEndEvent extends TelemetryEventBase {
	kind: "agent_end";
	messageCount: number;
}

export interface TurnStartEvent extends TelemetryEventBase {
	kind: "turn_start";
	turnIndex: number;
}

export interface TurnEndEvent extends TelemetryEventBase {
	kind: "turn_end";
	turnIndex: number;
	stopReason?: string;
	usage?: LlmUsage;
	toolResultCount?: number;
}

export interface ToolExecutionStartEvent extends TelemetryEventBase {
	kind: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args?: unknown;
}

export interface ToolExecutionEndEvent extends TelemetryEventBase {
	kind: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result?: unknown;
	isError: boolean;
}

export interface ModelSelectEvent extends TelemetryEventBase {
	kind: "model_select";
	modelId: string;
	modelProvider: string;
	source: "set" | "cycle" | "restore";
}

// -- Sub-agent EventBus events --

export interface SubAgentCreatedEvent extends TelemetryEventBase {
	kind: "subagent_created";
	agentId: string;
	agentType: string;
	description?: string;
	isBackground?: boolean;
}

export interface SubAgentStartedEvent extends TelemetryEventBase {
	kind: "subagent_started";
	agentId: string;
	agentType: string;
}

export interface SubAgentCompletedEvent extends TelemetryEventBase {
	kind: "subagent_completed";
	agentId: string;
	status?: string;
	result?: string;
	durationMs: number;
	usage?: LlmUsage;
	toolUses?: number;
}

export interface SubAgentFailedEvent extends TelemetryEventBase {
	kind: "subagent_failed";
	agentId: string;
	status?: string;
	error: string;
	durationMs: number;
}

export interface SubAgentCompactedEvent extends TelemetryEventBase {
	kind: "subagent_compacted";
	agentId: string;
	agentType: string;
	reason?: string;
	tokensBefore?: number;
	compactionCount?: number;
}

export interface SubAgentSteeredEvent extends TelemetryEventBase {
	kind: "subagent_steered";
	agentId: string;
	message: string;
}

// -- LLM provider-request events (paired by requestSeq within a session) --

export interface LlmRequestStartEvent extends TelemetryEventBase {
	kind: "llm_request_start";
	requestSeq: number;
	/** Provider-shaped payload. Shape and presence are controlled by config.llmPayload ("full" | "summary" | "off"). */
	payload?: unknown;
	/** True when `payload` is a derived summary rather than the raw provider request. */
	summarized?: boolean;
}

export interface LlmRequestEndEvent extends TelemetryEventBase {
	kind: "llm_request_end";
	requestSeq: number;
	status: number;
	headers: Record<string, string>;
}

// -- Per-message finalize (carries assistant token usage) --

export interface MessageEndEvent extends TelemetryEventBase {
	kind: "message_end";
	/** Pi message role — covers the LLM trio (user/assistant/toolResult) plus Pi custom roles (custom, bashExecution, branchSummary, compactionSummary). */
	role: string;
	model?: string;
	provider?: string;
	stopReason?: string;
	usage?: LlmUsage;
}

// ---------------------------------------------------------------------------
// TelemetryEvent kind constants + type
// ---------------------------------------------------------------------------

/** All valid TelemetryEvent.kind values — used for config allowlist validation. */
export const TELEMETRY_EVENT_KINDS = [
	"session_start",
	"session_compact",
	"session_shutdown",
	"before_agent_start",
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"tool_execution_start",
	"tool_execution_end",
	"model_select",
	"llm_request_start",
	"llm_request_end",
	"message_end",
	"subagent_created",
	"subagent_started",
	"subagent_completed",
	"subagent_failed",
	"subagent_compacted",
	"subagent_steered",
] as const;

export type TelemetryEventKind = (typeof TELEMETRY_EVENT_KINDS)[number];
