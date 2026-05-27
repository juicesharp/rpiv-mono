import type { TelemetryEvent } from "../types/events.js";
import type { TelemetryProvider, TelemetryProviderMeta } from "../types/provider.js";

export const CONSOLE_PROVIDER_META: TelemetryProviderMeta = {
	name: "console",
	label: "Console",
};

export class ConsoleProvider implements TelemetryProvider {
	readonly name = CONSOLE_PROVIDER_META.name;
	readonly meta = CONSOLE_PROVIDER_META;

	async trackEvent(event: TelemetryEvent): Promise<void> {
		const ts = new Date(event.timestamp).toISOString();
		const summary = this.summarize(event);
		process.stderr.write(`[rpiv-telemetry] ${ts} ${event.kind} ${summary}\n`);
	}

	async flush(): Promise<void> {
		/* no-op */
	}

	async shutdown(): Promise<void> {
		/* no-op */
	}

	private summarize(event: TelemetryEvent): string {
		switch (event.kind) {
			case "session_start":
			case "session_shutdown":
				return `reason=${event.reason}`;
			case "tool_execution_start":
			case "tool_execution_end":
				return `tool=${event.toolName}`;
			case "llm_request_start":
				return `seq=${event.requestSeq}`;
			case "llm_request_end":
				return `seq=${event.requestSeq} status=${event.status}`;
			case "message_end":
				return event.usage ? `role=${event.role} tokens=${event.usage.totalTokens}` : `role=${event.role}`;
			case "subagent_created":
			case "subagent_started":
				return `agent=${event.agentId} type=${event.agentType}`;
			case "subagent_completed":
			case "subagent_failed":
				return `agent=${event.agentId}`;
			default:
				return "";
		}
	}
}
