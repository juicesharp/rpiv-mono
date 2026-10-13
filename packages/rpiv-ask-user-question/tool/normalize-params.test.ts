import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { normalizeLineTerminators, normalizeQuestionParams, prepareQuestionArguments } from "./normalize-params.js";
import { type QuestionParams, QuestionParamsSchema } from "./types.js";

describe("normalizeLineTerminators", () => {
	it("deletes a lone CR without introducing a phantom space (#192 sample 1)", () => {
		expect(normalizeLineTerminators("GEMBA\r_LOG\r_FILE\r 的路径")).toBe("GEMBA_LOG_FILE 的路径");
	});

	it("deletes runs of CRs and keeps the real space that follows them (#192 sample 2)", () => {
		expect(normalizeLineTerminators("在\r\r\r\r GptApi\r\r\r\r.\r")).toBe("在 GptApi.");
	});

	it("maps CRLF to LF so genuine multi-line content survives", () => {
		expect(normalizeLineTerminators("line one\r\nline two\r\n")).toBe("line one\nline two\n");
	});

	it("leaves LF-only and CR-free text byte-identical", () => {
		const text = "```ts\nconst a = 1;\n```";
		expect(normalizeLineTerminators(text)).toBe(text);
		expect(normalizeLineTerminators("plain")).toBe("plain");
		expect(normalizeLineTerminators("")).toBe("");
	});
});

describe("normalizeQuestionParams", () => {
	const dirty: QuestionParams = {
		questions: [
			{
				question: "Which\r option\r is best?",
				header: "Pick\r",
				multiSelect: true,
				options: [
					{ label: "Option\rA\r (Recommended)", description: "choice with\r\r stray CR" },
					{ label: "B", description: "crlf\r\nline", preview: "```\r\nrow 1\r\nrow 2\r```" },
				],
			},
		],
	};

	it("normalizes question, header, label, description, and preview", () => {
		expect(normalizeQuestionParams(dirty)).toEqual({
			questions: [
				{
					question: "Which option is best?",
					header: "Pick",
					multiSelect: true,
					options: [
						{ label: "OptionA (Recommended)", description: "choice with stray CR" },
						{ label: "B", description: "crlf\nline", preview: "```\nrow 1\nrow 2```" },
					],
				},
			],
		});
	});

	it("does not mutate the input", () => {
		const snapshot = JSON.stringify(dirty);
		normalizeQuestionParams(dirty);
		expect(JSON.stringify(dirty)).toBe(snapshot);
	});

	it("keeps omitted optional fields omitted", () => {
		const out = normalizeQuestionParams({
			questions: [{ question: "Q?", header: "H", options: [{ label: "A", description: "a" }] }],
		});
		expect("multiSelect" in out.questions[0]).toBe(false);
		expect("preview" in out.questions[0].options[0]).toBe(false);
	});

	it("tolerates non-string values in string slots (malformed params reach the validator, not a throw)", () => {
		const malformed = {
			questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }],
		} as unknown as QuestionParams;
		expect(normalizeQuestionParams(malformed)).toEqual(malformed);
	});
});

describe("prepareQuestionArguments — double-encoded tool arguments (#244)", () => {
	const question = {
		question: "Which format?",
		header: "Format",
		options: [
			{ label: "TOML", description: "toml" },
			{ label: "YAML", description: "yaml" },
		],
	};
	const wellFormed = { questions: [question] };

	it("returns well-formed arguments unchanged", () => {
		expect(prepareQuestionArguments(wellFormed)).toEqual(wellFormed);
		expect(Value.Check(QuestionParamsSchema, prepareQuestionArguments(wellFormed))).toBe(true);
	});

	it.each([
		["questions as a JSON string", { questions: JSON.stringify([question]) }],
		["each question as a JSON string (questions.0: must be object)", { questions: [JSON.stringify(question)] }],
		["options as a JSON string", { questions: [{ ...question, options: JSON.stringify(question.options) }] }],
		[
			"each option as a JSON string",
			{ questions: [{ ...question, options: question.options.map((o) => JSON.stringify(o)) }] },
		],
		[
			"both levels at once",
			{ questions: JSON.stringify([JSON.stringify({ ...question, options: JSON.stringify(question.options) })]) },
		],
	])("decodes %s so schema validation passes", (_name, raw) => {
		expect(Value.Check(QuestionParamsSchema, raw)).toBe(false); // what Pi rejects today
		const prepared = prepareQuestionArguments(raw);
		expect(prepared).toEqual(wellFormed);
		expect(Value.Check(QuestionParamsSchema, prepared)).toBe(true);
	});

	it.each([
		["malformed JSON", { questions: "[{not json" }],
		["a JSON string of the wrong shape", { questions: JSON.stringify({ question: "not an array" }) }],
		["a plain-text element", { questions: ["just some text"] }],
		["a non-object argument", "questions"],
	])("leaves %s untouched so validation still reports the real problem", (_name, raw) => {
		expect(prepareQuestionArguments(raw)).toEqual(raw);
	});
});
