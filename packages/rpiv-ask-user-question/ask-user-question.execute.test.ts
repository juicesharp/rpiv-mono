import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import { MAX_QUESTIONS, type QuestionnaireResult } from "./tool/types.js";

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
			answers: [{ questionIndex: 0, question: "Which?", kind: "option", answer: "A" }],
		});
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="A"') });
		expect(r?.content[0]).toMatchObject({
			text: expect.stringMatching(/^User has answered your questions:/),
		});
	});

	it("Custom typed answer sets kind:'custom'", async () => {
		const tool = register();
		const ctx = ctxWithCustom({
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Which?", kind: "custom", answer: "typed" }],
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

describe("ask_user_question.execute — event emission", () => {
	function validParams() {
		return {
			questions: [
				{
					question: "Which library?",
					header: "Lib",
					options: [
						{ label: "React", description: "UI library" },
						{ label: "Vue", description: "Another UI library" },
					],
				},
			],
		};
	}

	function ctxWithCustomFn() {
		const custom = vi.fn(async () => ({ answers: [], cancelled: false }));
		const ctx = createMockCtx({ hasUI: true, ui: { custom } as never });
		return { custom, ctx };
	}

	it("emits ASK_USER_PROMPT event via pi.events.emit before showing dialog", async () => {
		const mockEmit = vi.fn();
		const { pi, captured } = createMockPi({
			events: { emit: mockEmit, on: vi.fn(() => () => {}) },
		});
		registerAskUserQuestionTool(pi);
		const tool = captured.tools.get("ask_user_question")!;
		const { custom, ctx } = ctxWithCustomFn();

		await tool.execute?.("tc", validParams() as never, undefined as never, undefined as never, ctx as never);

		expect(mockEmit).toHaveBeenCalledWith("rpiv:ask-user:prompt", {
			questions: [
				{
					question: "Which library?",
					header: "Lib",
					multiSelect: false,
					options: [
						{ label: "React", description: "UI library", hasPreview: false },
						{ label: "Vue", description: "Another UI library", hasPreview: false },
					],
				},
			],
		});

		// Verify event is emitted BEFORE the dialog is shown
		expect(mockEmit.mock.invocationCallOrder[0]).toBeLessThan(custom.mock.invocationCallOrder[0]);
	});

	it("does NOT emit event when UI is unavailable", async () => {
		const { pi, captured } = createMockPi();
		registerAskUserQuestionTool(pi);
		const tool = captured.tools.get("ask_user_question")!;

		// Use valid params so only !hasUI causes the early return
		const ctx = createMockCtx({ hasUI: false });
		await tool.execute?.("tc", validParams() as never, undefined as never, undefined as never, ctx as never);

		expect(captured.eventsEmitted.has("rpiv:ask-user:prompt")).toBe(false);
	});

	it("does NOT emit event when validation fails", async () => {
		const { pi, captured } = createMockPi();
		registerAskUserQuestionTool(pi);
		const tool = captured.tools.get("ask_user_question")!;

		const ctx = createMockCtx({ hasUI: true, ui: { custom: vi.fn() } as never });
		await tool.execute?.("tc", { questions: [] } as never, undefined as never, undefined as never, ctx as never);

		expect(captured.eventsEmitted.has("rpiv:ask-user:prompt")).toBe(false);
	});

	it("emits payload with all questions in order when multiple questions", async () => {
		const { pi, captured } = createMockPi();
		registerAskUserQuestionTool(pi);
		const tool = captured.tools.get("ask_user_question")!;
		const { ctx } = ctxWithCustomFn();

		const params = {
			questions: [
				{
					question: "Which framework?",
					header: "FW",
					options: [
						{ label: "React", description: "UI lib" },
						{ label: "Vue", description: "Another UI lib" },
					],
				},
				{
					question: "Which language?",
					header: "Lang",
					options: [
						{ label: "TS", description: "TypeScript" },
						{ label: "JS", description: "JavaScript" },
					],
				},
			],
		};

		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);

		expect(captured.eventsEmitted.has("rpiv:ask-user:prompt")).toBe(true);
		const payload = captured.eventsEmitted.get("rpiv:ask-user:prompt")![0] as Record<string, unknown>;
		expect(payload).toEqual({
			questions: [
				{
					question: "Which framework?",
					header: "FW",
					multiSelect: false,
					options: [
						{ label: "React", description: "UI lib", hasPreview: false },
						{ label: "Vue", description: "Another UI lib", hasPreview: false },
					],
				},
				{
					question: "Which language?",
					header: "Lang",
					multiSelect: false,
					options: [
						{ label: "TS", description: "TypeScript", hasPreview: false },
						{ label: "JS", description: "JavaScript", hasPreview: false },
					],
				},
			],
		});
	});
});
