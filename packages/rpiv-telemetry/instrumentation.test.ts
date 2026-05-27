import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as config from "./config.js";

vi.mock("./config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./config.js")>();
	return {
		...actual,
		loadTelemetryConfig: vi.fn(actual.loadTelemetryConfig),
	};
});

vi.mock("./providers/index.js", () => ({
	registerConfiguredProviders: vi.fn(),
}));

vi.mock("./dispatcher.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./dispatcher.js")>();
	return {
		...actual,
		dispatchTelemetryEvent: vi.fn(),
		shutdownTelemetryDispatcher: vi.fn(async () => {}),
		// Keep clearDispatcherState real — teardownTelemetry() depends on it
		clearDispatcherState: actual.clearDispatcherState,
	};
});

// Set a safe default BEFORE any beforeEach (including test/setup.ts global
// beforeEach) can invoke teardownTelemetry() → clearDispatcherState() → loadTelemetryConfig().
// Without this, the global beforeEach would hit the real config and fail.
vi.mocked(config.loadTelemetryConfig).mockReturnValue({
	providers: {},
	events: "*",
	llmPayload: "off",
	dispatcher: { maxQueueSize: 100 },
});

import { dispatchTelemetryEvent } from "./dispatcher.js";
import { initInstrumentation, TELEMETRY_HANDLER_KINDS, teardownTelemetry } from "./instrumentation.js";
import { TELEMETRY_EVENT_KINDS } from "./types/events.js";

describe("instrumentation", () => {
	beforeEach(() => {
		vi.mocked(config.loadTelemetryConfig).mockReturnValue({
			providers: { mlflow: {} },
			events: "*",
			llmPayload: "off",
			dispatcher: { maxQueueSize: 100 },
		});
		teardownTelemetry();
	});

	it("registers handlers even when no providers configured (D3)", () => {
		vi.mocked(config.loadTelemetryConfig).mockReturnValue({
			providers: {},
			events: "*",
			llmPayload: "off",
			dispatcher: { maxQueueSize: 100 },
		});
		const { pi } = createMockPi();
		initInstrumentation(pi);
		// D3 fix: always register handlers for late-binding support;
		// dispatchTelemetryEvent gates on empty provider list instead
		expect(pi.on).toHaveBeenCalled();
	});

	it("subscribes to 11 Pi lifecycle events", () => {
		const { pi, captured } = createMockPi();
		initInstrumentation(pi);
		const piEvents = [...captured.events.keys()];
		expect(piEvents).toContain("session_start");
		expect(piEvents).toContain("session_compact");
		expect(piEvents).toContain("session_shutdown");
		expect(piEvents).toContain("before_agent_start");
		expect(piEvents).toContain("agent_start");
		expect(piEvents).toContain("agent_end");
		expect(piEvents).toContain("turn_start");
		expect(piEvents).toContain("turn_end");
		expect(piEvents).toContain("tool_execution_start");
		expect(piEvents).toContain("tool_execution_end");
		expect(piEvents).toContain("model_select");
		expect(piEvents.length).toBeGreaterThanOrEqual(11);
	});

	it("subscribes to 6 sub-agent EventBus channels", () => {
		const { pi } = createMockPi();
		initInstrumentation(pi);
		expect(pi.events.on).toHaveBeenCalledWith("subagents:created", expect.any(Function));
		expect(pi.events.on).toHaveBeenCalledWith("subagents:started", expect.any(Function));
		expect(pi.events.on).toHaveBeenCalledWith("subagents:completed", expect.any(Function));
		expect(pi.events.on).toHaveBeenCalledWith("subagents:failed", expect.any(Function));
		expect(pi.events.on).toHaveBeenCalledWith("subagents:compacted", expect.any(Function));
		expect(pi.events.on).toHaveBeenCalledWith("subagents:steered", expect.any(Function));
	});

	it("session_start handler dispatches correct TelemetryEvent", async () => {
		const { pi, captured } = createMockPi();
		const ctx = createMockCtx();
		initInstrumentation(pi);
		const handler = captured.events.get("session_start")?.[0];
		expect(handler).toBeDefined();
		await handler!({ reason: "startup" }, ctx);
		expect(dispatchTelemetryEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "session_start", reason: "startup" }),
		);
	});

	it("session_start handler reads sessionId from context", async () => {
		const { pi, captured } = createMockPi();
		const ctx = createMockCtx();
		initInstrumentation(pi);
		const handler = captured.events.get("session_start")?.[0];
		await handler!({ reason: "new" }, ctx);
		expect(dispatchTelemetryEvent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "test-session" }));
	});

	it("tool_execution_start handler uses args field (not input)", async () => {
		const { pi, captured } = createMockPi();
		initInstrumentation(pi);
		const handler = captured.events.get("tool_execution_start")?.[0];
		await handler!({ toolCallId: "t1", toolName: "read", args: { path: "/foo" } }, createMockCtx());
		expect(dispatchTelemetryEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "tool_execution_start",
				toolCallId: "t1",
				toolName: "read",
				args: { path: "/foo" },
			}),
		);
	});

	it("model_select handler maps model fields correctly", async () => {
		const { pi, captured } = createMockPi();
		initInstrumentation(pi);
		const handler = captured.events.get("model_select")?.[0];
		await handler!({ model: { id: "claude-3", provider: "anthropic" }, source: "set" }, createMockCtx());
		expect(dispatchTelemetryEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "model_select",
				modelId: "claude-3",
				modelProvider: "anthropic",
				source: "set",
			}),
		);
	});

	it("turn_start handler dispatches with turnIndex", async () => {
		const { pi, captured } = createMockPi();
		initInstrumentation(pi);
		const handler = captured.events.get("turn_start")?.[0];
		await handler!({ turnIndex: 5, timestamp: 1000 }, createMockCtx());
		expect(dispatchTelemetryEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "turn_start", turnIndex: 5, timestamp: 1000 }),
		);
	});

	it("session_shutdown handler dispatches event and calls shutdownTelemetryDispatcher", async () => {
		const { shutdownTelemetryDispatcher } = await import("./dispatcher.js");
		const { pi, captured } = createMockPi();
		initInstrumentation(pi);
		const handler = captured.events.get("session_shutdown")?.[0];
		await handler!({ reason: "quit" }, createMockCtx());
		expect(dispatchTelemetryEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "session_shutdown", reason: "quit" }),
		);
		expect(shutdownTelemetryDispatcher).toHaveBeenCalled();
	});

	it("session_shutdown unsubscribes EventBus handlers via teardownTelemetry (I2)", async () => {
		const { pi, captured } = createMockPi();
		const unsubs: ReturnType<typeof vi.fn>[] = [];
		vi.mocked(pi.events.on).mockImplementation(() => {
			const unsub = vi.fn();
			unsubs.push(unsub);
			return unsub;
		});
		initInstrumentation(pi);
		expect(unsubs).toHaveLength(6);

		// Fire session_shutdown — should call teardownTelemetry which unsubscribes
		const handler = captured.events.get("session_shutdown")?.[0];
		await handler!({ reason: "quit" }, createMockCtx());

		for (const unsub of unsubs) {
			expect(unsub).toHaveBeenCalled();
		}
	});

	it("teardownTelemetry clears all state", () => {
		const { pi } = createMockPi();
		initInstrumentation(pi);
		// Should not throw
		teardownTelemetry();
		// Double-reset should also be safe
		expect(() => teardownTelemetry()).not.toThrow();
	});

	it("teardownTelemetry unsubscribes EventBus handlers", () => {
		const { pi } = createMockPi();
		const unsubs: ReturnType<typeof vi.fn>[] = [];
		vi.mocked(pi.events.on).mockImplementation(() => {
			const unsub = vi.fn();
			unsubs.push(unsub);
			return unsub;
		});
		initInstrumentation(pi);
		expect(unsubs).toHaveLength(6);
		teardownTelemetry();
		// All unsub functions should have been called
		for (const unsub of unsubs) {
			expect(unsub).toHaveBeenCalled();
		}
	});

	// -------------------------------------------------------------------------
	// HANDLERS table coverage
	// -------------------------------------------------------------------------

	it("HANDLERS table covers every TELEMETRY_EVENT_KIND", () => {
		// Missing a row silently drops that Pi event. This snapshot keeps the
		// two tables in lockstep with the canonical kind list in types/events.ts.
		expect([...TELEMETRY_HANDLER_KINDS].sort()).toEqual([...TELEMETRY_EVENT_KINDS].sort());
	});

	it("subscribes to all 14 Pi lifecycle events", () => {
		const { pi, captured } = createMockPi();
		initInstrumentation(pi);
		const piEvents = new Set(captured.events.keys());
		const expected = [
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
			"before_provider_request",
			"after_provider_response",
			"message_end",
		];
		for (const event of expected) {
			expect(piEvents.has(event)).toBe(true);
		}
		expect(piEvents.size).toBe(expected.length);
	});

	// -------------------------------------------------------------------------
	// Sub-agent payload typebox validation (L1-02)
	// -------------------------------------------------------------------------

	it("subagent_created handler dispatches when payload validates", () => {
		const { pi, captured } = createMockPi();
		// Capture bus subscriber callbacks for inspection.
		const busHandlers = new Map<string, (data: unknown) => void>();
		vi.mocked(pi.events.on).mockImplementation((channel: string, handler: (data: unknown) => void) => {
			busHandlers.set(channel, handler);
			return () => {};
		});
		initInstrumentation(pi);
		// Open a session so currentSessionId is populated for bus handlers.
		captured.events.get("session_start")?.[0]?.({ reason: "startup" }, createMockCtx());

		busHandlers.get("subagents:created")?.({
			id: "agent-1",
			type: "researcher",
			description: "look up X",
			isBackground: false,
		});

		expect(dispatchTelemetryEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "subagent_created",
				agentId: "agent-1",
				agentType: "researcher",
				description: "look up X",
				isBackground: false,
			}),
		);
	});

	it("sub-agent handler drops + warns on malformed payload (L1-02)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { pi } = createMockPi();
		const busHandlers = new Map<string, (data: unknown) => void>();
		vi.mocked(pi.events.on).mockImplementation((channel: string, handler: (data: unknown) => void) => {
			busHandlers.set(channel, handler);
			return () => {};
		});
		initInstrumentation(pi);
		const before = vi.mocked(dispatchTelemetryEvent).mock.calls.length;

		// Missing required `type` field — schema rejects, handler drops.
		busHandlers.get("subagents:created")?.({ id: "agent-1" });

		expect(vi.mocked(dispatchTelemetryEvent).mock.calls.length).toBe(before);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("subagents:created"));
		warn.mockRestore();
	});

	it("subagent_completed maps token usage from `tokens` payload to LlmUsage shape", () => {
		const { pi, captured } = createMockPi();
		const busHandlers = new Map<string, (data: unknown) => void>();
		vi.mocked(pi.events.on).mockImplementation((channel: string, handler: (data: unknown) => void) => {
			busHandlers.set(channel, handler);
			return () => {};
		});
		initInstrumentation(pi);
		captured.events.get("session_start")?.[0]?.({ reason: "startup" }, createMockCtx());

		busHandlers.get("subagents:completed")?.({
			id: "agent-1",
			durationMs: 250,
			tokens: { input: 10, output: 20, total: 30 },
			toolUses: 2,
		});

		expect(dispatchTelemetryEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "subagent_completed",
				agentId: "agent-1",
				durationMs: 250,
				usage: { input: 10, output: 20, totalTokens: 30 },
				toolUses: 2,
			}),
		);
	});
});
