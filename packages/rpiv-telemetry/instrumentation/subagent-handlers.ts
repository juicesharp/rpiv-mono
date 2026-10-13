import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { dispatchTelemetryEvent } from "../dispatcher.js";
import type {
	SubAgentCompactedEvent,
	SubAgentCompletedEvent,
	SubAgentCreatedEvent,
	SubAgentFailedEvent,
	SubAgentStartedEvent,
	SubAgentSteeredEvent,
	TelemetryEvent,
} from "../types/events.js";
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
} from "./schemas.js";
import { currentSessionId, inflightKey, inflightSubAgents } from "./state.js";

/**
 * One row per sub-agent EventBus channel subscribed via `pi.events.on(...)`.
 * Payloads are typebox-validated at the boundary. A malformed payload is
 * dropped with a single warning rather than silently coerced into a corrupted
 * event. After `Value.Check` passes, `data` is narrowed to the schema's
 * `Static<>`.
 */
export interface SubAgentHandlerSpec {
	channel: string;
	schema: TSchema;
	map: (data: unknown, sessionId: string) => TelemetryEvent;
}

export const SUBAGENT_HANDLERS: readonly SubAgentHandlerSpec[] = [
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

/**
 * Validate a sub-agent EventBus payload, gate on a known session, update the
 * inflight tracker (with composite sessionId+agentId key), and
 * dispatch the resulting TelemetryEvent.
 *
 * Foreground vs background detection: pi-subagents only emits
 * `subagents:created` for background runs (the spawn_subagent tool path),
 * while `subagents:started` fires unconditionally for both. Foreground
 * completion is surfaced via the parent's `tool_execution_end` for the
 * `Agent` tool, so a standalone `subagent.started` trace is pure noise for
 * foreground runs (0s execution time, no completion counterpart). We
 * suppress those starts by gating on whether a `subagents:created` was seen
 * first for the same `(sessionId, agentId)` pair.
 */
export function handleSubAgentBusEvent(h: SubAgentHandlerSpec, data: unknown): void {
	// Drop events that arrive before `session_start` populates currentSessionId.
	// Without this guard the event would ship with `sessionId: ""` and propagate
	// into MLflow span attributes as a phantom session.
	if (!currentSessionId) {
		console.warn(`[rpiv-telemetry] dropping ${h.channel} event with no active session`);
		return;
	}
	if (!Value.Check(h.schema, data)) {
		const firstError = [...Value.Errors(h.schema, data)][0];
		const detail = firstError ? `${firstError.instancePath || "/"}: ${firstError.message}` : "schema mismatch";
		console.warn(`[rpiv-telemetry] dropping ${h.channel} event with invalid payload: ${detail}`);
		return;
	}
	const mapped = h.map(data, currentSessionId);
	if (mapped.kind === "subagent_created") {
		inflightSubAgents.set(inflightKey(mapped.sessionId, mapped.agentId), {
			agentId: mapped.agentId,
			agentType: mapped.agentType,
			startedAtMs: Date.now(),
			sessionId: mapped.sessionId,
		});
	} else if (mapped.kind === "subagent_started") {
		const key = inflightKey(mapped.sessionId, mapped.agentId);
		if (!inflightSubAgents.has(key)) return; // foreground — skip noise
		// Background — refresh startedAt to the actual run start time
		inflightSubAgents.set(key, {
			agentId: mapped.agentId,
			agentType: mapped.agentType,
			startedAtMs: Date.now(),
			sessionId: mapped.sessionId,
		});
	} else if (mapped.kind === "subagent_completed" || mapped.kind === "subagent_failed") {
		inflightSubAgents.delete(inflightKey(mapped.sessionId, mapped.agentId));
	}
	dispatchTelemetryEvent(mapped);
}
