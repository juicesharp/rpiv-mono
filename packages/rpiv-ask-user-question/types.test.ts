import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
	isQuestionnaireResult,
	MAX_HEADER_LENGTH,
	MAX_LABEL_LENGTH,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionAnswer,
	type QuestionData,
	type QuestionnaireResult,
	QuestionParamsSchema,
	QuestionsSchema,
	RESERVED_LABELS,
} from "./types.js";

function makeQuestion(override: Partial<QuestionData> = {}): QuestionData {
	return {
		question: override.question ?? "What's your name?",
		header: override.header ?? "Hdr",
		options: override.options ?? [
			{ label: "A", description: "Choice A" },
			{ label: "B", description: "Choice B" },
		],
		multiSelect: override.multiSelect,
	};
}

describe("QuestionsSchema — array constraints", () => {
	it("accepts a single question", () => {
		expect(Value.Check(QuestionsSchema, [makeQuestion()])).toBe(true);
	});

	it("accepts MAX_QUESTIONS (4) questions", () => {
		const four = [makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion()];
		expect(Value.Check(QuestionsSchema, four)).toBe(true);
	});

	it("rejects empty array (minItems=1)", () => {
		expect(Value.Check(QuestionsSchema, [])).toBe(false);
	});

	it("rejects > MAX_QUESTIONS items (maxItems=4)", () => {
		const five = [makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion()];
		expect(Value.Check(QuestionsSchema, five)).toBe(false);
		expect(MAX_QUESTIONS).toBe(4);
	});
});

describe("QuestionSchema — option/preview/multiSelect/header shape", () => {
	it("accepts options with optional preview field", () => {
		const q = makeQuestion({
			options: [
				{ label: "A", description: "alpha", preview: "## A\n\nbody" },
				{ label: "B", description: "beta" },
			],
		});
		expect(Value.Check(QuestionsSchema, [q])).toBe(true);
	});

	it("accepts a question with all optional fields populated", () => {
		const q: QuestionData = {
			question: "Pick architecture",
			header: "Architecture",
			options: [
				{ label: "Monolith", description: "Single deployable unit", preview: "## Monolith\n\nSimple" },
				{ label: "Microservices", description: "Distributed services", preview: "## Micro\n\nScalable" },
			],
			multiSelect: false,
		};
		expect(Value.Check(QuestionsSchema, [q])).toBe(true);
	});

	it("accepts multiSelect: true", () => {
		expect(Value.Check(QuestionsSchema, [makeQuestion({ multiSelect: true })])).toBe(true);
	});

	it("accepts a header up to MAX_HEADER_LENGTH chars", () => {
		expect(Value.Check(QuestionsSchema, [makeQuestion({ header: "Architecture" })])).toBe(true);
	});

	it("rejects a single-option question (minItems=2)", () => {
		expect(
			Value.Check(QuestionsSchema, [makeQuestion({ options: [{ label: "OK", description: "Only choice" }] })]),
		).toBe(false);
	});

	it("rejects empty options array (minItems=2)", () => {
		expect(Value.Check(QuestionsSchema, [makeQuestion({ options: [] })])).toBe(false);
	});

	it("rejects more than MAX_OPTIONS options (maxItems=4)", () => {
		const five = [
			{ label: "A", description: "alpha" },
			{ label: "B", description: "beta" },
			{ label: "C", description: "gamma" },
			{ label: "D", description: "delta" },
			{ label: "E", description: "epsilon" },
		];
		expect(Value.Check(QuestionsSchema, [makeQuestion({ options: five })])).toBe(false);
		expect(MAX_OPTIONS).toBe(4);
	});

	it("rejects an option missing the required description", () => {
		const broken = makeQuestion({
			options: [{ label: "A" } as never, { label: "B", description: "ok" }],
		});
		expect(Value.Check(QuestionsSchema, [broken])).toBe(false);
	});

	it("rejects a question missing the required header", () => {
		const noHeader = {
			question: "Q?",
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		};
		expect(Value.Check(QuestionsSchema, [noHeader])).toBe(false);
	});

	it("rejects a header longer than MAX_HEADER_LENGTH (12) chars", () => {
		expect(Value.Check(QuestionsSchema, [makeQuestion({ header: "ThisIsTooLong13" })])).toBe(false);
	});

	it("rejects a label longer than MAX_LABEL_LENGTH (60) chars", () => {
		const tooLong = "x".repeat(MAX_LABEL_LENGTH + 1);
		expect(
			Value.Check(QuestionsSchema, [
				makeQuestion({
					options: [
						{ label: tooLong, description: "a" },
						{ label: "B", description: "b" },
					],
				}),
			]),
		).toBe(false);
	});

	it("rejects question with missing 'question' text", () => {
		const broken = {
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		} as unknown;
		expect(Value.Check(QuestionsSchema, [broken])).toBe(false);
	});
});

describe("QuestionParamsSchema — top-level shape", () => {
	it("accepts { questions: [...] }", () => {
		expect(Value.Check(QuestionParamsSchema, { questions: [makeQuestion()] })).toBe(true);
	});

	it("accepts full valid payload with preview + multiSelect", () => {
		const payload = {
			questions: [
				{
					question: "Choose",
					header: "Pick",
					multiSelect: true,
					options: [
						{ label: "A", description: "First", preview: "# A" },
						{ label: "B", description: "Second" },
					],
				},
			],
		};
		expect(Value.Check(QuestionParamsSchema, payload)).toBe(true);
	});

	it("rejects missing 'questions' field", () => {
		expect(Value.Check(QuestionParamsSchema, {})).toBe(false);
	});

	it("rejects non-array questions field", () => {
		expect(Value.Check(QuestionParamsSchema, { questions: "not array" })).toBe(false);
	});
});

describe("QuestionAnswer — notes + preview field optionality", () => {
	it("accepts an answer with notes populated", () => {
		const a: QuestionAnswer = {
			questionIndex: 0,
			question: "Q?",
			answer: "A",
			wasCustom: false,
			notes: "preview looked good",
		};
		expect(a.notes).toBe("preview looked good");
	});

	it("accepts an answer with selected[] (multi-select) and no answer scalar", () => {
		const a: QuestionAnswer = {
			questionIndex: 1,
			question: "Areas?",
			answer: null,
			selected: ["Frontend", "Backend"],
		};
		expect(a.selected).toEqual(["Frontend", "Backend"]);
		expect(a.answer).toBeNull();
	});

	it("accepts an answer with preview populated (single-select with matched preview-bearing option)", () => {
		const a: QuestionAnswer = {
			questionIndex: 0,
			question: "Q?",
			answer: "A",
			preview: "## Heading\n\nbody",
		};
		expect(a.preview).toContain("## Heading");
	});
});

describe("isQuestionnaireResult — type guard", () => {
	it("accepts a valid result", () => {
		const r: QuestionnaireResult = { answers: [], cancelled: false };
		expect(isQuestionnaireResult(r)).toBe(true);
	});

	it("accepts a result with error field", () => {
		expect(isQuestionnaireResult({ answers: [], cancelled: true, error: "no_ui" })).toBe(true);
	});

	it("accepts a result with the new error variants", () => {
		expect(isQuestionnaireResult({ answers: [], cancelled: true, error: "duplicate_question" })).toBe(true);
		expect(isQuestionnaireResult({ answers: [], cancelled: true, error: "duplicate_option_label" })).toBe(true);
		expect(isQuestionnaireResult({ answers: [], cancelled: true, error: "reserved_label" })).toBe(true);
	});

	it("accepts a result with populated answers", () => {
		expect(
			isQuestionnaireResult({
				answers: [{ questionIndex: 0, question: "Q?", answer: "A" }],
				cancelled: false,
			}),
		).toBe(true);
	});

	it("rejects null / undefined", () => {
		expect(isQuestionnaireResult(null)).toBe(false);
		expect(isQuestionnaireResult(undefined)).toBe(false);
	});

	it("rejects primitives", () => {
		expect(isQuestionnaireResult(42)).toBe(false);
		expect(isQuestionnaireResult("oops")).toBe(false);
	});

	it("rejects an array", () => {
		expect(isQuestionnaireResult([])).toBe(false);
	});

	it("rejects missing fields", () => {
		expect(isQuestionnaireResult({ answers: [] })).toBe(false);
		expect(isQuestionnaireResult({ cancelled: true })).toBe(false);
	});
});

describe("schema constants + RESERVED_LABELS", () => {
	it("exports the new schema constants with expected values", () => {
		expect(MIN_OPTIONS).toBe(2);
		expect(MAX_OPTIONS).toBe(4);
		expect(MAX_HEADER_LENGTH).toBe(12);
		expect(MAX_LABEL_LENGTH).toBe(60);
	});

	it("RESERVED_LABELS includes the three Pi sentinels + CC's 'Other'", () => {
		expect(RESERVED_LABELS).toEqual(["Other", "Type something.", "Chat about this"]);
	});
});
