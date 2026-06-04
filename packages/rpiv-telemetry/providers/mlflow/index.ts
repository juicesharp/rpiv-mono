import { flushTraces, init } from "@mlflow/core";
import { type MlflowConfig, resolveMlflowConfig } from "../../config.js";
import type { TelemetryEvent } from "../../types/events.js";
import type { TelemetryProvider } from "../../types/provider.js";
import { onAttributeEvent } from "./attribute-events.js";
import { onLlmRequestEnd, onLlmRequestStart, onMessageEnd } from "./llm-spans.js";
import { MLFLOW_PROVIDER_META } from "./meta.js";
import { onSessionShutdown } from "./session-shutdown.js";
import { MlflowSpanRegistry } from "./span-registry.js";
import { onSubAgentEvent } from "./subagent-spans.js";
import { onToolExecutionEnd, onToolExecutionStart } from "./tool-spans.js";
import { onAgentEnd, onAgentStart } from "./turn-spans.js";

// META lives in ./meta.js (no @mlflow/core); re-exported to keep the import surface.
export { MLFLOW_PROVIDER_META } from "./meta.js";

// ---------------------------------------------------------------------------
// MlflowProvider — per-turn traces with nested tool + llm-request spans
// ---------------------------------------------------------------------------

export class MlflowProvider implements TelemetryProvider {
	readonly meta = MLFLOW_PROVIDER_META;

	private initialized = false;
	private initAttempted = false;
	private readonly providerConfig: MlflowConfig;
	private readonly registry = new MlflowSpanRegistry();
	// Per-event-kind transition tracker. Mirrors the dispatcher's
	// `failedProviders` posture: warn once on first failure of a kind, warn
	// once on first success after a failure — never per-event noise.
	private readonly failedKinds = new Set<TelemetryEvent["kind"]>();

	constructor(providerConfig: MlflowConfig) {
		this.providerConfig = providerConfig;
	}

	async trackEvent(event: TelemetryEvent): Promise<void> {
		this.ensureInit();
		if (!this.initialized) return;
		try {
			this.dispatch(event);
			if (this.failedKinds.has(event.kind)) {
				this.failedKinds.delete(event.kind);
				console.warn(`[rpiv-telemetry] mlflow provider recovered for kind=${event.kind}`);
			}
		} catch (err) {
			if (!this.failedKinds.has(event.kind)) {
				this.failedKinds.add(event.kind);
				console.warn(
					`[rpiv-telemetry] mlflow provider error on kind=${event.kind}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	private dispatch(event: TelemetryEvent): void {
		switch (event.kind) {
			case "agent_start":
				onAgentStart(this.registry, event);
				return;
			case "agent_end":
				onAgentEnd(this.registry, event);
				return;
			case "tool_execution_start":
				onToolExecutionStart(this.registry, event);
				return;
			case "tool_execution_end":
				onToolExecutionEnd(this.registry, event);
				return;
			case "llm_request_start":
				onLlmRequestStart(this.registry, event);
				return;
			case "llm_request_end":
				onLlmRequestEnd(this.registry, event);
				return;
			case "message_end":
				onMessageEnd(this.registry, event);
				return;
			case "session_shutdown":
				onSessionShutdown(this.registry, event);
				return;
			case "turn_start":
			case "turn_end":
			case "session_compact":
			case "before_agent_start":
			case "model_select":
				onAttributeEvent(this.registry, event);
				return;
			case "subagent_created":
			case "subagent_started":
			case "subagent_completed":
			case "subagent_failed":
			case "subagent_compacted":
			case "subagent_steered":
				onSubAgentEvent(event);
				return;
		}
	}

	async flush(): Promise<void> {
		try {
			if (this.initialized) {
				await flushTraces();
			}
		} catch (err) {
			console.warn(`[rpiv-telemetry] mlflow flush error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async shutdown(): Promise<void> {
		await this.flush();
		this.registry.clear();
		this.failedKinds.clear();
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

		try {
			init({
				trackingUri: resolved.trackingUri,
				experimentId: resolved.experimentId ?? "0",
				...(resolved.trackingToken ? { trackingServerToken: resolved.trackingToken } : {}),
			});
			this.initialized = true;
		} catch (err) {
			console.warn(
				`[rpiv-telemetry] mlflow init failed; events will be dropped: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
