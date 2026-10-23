import type {
	BeforeAgentStartEvent,
	ModelSelectEvent,
	SessionCompactEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../../types/events.ts";
import type { MlflowSpanRegistry } from "./span-registry.ts";

/**
 * Event kinds that don't get a dedicated child span but contribute typed
 * attributes onto the active agent-turn span.
 */
type AttributeOnlyEvent =
	| TurnStartEvent
	| TurnEndEvent
	| SessionCompactEvent
	| BeforeAgentStartEvent
	| ModelSelectEvent;

/**
 * Write per-kind typed attributes onto the active turn span. Unlike the prior
 * `event.<kind>` JSON-blob approach, these surface as filterable MLflow
 * attributes so dashboards can query e.g. `turn.stop_reason = "max_tokens"`.
 */
export function onAttributeEvent(registry: MlflowSpanRegistry, event: AttributeOnlyEvent): void {
	const span = registry.getTurnSpan(event.sessionId);
	if (!span) return;
	switch (event.kind) {
		case "turn_start":
			span.setAttribute("turn.index", event.turnIndex);
			return;
		case "turn_end":
			span.setAttribute("turn.index", event.turnIndex);
			if (event.stopReason !== undefined) span.setAttribute("turn.stop_reason", event.stopReason);
			if (event.toolResultCount !== undefined) span.setAttribute("turn.tool_result_count", event.toolResultCount);
			if (event.usage) {
				span.setAttribute("turn.usage.input_tokens", event.usage.input);
				span.setAttribute("turn.usage.output_tokens", event.usage.output);
				span.setAttribute("turn.usage.total_tokens", event.usage.totalTokens);
				if (event.usage.cost !== undefined) span.setAttribute("turn.usage.cost_usd", event.usage.cost);
			}
			return;
		case "session_compact":
			span.setAttribute("session.compact.from_extension", event.fromExtension);
			return;
		case "before_agent_start":
			if (event.prompt !== undefined) span.setAttribute("agent.prompt_length", event.prompt.length);
			return;
		case "model_select":
			span.setAttribute("model.id", event.modelId);
			span.setAttribute("model.provider", event.modelProvider);
			span.setAttribute("model.select_source", event.source);
			return;
	}
}
