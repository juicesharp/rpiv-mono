import type { LiveSpan } from "@mlflow/core";
// Unofficial deep import — inlines the mutation that the upstream-merged
// `mlflow.tracingContext` performs (mlflow/mlflow#21620, unreleased on npm as
// of @mlflow/core@0.2.0). Migrate to that API once it ships, and delete this
// file.
import { InMemoryTraceManager } from "@mlflow/core/dist/core/trace_manager.js";

/**
 * Promote sessionId onto the trace's `mlflow.trace.session` metadata so the
 * MLflow web UI's Session column groups traces by Pi session.
 */
export function setTraceSession(span: LiveSpan, sessionId: string): void {
	const trace = InMemoryTraceManager.getInstance().getTrace(span.traceId);
	if (trace) trace.info.traceMetadata["mlflow.trace.session"] = sessionId;
}
