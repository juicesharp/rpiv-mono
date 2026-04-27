import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import { MAX_QUESTIONS, type QuestionnaireResult } from "./types.js";

type CustomFn = (...args: unknown[]) => Promise<unknown>;

function register() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

function ctxWithCustom(result: QuestionnaireResult | null) {
	const custom = vi.fn(async () => result) as unknown as CustomFn;
	return createMockCtx({ hasUI: true, ui: { custom } as never });
}

const BASE_PARAMS = {
	questions: [
		{
			question: "Which?",
			header: "Pick",
			options: [{ label: "A" }, { label: "B" }],
		},
	],
};

describe("ask_user_question.execute — early returns", () => {
	it("returns cancelled result + ERROR_NO_UI when !hasUI", async () => {
		const tool = register();
		const ctx = createMockCtx({ hasUI: false });
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ answers: [], cancelled: true, error: "no_ui" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("UI not available") });
	});

	it("returns cancelled result when any question has empty options", async () => {
		const tool = register();
		const ctx = ctxWithCustom(null);
		const r = await tool.execute?.(
			"tc",
			{ questions: [{ question: "Q?", options: [] }] } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		expect(r?.details).toMatchObject({ cancelled: true, error: "empty_options" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("at least 2 options") });
	});

	it("returns ERROR_NO_QUESTIONS text when questions array is empty", async () => {
		const tool = register();
		const ctx = ctxWithCustom(null);
		const r = await tool.execute?.(
			"tc",
			{ questions: [] } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		expect(r?.details).toMatchObject({ answers: [], cancelled: true, error: "no_questions" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("At least one question") });
	});

	it("returns error: too_many_questions when questions exceed MAX_QUESTIONS", async () => {
		const tool = register();
		const ctx = ctxWithCustom(null);
		const tooMany = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({
			question: `Q${i}?`,
			options: [{ label: "A" }],
		}));
		const r = await tool.execute?.(
			"tc",
			{ questions: tooMany } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		expect(r?.details).toMatchObject({ cancelled: true, error: "too_many_questions" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("At most") });
	});
});

describe("ask_user_question.execute — ctx.ui.custom dispatch", () => {
	it("User cancels (cancelled: true) → decline envelope", async () => {
		const tool = register();
		const ctx = ctxWithCustom({ answers: [], cancelled: true });
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ cancelled: true });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("declined") });
	});

	it("Normal selection → CC envelope wrapper with quoted question and answer", async () => {
		const tool = register();
		const ctx = ctxWithCustom({
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Which?", answer: "A", wasCustom: false }],
		});
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="A"') });
		expect(r?.content[0]).toMatchObject({
			text: expect.stringMatching(/^User has answered your questions:/),
		});
	});

	it("Custom typed answer sets wasCustom", async () => {
		const tool = register();
		const ctx = ctxWithCustom({
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Which?", answer: "typed", wasCustom: true }],
		});
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="typed"') });
	});
});

describe("ask_user_question.execute — undefined result from ctx.ui.custom", () => {
	it("returns decline envelope when custom resolves to undefined", async () => {
		const tool = register();
		const custom = vi.fn(async () => undefined) as unknown as CustomFn;
		const ctx = createMockCtx({ hasUI: true, ui: { custom } as never });
		const params = {
			questions: [{ question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }] }],
		};
		const r = await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ cancelled: true });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("declined") });
	});
});

describe("ask_user_question.execute — new runtime guards (CC parity)", () => {
	it("widens empty_options check to < MIN_OPTIONS (single-option rejected)", async () => {
		const tool = register();
		const ctx = ctxWithCustom(null);
		const params = { questions: [{ question: "Q?", header: "H", options: [{ label: "A" }] }] };
		const r = await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ cancelled: true, error: "empty_options" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("at least 2 options") });
	});

	it("returns error: duplicate_question when two questions share text", async () => {
		const tool = register();
		const ctx = ctxWithCustom(null);
		const params = {
			questions: [
				{ question: "Same?", header: "H1", options: [{ label: "A" }, { label: "B" }] },
				{ question: "Same?", header: "H2", options: [{ label: "C" }, { label: "D" }] },
			],
		};
		const r = await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ cancelled: true, error: "duplicate_question" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Question text must be unique") });
	});

	it("returns error: duplicate_option_label when two options in a question share label", async () => {
		const tool = register();
		const ctx = ctxWithCustom(null);
		const params = {
			questions: [
				{
					question: "Pick?",
					header: "Pick",
					options: [{ label: "A" }, { label: "A" }],
				},
			],
		};
		const r = await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ cancelled: true, error: "duplicate_option_label" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Option labels must be unique") });
	});

	it("returns error: reserved_label when an option uses 'Other' / 'Type something.' / 'Chat about this'", async () => {
		const tool = register();
		const ctx = ctxWithCustom(null);
		const params = {
			questions: [
				{
					question: "Pick?",
					header: "Pick",
					options: [{ label: "Other" }, { label: "B" }],
				},
			],
		};
		const r = await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ cancelled: true, error: "reserved_label" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("reserved") });
	});

	it("rejects 'Type something.' as a reserved label even on multiSelect questions (Decision 9)", async () => {
		const tool = register();
		const ctx = ctxWithCustom(null);
		const params = {
			questions: [
				{
					question: "Pick?",
					header: "Pick",
					multiSelect: true,
					options: [{ label: "Type something." }, { label: "B" }],
				},
			],
		};
		const r = await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ cancelled: true, error: "reserved_label" });
	});
});

describe("ask_user_question — registration", () => {
	it("registers a typebox schema with a top-level questions array", () => {
		const tool = register();
		expect(tool.name).toBe("ask_user_question");
		const props = (tool.parameters as unknown as { properties: Record<string, unknown> }).properties;
		expect(props).toHaveProperty("questions");
	});
});
