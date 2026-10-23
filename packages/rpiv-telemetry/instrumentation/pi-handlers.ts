import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	AgentEndEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	LlmRequestEndEvent,
	LlmRequestStartEvent,
	MessageEndEvent,
	ModelSelectEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	TelemetryEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../types/events.ts";
import { finalizeTelemetrySession } from "./finalize.ts";
import { detectSubAgentType, parentSessionIdFromCtx, summarizeLlmPayload } from "./payload-summary.ts";
import {
	currentSubAgentType,
	llmPayloadMode,
	requestSeqBySession,
	setCurrentSessionId,
	setCurrentSubAgentTypeIfUnset,
} from "./state.ts";

/**
 * One row per Pi lifecycle event subscribed via `pi.on(...)`. The `build`
 * function maps the raw payload into the canonical TelemetryEvent.
 * `postDispatch` owns side effects past the dispatch (used only for
 * `session_shutdown` to finalize the session).
 *
 * Pi event payload types vary per event; the row uses `any` for the inbound
 * shape and lets `satisfies <Event>Event` enforce the outbound contract.
 */
export interface PiHandlerSpec {
	piEvent: string;
	build: (event: any, ctx: ExtensionContext) => TelemetryEvent;
	postDispatch?: (event: any, ctx: ExtensionContext) => Promise<void>;
}

const sid = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId() ?? "";

export const PI_HANDLERS: readonly PiHandlerSpec[] = [
	{
		piEvent: "session_start",
		build: (event, ctx) => {
			const id = sid(ctx);
			setCurrentSessionId(id);
			return {
				kind: "session_start",
				sessionId: id,
				reason: event.reason,
				timestamp: Date.now(),
			} satisfies SessionStartEvent;
		},
	},
	{
		piEvent: "session_compact",
		build: (event, ctx) =>
			({
				kind: "session_compact",
				sessionId: sid(ctx),
				fromExtension: event.fromExtension,
				timestamp: Date.now(),
			}) satisfies SessionCompactEvent,
	},
	{
		piEvent: "session_shutdown",
		build: (event, ctx) =>
			({
				kind: "session_shutdown",
				sessionId: sid(ctx),
				reason: event.reason,
				timestamp: Date.now(),
			}) satisfies SessionShutdownEvent,
		postDispatch: async () => {
			// Pi's ExtensionRunner awaits each handler, so this await is safe.
			await finalizeTelemetrySession();
		},
	},
	{
		piEvent: "before_agent_start",
		build: (event, ctx) => {
			// Sub-agent type is stable for a Pi process — detect once from the
			// `<active_agent name="...">` tag pi-subagents stamps onto sub-agent
			// system prompts, and reuse for every subsequent agent_start.
			setCurrentSubAgentTypeIfUnset(detectSubAgentType(event.systemPrompt));
			return {
				kind: "before_agent_start",
				sessionId: sid(ctx),
				prompt: event.prompt,
				timestamp: Date.now(),
			} satisfies BeforeAgentStartEvent;
		},
	},
	{
		piEvent: "agent_start",
		build: (_event, ctx) =>
			({
				kind: "agent_start",
				sessionId: sid(ctx),
				selfAgentType: currentSubAgentType,
				// Pi-native lineage from SessionHeader.parentSession — set by
				// pi-subagents on the spawned session. Deterministic, no
				// heuristic pairing needed.
				parentSessionId: parentSessionIdFromCtx(ctx),
				timestamp: Date.now(),
			}) satisfies AgentStartEvent,
	},
	{
		piEvent: "agent_end",
		build: (event, ctx) =>
			({
				kind: "agent_end",
				sessionId: sid(ctx),
				messageCount: event.messages?.length ?? 0,
				timestamp: Date.now(),
			}) satisfies AgentEndEvent,
	},
	{
		piEvent: "turn_start",
		build: (event, ctx) =>
			({
				kind: "turn_start",
				sessionId: sid(ctx),
				turnIndex: event.turnIndex,
				timestamp: event.timestamp,
			}) satisfies TurnStartEvent,
	},
	{
		piEvent: "turn_end",
		build: (event, ctx) => {
			const msg = event.message;
			const isAssistant = msg?.role === "assistant";
			const usage = isAssistant
				? {
						input: msg.usage.input,
						output: msg.usage.output,
						totalTokens: msg.usage.totalTokens,
						cost: msg.usage.cost?.total,
					}
				: undefined;
			return {
				kind: "turn_end",
				sessionId: sid(ctx),
				turnIndex: event.turnIndex,
				stopReason: isAssistant ? msg.stopReason : undefined,
				usage,
				toolResultCount: event.toolResults?.length ?? 0,
				timestamp: Date.now(),
			} satisfies TurnEndEvent;
		},
	},
	{
		piEvent: "tool_execution_start",
		build: (event, ctx) =>
			({
				kind: "tool_execution_start",
				sessionId: sid(ctx),
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				timestamp: Date.now(),
			}) satisfies ToolExecutionStartEvent,
	},
	{
		piEvent: "tool_execution_end",
		build: (event, ctx) =>
			({
				kind: "tool_execution_end",
				sessionId: sid(ctx),
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
				timestamp: Date.now(),
			}) satisfies ToolExecutionEndEvent,
	},
	{
		piEvent: "model_select",
		build: (event, ctx) =>
			({
				kind: "model_select",
				sessionId: sid(ctx),
				modelId: event.model.id,
				modelProvider: event.model.provider,
				source: event.source,
				timestamp: Date.now(),
			}) satisfies ModelSelectEvent,
	},
	{
		piEvent: "before_provider_request",
		build: (event, ctx) => {
			const sessionId = sid(ctx);
			const seq = (requestSeqBySession.get(sessionId) ?? 0) + 1;
			requestSeqBySession.set(sessionId, seq);
			let payload: unknown;
			let summarized = false;
			if (llmPayloadMode === "full") {
				payload = event.payload;
			} else if (llmPayloadMode === "summary") {
				payload = summarizeLlmPayload(event.payload);
				summarized = true;
			}
			return {
				kind: "llm_request_start",
				sessionId,
				requestSeq: seq,
				payload,
				summarized: summarized || undefined,
				timestamp: Date.now(),
			} satisfies LlmRequestStartEvent;
		},
	},
	{
		piEvent: "after_provider_response",
		build: (event, ctx) => {
			const sessionId = sid(ctx);
			const seq = requestSeqBySession.get(sessionId) ?? 0;
			return {
				kind: "llm_request_end",
				sessionId,
				requestSeq: seq,
				status: event.status,
				headers: event.headers,
				timestamp: Date.now(),
			} satisfies LlmRequestEndEvent;
		},
	},
	{
		piEvent: "message_end",
		build: (event, ctx) => {
			const m = event.message;
			const usage =
				m.role === "assistant"
					? {
							input: m.usage.input,
							output: m.usage.output,
							cacheRead: m.usage.cacheRead,
							cacheWrite: m.usage.cacheWrite,
							totalTokens: m.usage.totalTokens,
							cost: m.usage.cost?.total,
						}
					: undefined;
			return {
				kind: "message_end",
				sessionId: sid(ctx),
				role: m.role,
				model: m.role === "assistant" ? m.model : undefined,
				provider: m.role === "assistant" ? (m.provider as string) : undefined,
				stopReason: m.role === "assistant" ? m.stopReason : undefined,
				usage,
				timestamp: Date.now(),
			} satisfies MessageEndEvent;
		},
	},
];
