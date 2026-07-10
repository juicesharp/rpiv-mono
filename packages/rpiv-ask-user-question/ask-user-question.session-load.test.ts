import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionnaireResult } from "./tool/types.js";

// Issue #107: Pi's jiti loader registers a module in its graph cache BEFORE
// evaluating the body and does not evict it on evaluation failure, so one
// failed load of the lazy session graph (host deps replaced on disk
// mid-session) leaves every later import resolving to a namespace without the
// class — `new QuestionnaireSession(...)` then throws a bare "not a
// constructor" TypeError. These tests pin the structured envelopes that
// replace that crash, and the registration-time pre-warm that prevents it.

type CustomFn = (...args: unknown[]) => Promise<unknown>;

const SESSION_SPECIFIER = "./state/questionnaire-session.js";

const BASE_PARAMS = {
	questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }],
};

/** Re-import the tool module AFTER vi.doMock so the mocked session graph is picked up. */
async function registerFresh() {
	const { registerAskUserQuestionTool } = await import("./ask-user-question.js");
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

function ctxWithCustom(result: QuestionnaireResult | null) {
	const custom = vi.fn(async () => result) as unknown as CustomFn;
	return createMockCtx({ hasUI: true, ui: { custom } as never });
}

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.doUnmock(SESSION_SPECIFIER);
	vi.useRealTimers();
});

describe("ask_user_question.execute — lazy session-graph load guards (#107)", () => {
	it("returns error: session_load_failed (not a throw) when the lazy import rejects", async () => {
		vi.doMock(SESSION_SPECIFIER, () => {
			throw new Error("Cannot find module '/replaced/store/pi-coding-agent/dist/index.js'");
		});
		const tool = await registerFresh();
		const ctx = ctxWithCustom(null);
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ answers: [], cancelled: true, error: "session_load_failed" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("failed to load") });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("restarting Pi") });
		// Diagnostic suffix carries the underlying loader error. (vitest's mock
		// layer rewrites the thrown message, so pin the marker, not the text.)
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("(cause:") });
		expect(r?.content[0]).toMatchObject({ text: expect.not.stringContaining("declined") });
	});

	it("returns error: stale_module_cache when the namespace resolves without a constructable class", async () => {
		// The poisoned-cache shape: import succeeds but the class never evaluated.
		vi.doMock(SESSION_SPECIFIER, () => ({ QuestionnaireSession: undefined }));
		const tool = await registerFresh();
		const ctx = ctxWithCustom(null);
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ answers: [], cancelled: true, error: "stale_module_cache" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("restart Pi") });
		// Diagnostic includes the resolved namespace shape the issue asked for.
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("resolved namespace keys") });
		expect(r?.content[0]).toMatchObject({ text: expect.not.stringContaining("declined") });
	});

	it("loads the real session graph and reaches ctx.ui.custom when the module is healthy", async () => {
		const tool = await registerFresh();
		const custom = vi.fn(async () => ({ answers: [], cancelled: true }));
		const ctx = createMockCtx({ hasUI: true, ui: { custom } as never });
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(custom).toHaveBeenCalled();
		expect(r?.details).toMatchObject({ cancelled: true });
		expect(r?.details).not.toHaveProperty("error", "stale_module_cache");
	});
});

describe("ask_user_question — registration pre-warm (#107)", () => {
	it("schedules a background import of the session graph PREWARM_DELAY_MS after registration", async () => {
		vi.useFakeTimers();
		const factory = vi.fn(() => ({ QuestionnaireSession: class {} }));
		vi.doMock(SESSION_SPECIFIER, factory);
		const { registerAskUserQuestionTool, PREWARM_DELAY_MS } = await import("./ask-user-question.js");
		const { pi } = createMockPi();
		registerAskUserQuestionTool(pi);

		// Registration itself must stay off the render-graph critical path.
		expect(factory).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
		expect(factory).toHaveBeenCalled();
	});

	it("swallows a pre-warm failure so registration-time churn never crashes the extension", async () => {
		vi.useFakeTimers();
		vi.doMock(SESSION_SPECIFIER, () => {
			throw new Error("Cannot find module '/replaced/store/pi-coding-agent/dist/index.js'");
		});
		const { registerAskUserQuestionTool, PREWARM_DELAY_MS } = await import("./ask-user-question.js");
		const { pi } = createMockPi();
		registerAskUserQuestionTool(pi);
		// Would reject unhandled (failing the test run) if the pre-warm didn't swallow.
		await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
	});
});
