import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { type LlmPayloadMode, loadTelemetryConfig } from "./config.js";
import { clearDispatcherState, dispatchTelemetryEvent, shutdownTelemetryDispatcher } from "./dispatcher.js";
import {
	type SubAgentCompactedPayload,
	SubAgentCompactedPayloadSchema,
	type SubAgentCompletedPayload,
	SubAgentCompletedPayloadSchema,
	type SubAgentCreatedPayload,
	SubAgentCreatedPayloadSchema,
	type SubAgentFailedPayload,
	SubAgentFailedPayloadSchema,
	type SubAgentStartedPayload,
	SubAgentStartedPayloadSchema,
	type SubAgentSteeredPayload,
	SubAgentSteeredPayloadSchema,
} from "./instrumentation/schemas.js";
import { registerConfiguredProviders } from "./providers/index.js";
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
	SubAgentCompactedEvent,
	SubAgentCompletedEvent,
	SubAgentCreatedEvent,
	SubAgentFailedEvent,
	SubAgentStartedEvent,
	SubAgentSteeredEvent,
	TelemetryEvent,
	TelemetryEventKind,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "./types/events.js";

// ---------------------------------------------------------------------------
// Module-level state — teardownTelemetry() clears for both shutdown and tests
// ---------------------------------------------------------------------------

const eventBusUnsubscribers: (() => void)[] = [];
/** Per-session monotonic counter — pairs before_provider_request ↔ after_provider_response. */
const requestSeqBySession = new Map<string, number>();
/** Capture of the loaded config's llmPayload knob; consulted in the before_provider_request handler. */
let llmPayloadMode: LlmPayloadMode = "off";

/**
 * In-flight sub-agents — populated on `subagents:created`/`started`, drained
 * on `subagents:completed`/`failed`. Anything left here at `session_shutdown`
 * never received a terminal EventBus event (the pi-subagents manager aborts
 * running agents during shutdown but those abort callbacks race the teardown
 * of our subscriptions). We synthesize `subagent_failed` for each survivor so
 * MLflow always shows a terminal trace instead of orphan "started" spans.
 */
interface InflightSubAgent {
	agentType?: string;
	startedAtMs: number;
	sessionId: string;
}
const inflightSubAgents = new Map<string, InflightSubAgent>();

/**
 * Shared teardown: unsubscribe EventBus handlers, reset dispatcher (also
 * clears registered providers).  Called from both the session_shutdown
 * handler and from tests for isolation.
 */
export function teardownTelemetry(): void {
	requestSeqBySession.clear();
	inflightSubAgents.clear();
	llmPayloadMode = "off";
	for (const unsub of eventBusUnsubscribers) {
		try {
			unsub();
		} catch {
			/* best-effort */
		}
	}
	eventBusUnsubscribers.length = 0;
	clearDispatcherState();
}

/**
 * Synthesize `subagent_failed` events for any in-flight sub-agent at shutdown.
 * Must run BEFORE shutdownTelemetryDispatcher() — once the dispatcher enters
 * its shutting-down state, dispatchTelemetryEvent() rejects further events.
 */
function flushOrphanSubAgents(): void {
	if (inflightSubAgents.size === 0) return;
	const now = Date.now();
	for (const [agentId, info] of inflightSubAgents) {
		dispatchTelemetryEvent({
			kind: "subagent_failed",
			sessionId: info.sessionId,
			agentId,
			status: "aborted",
			error: "session_shutdown",
			durationMs: now - info.startedAtMs,
			timestamp: now,
		} satisfies SubAgentFailedEvent);
	}
	inflightSubAgents.clear();
}

/**
 * Reduce a provider-shaped request body down to a small inspectable summary.
 * Duck-typed: covers Anthropic-messages, OpenAI-responses, and similar shapes.
 */
function summarizeLlmPayload(payload: unknown): Record<string, unknown> {
	if (!payload || typeof payload !== "object") return { type: typeof payload };
	const p = payload as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (typeof p.model === "string") out.model = p.model;
	if (Array.isArray(p.messages)) out.messageCount = p.messages.length;
	if (Array.isArray(p.tools)) out.toolCount = p.tools.length;
	if (typeof p.system === "string") out.systemBytes = (p.system as string).length;
	else if (Array.isArray(p.system)) out.systemBytes = JSON.stringify(p.system).length;
	if (typeof p.temperature === "number") out.temperature = p.temperature;
	if (typeof p.max_tokens === "number") out.maxTokens = p.max_tokens;
	if (typeof p.stream === "boolean") out.stream = p.stream;
	return out;
}

// ---------------------------------------------------------------------------
// Handler tables
//
// The plan calls for a single declarative table per source (Pi lifecycle +
// sub-agent EventBus). Each row holds the source identifier (`piEvent` /
// `channel`), the TelemetryEventKind it emits, and a `build` function that
// maps the raw payload into the canonical TelemetryEvent. The cross-cutting
// glue (sessionId injection, timestamp, dispatch) lives in the loop, not in
// each handler.
//
// `TELEMETRY_HANDLER_KINDS` is the snapshot manifest for tests — it must stay
// in sync with the rows below; the coverage test asserts it equals
// TELEMETRY_EVENT_KINDS.
// ---------------------------------------------------------------------------

/** Kinds emitted by initInstrumentation across both tables. Snapshot-tested against TELEMETRY_EVENT_KINDS. */
export const TELEMETRY_HANDLER_KINDS = [
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
] as const satisfies readonly TelemetryEventKind[];

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export function initInstrumentation(pi: ExtensionAPI): void {
	const config = loadTelemetryConfig();
	llmPayloadMode = config.llmPayload;

	// D3 fix: removed early return for empty providers. Always register all
	// handlers so late-registered providers (via registerTelemetryProvider)
	// receive events from the moment they register. The "no providers" check
	// is now in dispatchTelemetryEvent.

	registerConfiguredProviders(config);

	// Closure-scoped tracker for sub-agent EventBus handlers, which fire
	// without an ExtensionContext. Pi lifecycle handlers read sessionId
	// directly from `ctx.sessionManager` per dispatch.
	let currentSessionId = "";
	const sid = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId() ?? "";

	// -- Pi lifecycle handlers (14 rows) --
	//
	// Each row maps a `pi.on(<event>)` callback to a TelemetryEvent. Rows that
	// own side effects past the dispatch — session_shutdown's teardown — set
	// `postDispatch`. Pi event payload types vary per event; the table uses
	// `any` for the inbound shape and lets `satisfies <Event>Event` enforce
	// the outbound contract.

	interface PiHandlerSpec {
		piEvent: string;
		build: (event: any, ctx: ExtensionContext) => TelemetryEvent;
		postDispatch?: (event: any, ctx: ExtensionContext) => Promise<void>;
	}

	const PI_HANDLERS: readonly PiHandlerSpec[] = [
		{
			piEvent: "session_start",
			build: (event, ctx) => {
				currentSessionId = sid(ctx);
				return {
					kind: "session_start",
					sessionId: currentSessionId,
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
				// Synthesize terminal events for any sub-agent still in-flight —
				// these are about to be aborted by pi-subagents during shutdown
				// but their abort callbacks race our EventBus unsubscribe. Must
				// run BEFORE shutdownTelemetryDispatcher() since that flips the
				// dispatcher's shutting-down guard which rejects further events.
				flushOrphanSubAgents();
				// NOTE: Pi's ExtensionRunner awaits each handler, so this await is safe.
				await shutdownTelemetryDispatcher();
				// I2 fix: unsubscribe EventBus handlers during production shutdown
				teardownTelemetry();
			},
		},
		{
			piEvent: "before_agent_start",
			build: (event, ctx) =>
				({
					kind: "before_agent_start",
					sessionId: sid(ctx),
					prompt: event.prompt,
					timestamp: Date.now(),
				}) satisfies BeforeAgentStartEvent,
		},
		{
			piEvent: "agent_start",
			build: (_event, ctx) =>
				({
					kind: "agent_start",
					sessionId: sid(ctx),
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

	for (const h of PI_HANDLERS) {
		pi.on(h.piEvent as any, async (event: any, ctx: ExtensionContext) => {
			dispatchTelemetryEvent(h.build(event, ctx));
			if (h.postDispatch) await h.postDispatch(event, ctx);
		});
	}

	// -- Sub-agent EventBus handlers (6 rows) --
	//
	// Payloads are typebox-validated at the boundary. A malformed payload is
	// dropped with a single warning rather than silently coerced into a
	// corrupted event. After Value.Check passes, `data` is narrowed to the
	// schema's Static<>.

	interface SubAgentHandlerSpec {
		channel: string;
		schema: TSchema;
		map: (data: unknown, sessionId: string) => TelemetryEvent;
	}

	const SUBAGENT_HANDLERS: readonly SubAgentHandlerSpec[] = [
		{
			channel: "subagents:created",
			schema: SubAgentCreatedPayloadSchema,
			map: (data, sessionId) => {
				const d = data as SubAgentCreatedPayload;
				return {
					kind: "subagent_created",
					sessionId,
					agentId: d.id,
					agentType: d.type,
					description: d.description,
					isBackground: d.isBackground,
					timestamp: Date.now(),
				} satisfies SubAgentCreatedEvent;
			},
		},
		{
			channel: "subagents:started",
			schema: SubAgentStartedPayloadSchema,
			map: (data, sessionId) => {
				const d = data as SubAgentStartedPayload;
				return {
					kind: "subagent_started",
					sessionId,
					agentId: d.id,
					agentType: d.type,
					timestamp: Date.now(),
				} satisfies SubAgentStartedEvent;
			},
		},
		{
			channel: "subagents:completed",
			schema: SubAgentCompletedPayloadSchema,
			map: (data, sessionId) => {
				const d = data as SubAgentCompletedPayload;
				const usage = d.tokens
					? {
							input: d.tokens.input ?? 0,
							output: d.tokens.output ?? 0,
							totalTokens: d.tokens.total ?? 0,
						}
					: undefined;
				return {
					kind: "subagent_completed",
					sessionId,
					agentId: d.id,
					status: d.status,
					result: d.result,
					durationMs: d.durationMs,
					usage,
					toolUses: d.toolUses,
					timestamp: Date.now(),
				} satisfies SubAgentCompletedEvent;
			},
		},
		{
			channel: "subagents:failed",
			schema: SubAgentFailedPayloadSchema,
			map: (data, sessionId) => {
				const d = data as SubAgentFailedPayload;
				return {
					kind: "subagent_failed",
					sessionId,
					agentId: d.id,
					status: d.status,
					error: d.error,
					durationMs: d.durationMs,
					timestamp: Date.now(),
				} satisfies SubAgentFailedEvent;
			},
		},
		{
			channel: "subagents:compacted",
			schema: SubAgentCompactedPayloadSchema,
			map: (data, sessionId) => {
				const d = data as SubAgentCompactedPayload;
				return {
					kind: "subagent_compacted",
					sessionId,
					agentId: d.id,
					agentType: d.type,
					reason: d.reason,
					tokensBefore: d.tokensBefore,
					compactionCount: d.compactionCount,
					timestamp: Date.now(),
				} satisfies SubAgentCompactedEvent;
			},
		},
		{
			channel: "subagents:steered",
			schema: SubAgentSteeredPayloadSchema,
			map: (data, sessionId) => {
				const d = data as SubAgentSteeredPayload;
				return {
					kind: "subagent_steered",
					sessionId,
					agentId: d.id,
					message: d.message,
					timestamp: Date.now(),
				} satisfies SubAgentSteeredEvent;
			},
		},
	];

	for (const h of SUBAGENT_HANDLERS) {
		const unsub = pi.events.on(h.channel, (data: unknown) => {
			if (!Value.Check(h.schema, data)) {
				const firstError = [...Value.Errors(h.schema, data)][0];
				const detail = firstError ? `${firstError.instancePath || "/"}: ${firstError.message}` : "schema mismatch";
				console.warn(`[rpiv-telemetry] dropping ${h.channel} event with invalid payload: ${detail}`);
				return;
			}
			dispatchTelemetryEvent(h.map(data, currentSessionId));
		});
		eventBusUnsubscribers.push(unsub);
	}
}
