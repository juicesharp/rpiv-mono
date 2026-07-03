import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { ASK_USER_QUESTION_TOOL_NAME } from "./ask-user-question.js";
import factory from "./index.js";
import { reconcileAskUserQuestionTool, registerAskUserQuestionReconciler } from "./reconcile.js";

describe("reconcileAskUserQuestionTool", () => {
	it("strips ask_user_question when !hasUI and the tool is active", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: false }));
		expect(pi.setActiveTools).toHaveBeenCalledWith(["other"]);
	});

	it("no-ops when !hasUI and the tool is already absent", () => {
		const { pi } = createMockPi();
		pi.setActiveTools(["other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: false }));
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("restores ask_user_question when hasUI and the tool is absent", () => {
		const { pi } = createMockPi();
		pi.setActiveTools(["other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: true }));
		expect(pi.setActiveTools).toHaveBeenCalledWith(["other", ASK_USER_QUESTION_TOOL_NAME]);
	});

	it("no-ops when hasUI and the tool is already active", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: true }));
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("does not clobber sibling tools on strip — ['ask_user_question','other'] + !hasUI → ['other']", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: false }));
		expect(pi.getActiveTools()).toEqual(["other"]);
	});

	it("does not clobber sibling tools on restore — ['other'] + hasUI → ['other','ask_user_question']", () => {
		const { pi } = createMockPi();
		pi.setActiveTools(["other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: true }));
		expect(pi.getActiveTools()).toEqual(["other", ASK_USER_QUESTION_TOOL_NAME]);
	});

	it("strip→restore round-trips back to present", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: false }));
		expect(pi.getActiveTools()).toEqual(["other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: true }));
		expect(pi.getActiveTools()).toEqual(["other", ASK_USER_QUESTION_TOOL_NAME]);
	});

	it("is idempotent — two stripped-mode calls make one setActiveTools and leave the set stable", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		const ctx = createMockCtx({ hasUI: false });
		reconcileAskUserQuestionTool(pi, ctx);
		reconcileAskUserQuestionTool(pi, ctx);
		expect(pi.setActiveTools).toHaveBeenCalledTimes(1);
		expect(pi.getActiveTools()).toEqual(["other"]);
	});

	it("is idempotent — two restored-mode calls (already correct) make zero setActiveTools and leave the set stable", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		const ctx = createMockCtx({ hasUI: true });
		reconcileAskUserQuestionTool(pi, ctx);
		reconcileAskUserQuestionTool(pi, ctx);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
		expect(pi.getActiveTools()).toEqual([ASK_USER_QUESTION_TOOL_NAME, "other"]);
	});

	// RPC/ACP hosts (Zed, Paseo) report hasUI: true — the dialog sub-protocol
	// works — but ui.custom() cannot render, so the tool must be stripped there
	// too (issue #78).
	it("strips ask_user_question in RPC mode even though hasUI is true", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: true, mode: "rpc" }));
		expect(pi.setActiveTools).toHaveBeenCalledWith(["other"]);
	});

	it("does not restore ask_user_question in RPC mode when the tool is absent", () => {
		const { pi } = createMockPi();
		pi.setActiveTools(["other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: true, mode: "rpc" }));
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("restores ask_user_question in TUI mode (mode: 'interactive' + hasUI)", () => {
		const { pi } = createMockPi();
		pi.setActiveTools(["other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		reconcileAskUserQuestionTool(pi, createMockCtx({ hasUI: true, mode: "interactive" }));
		expect(pi.getActiveTools()).toEqual(["other", ASK_USER_QUESTION_TOOL_NAME]);
	});
});

describe("registerAskUserQuestionReconciler", () => {
	it("registers exactly one before_agent_start handler", () => {
		const { pi, captured } = createMockPi();
		registerAskUserQuestionReconciler(pi);
		expect(captured.events.get("before_agent_start")).toHaveLength(1);
	});

	it("invoking the handler with !hasUI strips the tool", () => {
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		registerAskUserQuestionReconciler(pi);
		const handler = captured.events.get("before_agent_start")![0];
		vi.mocked(pi.setActiveTools).mockClear();
		handler(undefined as never, createMockCtx({ hasUI: false }));
		expect(pi.setActiveTools).toHaveBeenCalledWith(["other"]);
	});

	it("invoking the handler with hasUI restores the tool", () => {
		const { pi, captured } = createMockPi();
		pi.setActiveTools(["other"]);
		registerAskUserQuestionReconciler(pi);
		const handler = captured.events.get("before_agent_start")![0];
		handler(undefined as never, createMockCtx({ hasUI: true }));
		expect(pi.getActiveTools()).toEqual(["other", ASK_USER_QUESTION_TOOL_NAME]);
	});
});

describe("factory wiring (index.ts default export)", () => {
	it("wires both registerAskUserQuestionTool and registerAskUserQuestionReconciler", async () => {
		const { pi, captured } = createMockPi();
		await factory(pi);
		// registerAskUserQuestionTool ran: tool registered + active.
		expect(captured.tools.has(ASK_USER_QUESTION_TOOL_NAME)).toBe(true);
		expect(captured.activeTools).toContain(ASK_USER_QUESTION_TOOL_NAME);
		// registerAskUserQuestionReconciler ran: before_agent_start handler attached.
		expect(captured.events.get("before_agent_start")).toHaveLength(1);
	});
});
