import { flushTraces, init, type LiveSpan } from "@mlflow/core";
import { resolveMlflowConfig } from "../../config.js";
import type { TelemetryEvent } from "../../types/events.js";
import type { TelemetryProvider, TelemetryProviderMeta } from "../../types/provider.js";
import { onLlmRequestEnd, onLlmRequestStart, onMessageEnd } from "./llm-spans.js";
import { onSessionShutdown } from "./session-shutdown.js";
import { onSubAgentEvent } from "./subagent-spans.js";
import { onToolExecutionEnd, onToolExecutionStart } from "./tool-spans.js";
import { onAgentEnd, onAgentStart, onAttributeEvent } from "./turn-spans.js";

// ---------------------------------------------------------------------------
// Provider metadata
// ---------------------------------------------------------------------------

export const MLFLOW_PROVIDER_META: TelemetryProviderMeta = {
	name: "mlflow",
	label: "MLflow",
	envVars: ["MLFLOW_TRACKING_URI", "MLFLOW_EXPERIMENT_ID", "MLFLOW_TRACKING_TOKEN"],
};

// ---------------------------------------------------------------------------
// MlflowProvider — per-turn traces with nested tool + llm-request spans
// ---------------------------------------------------------------------------

export class MlflowProvider implements TelemetryProvider {
	readonly name = MLFLOW_PROVIDER_META.name;
	readonly meta = MLFLOW_PROVIDER_META;

	private initialized = false;
	private initAttempted = false;
	private readonly providerConfig: Record<string, string>;

	/** Active agent-turn root spans keyed by sessionId. */
	private readonly activeTurnSpans = new Map<string, LiveSpan>();

	/** Active tool-execution child spans keyed by `${sessionId}\0${toolCallId}`. */
	private readonly activeToolSpans = new Map<string, LiveSpan>();

	/** Active LLM-request child spans keyed by `${sessionId}\0${requestSeq}`. */
	private readonly activeLlmSpans = new Map<string, LiveSpan>();

	/** Latest open LLM-request span per session — O(1) lookup target for message_end attribution. */
	private readonly latestLlmSpanBySession = new Map<string, LiveSpan>();

	constructor(providerConfig: Record<string, string>) {
		this.providerConfig = providerConfig;
	}

	async trackEvent(event: TelemetryEvent): Promise<void> {
		try {
			this.ensureInit();
			if (!this.initialized) return;

			switch (event.kind) {
				case "agent_start":
					return onAgentStart(this.activeTurnSpans, event);
				case "agent_end":
					return onAgentEnd(this.activeTurnSpans, event);
				case "tool_execution_start":
					return onToolExecutionStart(this.activeTurnSpans, this.activeToolSpans, event);
				case "tool_execution_end":
					return onToolExecutionEnd(this.activeToolSpans, event);
				case "llm_request_start":
					return onLlmRequestStart(this.activeTurnSpans, this.activeLlmSpans, this.latestLlmSpanBySession, event);
				case "llm_request_end":
					return onLlmRequestEnd(this.activeLlmSpans, this.latestLlmSpanBySession, event);
				case "message_end":
					return onMessageEnd(this.activeTurnSpans, this.latestLlmSpanBySession, event);
				case "session_shutdown":
					return onSessionShutdown(
						this.activeTurnSpans,
						this.activeToolSpans,
						this.activeLlmSpans,
						this.latestLlmSpanBySession,
						event,
					);
				case "turn_start":
				case "turn_end":
				case "session_compact":
				case "before_agent_start":
				case "model_select":
					return onAttributeEvent(this.activeTurnSpans, event);
				case "subagent_created":
				case "subagent_started":
				case "subagent_completed":
				case "subagent_failed":
				case "subagent_compacted":
				case "subagent_steered":
					return onSubAgentEvent(event);
			}
		} catch (err) {
			console.debug("[rpiv-telemetry] provider error:", err instanceof Error ? err.message : String(err));
		}
	}

	async flush(): Promise<void> {
		try {
			if (this.initialized) {
				await flushTraces();
			}
		} catch (err) {
			console.debug("[rpiv-telemetry] flush error:", err instanceof Error ? err.message : String(err));
		}
	}

	async shutdown(): Promise<void> {
		await this.flush();
		this.activeTurnSpans.clear();
		this.activeToolSpans.clear();
		this.activeLlmSpans.clear();
		this.latestLlmSpanBySession.clear();
	}

	private ensureInit(): void {
		if (this.initialized || this.initAttempted) return;
		this.initAttempted = true;
		const resolved = resolveMlflowConfig(this.providerConfig);
		if (!resolved.trackingUri) {
			console.warn(
				"[rpiv-telemetry] mlflow provider registered but MLFLOW_TRACKING_URI is not configured — events will be silently dropped",
			);
			return;
		}

		init({
			trackingUri: resolved.trackingUri,
			experimentId: resolved.experimentId ?? "0",
			...(resolved.trackingToken ? { trackingServerToken: resolved.trackingToken } : {}),
		});
		this.initialized = true;
	}
}
