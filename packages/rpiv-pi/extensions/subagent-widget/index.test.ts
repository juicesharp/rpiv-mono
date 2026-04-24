import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub nicobailon's default + render exports so the renderer-override
// wrapper doesn't actually run registerSubagentExtension during unit
// tests (it needs a full ExtensionAPI that our minimal MockPi lacks).
vi.mock("pi-subagents", () => ({ default: vi.fn() }));
vi.mock("pi-subagents/render", () => ({ renderSubagentResult: vi.fn() }));

import initExtension from "./index.js";
import { __resetState, listRuns } from "./run-tracker.js";

type Handler = (event: any, ctx: ExtensionContext) => Promise<void> | void;

interface MockPi extends ExtensionAPI {
	handlers: Map<string, Handler>;
}

function makePi(): MockPi {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			handlers.set(event, handler);
		}),
		handlers,
	} as unknown as MockPi;
	return pi;
}

function makeCtx(hasUI: boolean): ExtensionContext {
	return {
		hasUI,
		ui: { setWidget: vi.fn() },
	} as unknown as ExtensionContext;
}

beforeEach(() => {
	__resetState();
});

describe("subagent-widget extension factory", () => {
	it("subscribes to the expected events", async () => {
		const pi = makePi();
		await initExtension(pi);
		const subscribed = [...pi.handlers.keys()];
		expect(subscribed).toEqual(
			expect.arrayContaining([
				"session_start",
				"session_shutdown",
				"input",
				"tool_execution_start",
				"tool_execution_update",
				"tool_execution_end",
			]),
		);
	});

	it("tracker records onStart even when hasUI is false", async () => {
		const pi = makePi();
		await initExtension(pi);
		const startHandler = pi.handlers.get("tool_execution_start")!;
		await startHandler(
			{
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "subagent",
				args: { agent: "scout", task: "x" },
			},
			makeCtx(false),
		);
		expect(listRuns()).toHaveLength(1);
	});

	it("filters non-subagent tool calls", async () => {
		const pi = makePi();
		await initExtension(pi);
		const startHandler = pi.handlers.get("tool_execution_start")!;
		await startHandler(
			{
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "ls" },
			},
			makeCtx(true),
		);
		expect(listRuns()).toHaveLength(0);
	});

	it("skips async (background) subagent dispatches — pi-subagents owns the live view", async () => {
		const pi = makePi();
		await initExtension(pi);
		const startHandler = pi.handlers.get("tool_execution_start")!;
		await startHandler(
			{
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "subagent",
				args: { agent: "scout", task: "probe", async: true },
			},
			makeCtx(true),
		);
		expect(listRuns()).toHaveLength(0);
	});

	it("tracks sync subagent dispatches even when async field is explicitly false", async () => {
		const pi = makePi();
		await initExtension(pi);
		const startHandler = pi.handlers.get("tool_execution_start")!;
		await startHandler(
			{
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "subagent",
				args: { agent: "scout", task: "probe", async: false },
			},
			makeCtx(true),
		);
		expect(listRuns()).toHaveLength(1);
	});

	it("tool_execution_update is a no-op for async dispatches", async () => {
		const pi = makePi();
		await initExtension(pi);
		const updateHandler = pi.handlers.get("tool_execution_update")!;
		await updateHandler(
			{
				type: "tool_execution_update",
				toolCallId: "t1",
				toolName: "subagent",
				args: { agent: "scout", task: "probe", async: true },
				partialResult: {
					details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] },
				},
			},
			makeCtx(true),
		);
		expect(listRuns()).toHaveLength(0);
	});

	it("tool_execution_update routes partialResult.details to tracker", async () => {
		const pi = makePi();
		await initExtension(pi);
		const startHandler = pi.handlers.get("tool_execution_start")!;
		const updateHandler = pi.handlers.get("tool_execution_update")!;
		await startHandler(
			{
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "subagent",
				args: { agent: "scout", task: "x" },
			},
			makeCtx(true),
		);
		await updateHandler(
			{
				type: "tool_execution_update",
				toolCallId: "t1",
				toolName: "subagent",
				args: {},
				partialResult: {
					details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] },
				},
			},
			makeCtx(true),
		);
		expect(listRuns()[0].mode).toBe("single");
	});

	it("tool_execution_end sets terminal status", async () => {
		const pi = makePi();
		await initExtension(pi);
		const startHandler = pi.handlers.get("tool_execution_start")!;
		const endHandler = pi.handlers.get("tool_execution_end")!;
		await startHandler(
			{
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "subagent",
				args: { agent: "scout", task: "x" },
			},
			makeCtx(true),
		);
		await endHandler(
			{
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "subagent",
				result: { details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] } },
				isError: false,
			},
			makeCtx(true),
		);
		expect(listRuns()[0].status).toBe("completed");
	});

	it("session_start resets the tracker", async () => {
		const pi = makePi();
		await initExtension(pi);
		const startHandler = pi.handlers.get("tool_execution_start")!;
		await startHandler(
			{
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "subagent",
				args: { agent: "scout", task: "x" },
			},
			makeCtx(true),
		);
		expect(listRuns()).toHaveLength(1);
		const sessionStart = pi.handlers.get("session_start")!;
		await sessionStart({ type: "session_start", reason: "reload" } as any, makeCtx(true));
		expect(listRuns()).toHaveLength(0);
	});

	it("input + turn_start both advance linger ages; evicts after COMPLETED_LINGER_TURNS boundaries", async () => {
		const pi = makePi();
		await initExtension(pi);
		const startHandler = pi.handlers.get("tool_execution_start")!;
		const endHandler = pi.handlers.get("tool_execution_end")!;
		const inputHandler = pi.handlers.get("input")!;
		const turnStartHandler = pi.handlers.get("turn_start")!;
		await startHandler(
			{
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "subagent",
				args: { agent: "scout", task: "x" },
			},
			makeCtx(true),
		);
		await endHandler(
			{
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "subagent",
				result: { details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] } },
				isError: false,
			},
			makeCtx(true),
		);
		expect(listRuns()).toHaveLength(1);
		// COMPLETED_LINGER_TURNS = 3 — takes 3 turn boundaries to evict.
		await turnStartHandler({ type: "turn_start" } as any, makeCtx(true)); // age 1
		await turnStartHandler({ type: "turn_start" } as any, makeCtx(true)); // age 2
		expect(listRuns()).toHaveLength(1);
		await inputHandler({ type: "input", text: "next", source: "interactive" } as any, makeCtx(true)); // age 3 → evicted
		expect(listRuns()).toHaveLength(0);
	});

	it("purges finished runs when a new wave starts (tool_execution_start with no active runs)", async () => {
		const pi = makePi();
		await initExtension(pi);
		const startHandler = pi.handlers.get("tool_execution_start")!;
		const endHandler = pi.handlers.get("tool_execution_end")!;
		// Wave 1: dispatch + complete.
		await startHandler(
			{
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "subagent",
				args: { agent: "scout", task: "x" },
			},
			makeCtx(true),
		);
		await endHandler(
			{
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "subagent",
				result: { details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] } },
				isError: false,
			},
			makeCtx(true),
		);
		expect(listRuns()).toHaveLength(1);
		// Wave 2: new dispatch while wave 1 is still lingering → wave 1 purged first.
		await startHandler(
			{
				type: "tool_execution_start",
				toolCallId: "t2",
				toolName: "subagent",
				args: { agent: "worker", task: "y" },
			},
			makeCtx(true),
		);
		const runs = listRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0].toolCallId).toBe("t2");
	});
});
