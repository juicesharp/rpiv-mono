import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";

type CustomFn = (...args: unknown[]) => Promise<unknown>;

function register() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

function ctxWithCustom(choice: unknown) {
	const custom = vi.fn(async () => choice) as unknown as CustomFn;
	return createMockCtx({ hasUI: true, ui: { custom } as never });
}

const BASE_PARAMS = {
	question: "Which?",
	options: [{ label: "A" }, { label: "B" }],
};

describe("ask_user_question.execute — early returns", () => {
	it("returns null answer + ERROR_NO_UI when !hasUI", async () => {
		const tool = register();
		const ctx = createMockCtx({ hasUI: false });
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ question: "Which?", answer: null });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("UI not available") });
	});

	it("returns null answer + ERROR_NO_OPTIONS when options is empty", async () => {
		const tool = register();
		const ctx = ctxWithCustom(null);
		const r = await tool.execute?.(
			"tc",
			{ question: "Which?", options: [] } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		expect(r?.details).toMatchObject({ question: "Which?", answer: null });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("No options provided") });
	});
});

describe("ask_user_question.execute — ctx.ui.custom dispatch", () => {
	it("User cancels (null) → decline envelope", async () => {
		const tool = register();
		const ctx = ctxWithCustom(null);
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ answer: null });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("declined") });
	});

	it("Normal selection → 'User selected: A'", async () => {
		const tool = register();
		const ctx = ctxWithCustom({ label: "A" });
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ answer: "A", wasCustom: false });
		expect(r?.content[0]).toMatchObject({ text: "User selected: A" });
	});

	it("Custom typed answer sets wasCustom", async () => {
		const tool = register();
		const ctx = ctxWithCustom({ label: "typed", isOther: true });
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ answer: "typed", wasCustom: true });
		expect(r?.content[0]).toMatchObject({ text: "User answered: typed" });
	});

	it("Empty custom input → answer=null + '(no input)' rendered", async () => {
		const tool = register();
		const ctx = ctxWithCustom({ label: "", isOther: true });
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ answer: null, wasCustom: true });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("(no input)") });
	});

	it("Chat-about-this branch tags result with wasChat", async () => {
		const tool = register();
		const ctx = ctxWithCustom({ label: "Chat about this", isChat: true });
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ wasChat: true });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Continue the conversation") });
	});
});

describe("ask_user_question — registration", () => {
	it("registers a typebox schema with question + options", () => {
		const tool = register();
		expect(tool.name).toBe("ask_user_question");
		const props = (tool.parameters as unknown as { properties: Record<string, unknown> }).properties;
		expect(props).toHaveProperty("question");
		expect(props).toHaveProperty("options");
	});
});
