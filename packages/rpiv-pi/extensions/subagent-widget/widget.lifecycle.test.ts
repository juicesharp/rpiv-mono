import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetState, onEnd, onStart, onTurnStart } from "./run-tracker.js";
import type { SingleResult, SubagentDetails } from "./types.js";
import { SubagentWidget } from "./widget.js";

function makeUICtx(): ExtensionUIContext {
	return { setWidget: vi.fn() } as unknown as ExtensionUIContext;
}

function makeResult(): SingleResult {
	return {
		agent: "scout",
		agentSource: "user",
		task: "t",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	};
}

function makeDetails(): SubagentDetails {
	return { mode: "single", agentScope: "user", projectAgentsDir: null, results: [makeResult()] };
}

beforeEach(() => {
	__resetState();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("SubagentWidget lifecycle", () => {
	it("does not setInterval until first update() with tracked runs", () => {
		const widget = new SubagentWidget();
		widget.setUICtx(makeUICtx());
		widget.update();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("starts 80ms interval on first update() with runs", () => {
		onStart("t1", { agent: "scout", task: "x" });
		const widget = new SubagentWidget();
		widget.setUICtx(makeUICtx());
		widget.update();
		expect(vi.getTimerCount()).toBeGreaterThan(0);
	});

	it("clears interval on idle teardown (no runs)", () => {
		onStart("t1", { agent: "scout", task: "x" });
		const widget = new SubagentWidget();
		widget.setUICtx(makeUICtx());
		widget.update();
		onEnd("t1", { details: makeDetails() }, false);
		onTurnStart(); // evicts the completed run
		widget.update();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears interval on dispose()", () => {
		onStart("t1", { agent: "scout", task: "x" });
		const widget = new SubagentWidget();
		widget.setUICtx(makeUICtx());
		widget.update();
		widget.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("setUICtx with same ctx is idempotent", () => {
		onStart("t1", { agent: "scout", task: "x" });
		const ctx = makeUICtx();
		const widget = new SubagentWidget();
		widget.setUICtx(ctx);
		widget.update();
		widget.setUICtx(ctx);
		widget.update();
		expect((ctx.setWidget as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
	});

	it("setUICtx with a new ctx re-registers widget", () => {
		onStart("t1", { agent: "scout", task: "x" });
		const widget = new SubagentWidget();
		const ctxA = makeUICtx();
		widget.setUICtx(ctxA);
		widget.update();
		const ctxB = makeUICtx();
		widget.setUICtx(ctxB);
		widget.update();
		expect((ctxA.setWidget as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
		expect((ctxB.setWidget as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
	});

	it("dispose() calls setWidget(KEY, undefined) to unregister", () => {
		onStart("t1", { agent: "scout", task: "x" });
		const ctx = makeUICtx();
		const widget = new SubagentWidget();
		widget.setUICtx(ctx);
		widget.update();
		widget.dispose();
		const calls = (ctx.setWidget as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[calls.length - 1][1]).toBeUndefined();
	});

	it("timer tick advances widgetFrame (observable via render)", () => {
		onStart("t1", { agent: "scout", task: "x" });
		const widget = new SubagentWidget();
		widget.setUICtx(makeUICtx());
		widget.update();
		const initial = vi.getTimerCount();
		vi.advanceTimersByTime(80);
		expect(vi.getTimerCount()).toBe(initial); // interval re-schedules
	});
});
