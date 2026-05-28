import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { type LlmPayloadMode, loadTelemetryConfig } from "./config.js";
import { dispatchTelemetryEvent, resetTelemetryDispatcher, shutdownTelemetryDispatcher } from "./dispatcher.js";
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
 * If this Pi process is running as a pi-subagents sub-agent, the agent type
 * detected from its system prompt's `<active_agent name="...">` tag. Each
 * sub-agent runs in its own Pi process with its own rpiv-telemetry instance,
 * so this is naturally scoped to "this sub-agent" — process-wide, set once.
 * Undefined in user-facing parent sessions.
 */
let currentSubAgentType: string | undefined;

const SUBAGENT_TYPE_PATTERN = /<active_agent\s+name="([^"]+)"\s*\/?>/;

function detectSubAgentType(systemPrompt: string | undefined): string | undefined {
	if (!systemPrompt) return undefined;
	const m = SUBAGENT_TYPE_PATTERN.exec(systemPrompt);
	return m?.[1];
}

/**
 * Read the parent session ID from Pi's native lineage. `SessionHeader.parentSession`
 * is the parent session's file path (set by pi-subagents when it spawns the sub-agent's
 * session); Pi names session files by `<sessionId>.jsonl`, so the basename minus the
 * extension is the parent session ID. Returns undefined for user-facing parent sessions
 * that have no parent of their own.
 */
function parentSessionIdFromCtx(ctx: ExtensionContext): string | undefined {
	const parentPath = ctx.sessionManager.getHeader()?.parentSession;
	if (!parentPath) return undefined;
	const base = parentPath.split(/[\\/]/).pop() ?? parentPath;
	return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

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
	currentSubAgentType = undefined;
	for (const unsub of eventBusUnsubscribers) {
		try {
			unsub();
		} catch {
			/* best-effort */
		}
	}
	eventBusUnsubscribers.length = 0;
	resetTelemetryDispatcher();
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
// Each row in PI_HANDLERS / SUBAGENT_HANDLERS holds the source identifier
// (`piEvent` / `channel`) and a `build`/`map` function that maps the raw
// payload into the canonical TelemetryEvent. The cross-cutting glue
// (sessionId injection, timestamp, dispatch) lives in the loop, not in each
// handler. Per-event subscription coverage is enforced by instrumentation.test.ts
// (the "subscribes to N Pi lifecycle events" and "subscribes to 6 sub-agent
// EventBus channels" tests).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export function initInstrumentation(pi: ExtensionAPI): void {
	const config = loadTelemetryConfig();
	llmPayloadMode = config.llmPayload;

	// Always register handlers, even when no providers are configured: a
	// provider registered later via registerTelemetryProvider must receive
	// events from the moment it joins. The "no providers" short-circuit lives
	// in dispatchTelemetryEvent, not here.

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
				// Unsubscribe sub-agent EventBus handlers; without this they keep firing
				// against a shut-down dispatcher (production-shutdown path, not just tests).
				teardownTelemetry();
			},
		},
		{
			piEvent: "before_agent_start",
			build: (event, ctx) => {
				// Sub-agent type is stable for a Pi process — detect once from the
				// `<active_agent name="...">` tag pi-subagents stamps onto sub-agent
				// system prompts, and reuse for every subsequent agent_start.
				currentSubAgentType ??= detectSubAgentType(event.systemPrompt);
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
			const mapped = h.map(data, currentSessionId);
			// Foreground vs background detection: pi-subagents only emits
			// `subagents:created` for background runs (the spawn_subagent tool
			// path), while `subagents:started` fires unconditionally for both.
			// Foreground completion is surfaced via the parent's
			// `tool_execution_end` for the `Agent` tool (result in the tool
			// span's outputs), so a standalone `subagent.started` trace is pure
			// noise for foreground runs (0s execution time, no completion
			// counterpart). We suppress those starts by gating on whether a
			// `subagents:created` was seen first for the same agentId.
			if (mapped.kind === "subagent_created") {
				inflightSubAgents.set(mapped.agentId, {
					agentType: mapped.agentType,
					startedAtMs: Date.now(),
					sessionId: mapped.sessionId,
				});
			} else if (mapped.kind === "subagent_started") {
				if (!inflightSubAgents.has(mapped.agentId)) return; // foreground — skip noise
				// Background — refresh startedAt to the actual run start time
				inflightSubAgents.set(mapped.agentId, {
					agentType: mapped.agentType,
					startedAtMs: Date.now(),
					sessionId: mapped.sessionId,
				});
			} else if (mapped.kind === "subagent_completed" || mapped.kind === "subagent_failed") {
				inflightSubAgents.delete(mapped.agentId);
			}
			dispatchTelemetryEvent(mapped);
		});
		eventBusUnsubscribers.push(unsub);
	}
}
