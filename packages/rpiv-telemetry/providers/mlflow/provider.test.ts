import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mlflow/core", () => ({
	init: vi.fn(),
	startSpan: vi.fn(() => ({
		setAttribute: vi.fn(),
		end: vi.fn(),
		setOutputs: vi.fn(),
	})),
	SpanType: { AGENT: "AGENT", TOOL: "TOOL" },
	SpanStatusCode: { ERROR: "ERROR" },
	flushTraces: vi.fn(async () => {}),
}));

import { flushTraces, init, SpanStatusCode, SpanType, startSpan } from "@mlflow/core";
import { MlflowProvider } from "./index.js";

describe("MlflowProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("lazy-inits on first event when trackingUri configured", async () => {
		const provider = new MlflowProvider({ trackingUri: "http://localhost:5000", experimentId: "123" });
		await provider.trackEvent({ kind: "agent_start", sessionId: "s1", timestamp: 1 });
		expect(init).toHaveBeenCalledWith(
			expect.objectContaining({ trackingUri: "http://localhost:5000", experimentId: "123" }),
		);
	});

	it("does not init without trackingUri", async () => {
		const provider = new MlflowProvider({});
		await provider.trackEvent({ kind: "agent_start", sessionId: "s1", timestamp: 1 });
		expect(init).not.toHaveBeenCalled();
	});

	it("creates root span on agent_start, ends on agent_end", async () => {
		const mockSpan = { setAttribute: vi.fn(), end: vi.fn() };
		vi.mocked(startSpan).mockReturnValue(mockSpan as unknown as ReturnType<typeof startSpan>);
		const provider = new MlflowProvider({ trackingUri: "http://localhost:5000" });
		await provider.trackEvent({ kind: "agent_start", sessionId: "s1", timestamp: 1 });
		expect(startSpan).toHaveBeenCalledWith(expect.objectContaining({ name: "agent-turn", spanType: SpanType.AGENT }));
		await provider.trackEvent({ kind: "agent_end", sessionId: "s1", messageCount: 0, timestamp: 2 });
		expect(mockSpan.end).toHaveBeenCalled();
	});

	it("creates nested tool span with parent", async () => {
		const mockTurnSpan = { setAttribute: vi.fn(), end: vi.fn() };
		const mockToolSpan = { setAttribute: vi.fn(), end: vi.fn() };
		vi.mocked(startSpan)
			.mockReturnValueOnce(mockTurnSpan as unknown as ReturnType<typeof startSpan>)
			.mockReturnValueOnce(mockToolSpan as unknown as ReturnType<typeof startSpan>);
		const provider = new MlflowProvider({ trackingUri: "http://localhost:5000" });
		await provider.trackEvent({ kind: "agent_start", sessionId: "s1", timestamp: 1 });
		await provider.trackEvent({
			kind: "tool_execution_start",
			sessionId: "s1",
			toolCallId: "t1",
			toolName: "read",
			timestamp: 2,
		});
		expect(startSpan).toHaveBeenCalledWith(
			expect.objectContaining({ name: "read", parent: mockTurnSpan, spanType: SpanType.TOOL }),
		);
	});

	it("ends tool span on tool_execution_end", async () => {
		const mockTurnSpan = { setAttribute: vi.fn(), end: vi.fn() };
		const mockToolSpan = { setAttribute: vi.fn(), end: vi.fn() };
		vi.mocked(startSpan)
			.mockReturnValueOnce(mockTurnSpan as unknown as ReturnType<typeof startSpan>)
			.mockReturnValueOnce(mockToolSpan as unknown as ReturnType<typeof startSpan>);
		const provider = new MlflowProvider({ trackingUri: "http://localhost:5000" });
		await provider.trackEvent({ kind: "agent_start", sessionId: "s1", timestamp: 1 });
		await provider.trackEvent({
			kind: "tool_execution_start",
			sessionId: "s1",
			toolCallId: "t1",
			toolName: "read",
			timestamp: 2,
		});
		await provider.trackEvent({
			kind: "tool_execution_end",
			sessionId: "s1",
			toolCallId: "t1",
			toolName: "read",
			isError: false,
			timestamp: 3,
		});
		expect(mockToolSpan.end).toHaveBeenCalledWith(expect.objectContaining({ outputs: { isError: false } }));
	});

	it("sets ERROR status on tool_execution_end with isError", async () => {
		const mockTurnSpan = { setAttribute: vi.fn(), end: vi.fn() };
		const mockToolSpan = { setAttribute: vi.fn(), end: vi.fn() };
		vi.mocked(startSpan)
			.mockReturnValueOnce(mockTurnSpan as unknown as ReturnType<typeof startSpan>)
			.mockReturnValueOnce(mockToolSpan as unknown as ReturnType<typeof startSpan>);
		const provider = new MlflowProvider({ trackingUri: "http://localhost:5000" });
		await provider.trackEvent({ kind: "agent_start", sessionId: "s1", timestamp: 1 });
		await provider.trackEvent({
			kind: "tool_execution_start",
			sessionId: "s1",
			toolCallId: "t1",
			toolName: "read",
			timestamp: 2,
		});
		await provider.trackEvent({
			kind: "tool_execution_end",
			sessionId: "s1",
			toolCallId: "t1",
			toolName: "read",
			isError: true,
			timestamp: 3,
		});
		expect(mockToolSpan.end).toHaveBeenCalledWith(expect.objectContaining({ status: SpanStatusCode.ERROR }));
	});

	it("swallows errors (fail-open)", async () => {
		vi.mocked(startSpan).mockImplementation(() => {
			throw new Error("boom");
		});
		const provider = new MlflowProvider({ trackingUri: "http://localhost:5000" });
		await expect(
			provider.trackEvent({ kind: "agent_start", sessionId: "s1", timestamp: 1 }),
		).resolves.toBeUndefined();
	});

	it("flush calls mlflow.flushTraces", async () => {
		const provider = new MlflowProvider({ trackingUri: "http://localhost:5000" });
		// Trigger init
		await provider.trackEvent({ kind: "agent_start", sessionId: "s1", timestamp: 1 });
		await provider.flush();
		expect(flushTraces).toHaveBeenCalled();
	});

	it("shutdown flushes and clears span maps", async () => {
		const mockSpan = { setAttribute: vi.fn(), end: vi.fn() };
		vi.mocked(startSpan).mockReturnValue(mockSpan as unknown as ReturnType<typeof startSpan>);
		const provider = new MlflowProvider({ trackingUri: "http://localhost:5000" });
		await provider.trackEvent({ kind: "agent_start", sessionId: "s1", timestamp: 1 });
		await provider.shutdown();
		expect(flushTraces).toHaveBeenCalled();
	});

	it("sub-agent events create standalone spans with session.id attribute", async () => {
		const mockSpan = { setAttribute: vi.fn(), end: vi.fn() };
		vi.mocked(startSpan).mockReturnValue(mockSpan as unknown as ReturnType<typeof startSpan>);
		const provider = new MlflowProvider({ trackingUri: "http://localhost:5000" });
		await provider.trackEvent({
			kind: "subagent_created",
			sessionId: "s1",
			agentId: "a1",
			agentType: "Explore",
			timestamp: 1,
		});
		expect(startSpan).toHaveBeenCalledWith(
			expect.objectContaining({ name: "subagent.created", spanType: SpanType.AGENT }),
		);
		expect(mockSpan.setAttribute).toHaveBeenCalledWith("session.id", "s1");
		expect(mockSpan.end).toHaveBeenCalled();
	});

	it("session shutdown cleans up orphaned turn spans", async () => {
		const mockSpan = { setAttribute: vi.fn(), end: vi.fn() };
		vi.mocked(startSpan).mockReturnValue(mockSpan as unknown as ReturnType<typeof startSpan>);
		const provider = new MlflowProvider({ trackingUri: "http://localhost:5000" });
		await provider.trackEvent({ kind: "agent_start", sessionId: "s1", timestamp: 1 });
		await provider.trackEvent({ kind: "session_shutdown", sessionId: "s1", reason: "quit", timestamp: 2 });
		expect(mockSpan.end).toHaveBeenCalled();
	});

	// I4 fix: composite key for session-scoped cleanup of orphaned tool spans
	it("session shutdown cleans up orphaned tool spans by composite key (I4)", async () => {
		const mockTurnSpan = { setAttribute: vi.fn(), end: vi.fn() };
		const mockToolSpan = { setAttribute: vi.fn(), end: vi.fn() };
		vi.mocked(startSpan)
			.mockReturnValueOnce(mockTurnSpan as unknown as ReturnType<typeof startSpan>)
			.mockReturnValueOnce(mockToolSpan as unknown as ReturnType<typeof startSpan>);
		const provider = new MlflowProvider({ trackingUri: "http://localhost:5000" });
		// Start a turn and a tool span — tool span has no matching tool_execution_end
		await provider.trackEvent({ kind: "agent_start", sessionId: "s1", timestamp: 1 });
		await provider.trackEvent({
			kind: "tool_execution_start",
			sessionId: "s1",
			toolCallId: "t1",
			toolName: "read",
			timestamp: 2,
		});
		// Shutdown without explicit tool_execution_end — orphaned tool span should still end
		await provider.trackEvent({ kind: "session_shutdown", sessionId: "s1", reason: "quit", timestamp: 3 });
		expect(mockToolSpan.end).toHaveBeenCalled();
		// Turn span should also be ended (both orphaned spans cleaned)
		expect(mockTurnSpan.end).toHaveBeenCalled();
	});

	// I3 fix: one-time warning when trackingUri is absent
	it("warns once on missing trackingUri (I3)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const provider = new MlflowProvider({});
		await provider.trackEvent({ kind: "agent_start", sessionId: "s1", timestamp: 1 });
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("MLFLOW_TRACKING_URI is not configured"));
		// Second event should NOT warn again (one-time only)
		await provider.trackEvent({ kind: "agent_start", sessionId: "s1", timestamp: 2 });
		expect(warnSpy).toHaveBeenCalledOnce();
	});

	// Q12 fix: errors logged at debug level
	it("logs errors at debug level (Q12)", async () => {
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
		vi.mocked(startSpan).mockImplementation(() => {
			throw new Error("mlflow unavailable");
		});
		const provider = new MlflowProvider({ trackingUri: "http://localhost:5000" });
		await provider.trackEvent({ kind: "agent_start", sessionId: "s1", timestamp: 1 });
		expect(debugSpy).toHaveBeenCalledWith("[rpiv-telemetry] provider error:", "mlflow unavailable");
	});
});
