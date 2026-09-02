import { describe, expect, it } from "vitest";
import { normalizeLineTerminators, normalizeQuestionParams } from "./normalize-params.js";
import type { QuestionParams } from "./types.js";

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
