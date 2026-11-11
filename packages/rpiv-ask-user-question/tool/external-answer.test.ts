import { describe, expect, it } from "vitest";
import { resolveExternalAnswer } from "./external-answer.ts";
import type { QuestionData } from "./types.ts";

const single: QuestionData = {
	question: "Which?",
	header: "Pick",
	options: [
		{ label: "A", description: "a" },
		{ label: "B", description: "b", preview: "```\nb\n```" },
	],
};
const multi: QuestionData = {
	question: "Which ones?",
	header: "Many",
	multiSelect: true,
	options: [
		{ label: "X", description: "x" },
		{ label: "Y", description: "y" },
		{ label: "Z", description: "z" },
	],
};
const questions = [single, multi];

const resolve = (answers: unknown, extra: Record<string, unknown> = {}) =>
	resolveExternalAnswer(questions, { answers, ...extra });
const both = (first: Record<string, unknown>, second: Record<string, unknown> = { optionIndexes: [0] }) =>
	resolve([
		{ questionIndex: 0, ...first },
		{ questionIndex: 1, ...second },
	]);
const codeOf = (o: ReturnType<typeof resolve>) => (o.ok ? "ok" : o.code);

describe("resolveExternalAnswer — answers shaped like the TUI's", () => {
	it("single-select option carries its preview; custom text keeps its exact value", () => {
		const out = both({ optionIndexes: [1] }, { text: "  my own  " });
		expect(out).toEqual({
			ok: true,
			result: {
				cancelled: false,
				answers: [
					{ questionIndex: 0, question: "Which?", kind: "option", answer: "B", preview: "```\nb\n```" },
					{ questionIndex: 1, question: "Which ones?", kind: "multi", answer: "  my own  ", selected: [] },
				],
			},
		});
	});

	it("multi-select: labels in authored order, and options plus custom text in one answer (#188)", () => {
		const out = both({ text: "mine" }, { optionIndexes: [2, 0], text: "also this" });
		expect(out.ok && out.result.answers).toEqual([
			{ questionIndex: 0, question: "Which?", kind: "custom", answer: "mine" },
			{ questionIndex: 1, question: "Which ones?", kind: "multi", answer: "also this", selected: ["X", "Z"] },
		]);
	});

	it("notes and the global note are trimmed, and dropped when blank", () => {
		const out = resolve(
			[
				{ questionIndex: 0, optionIndexes: [0], notes: "  why  " },
				{ questionIndex: 1, optionIndexes: [1], notes: "   " },
			],
			{ globalNote: " overall " },
		);
		expect(out.ok && out.result).toEqual({
			cancelled: false,
			globalNote: "overall",
			answers: [
				{ questionIndex: 0, question: "Which?", kind: "option", answer: "A", notes: "why" },
				{ questionIndex: 1, question: "Which ones?", kind: "multi", answer: null, selected: ["Y"] },
			],
		});
	});

	it("entry order does not matter", () => {
		const out = resolve([
			{ questionIndex: 1, optionIndexes: [0] },
			{ questionIndex: 0, optionIndexes: [0] },
		]);
		expect(out.ok && out.result.answers.map((a) => a.questionIndex)).toEqual([0, 1]);
	});
});

describe("resolveExternalAnswer — cancel", () => {
	it("declines, keeping a global note like the TUI's Esc", () => {
		expect(resolveExternalAnswer(questions, { cancel: true, globalNote: "later" })).toEqual({
			ok: true,
			result: { answers: [], cancelled: true, globalNote: "later" },
		});
		expect(resolveExternalAnswer(questions, { cancel: true, answers: [] })).toMatchObject({ ok: true });
	});

	it("takes no answers", () => {
		expect(codeOf(resolve([{ questionIndex: 0, optionIndexes: [0] }], { cancel: true }))).toBe("invalid_payload");
	});

	it("cancel: false is an ordinary answer", () => {
		expect(codeOf(both({ optionIndexes: [0] }))).toBe("ok");
		expect(
			codeOf(
				resolve(
					[
						{ questionIndex: 0, optionIndexes: [0] },
						{ questionIndex: 1, optionIndexes: [0] },
					],
					{ cancel: false },
				),
			),
		).toBe("ok");
	});
});

describe("resolveExternalAnswer — strict", () => {
	it.each([
		["answers missing", resolveExternalAnswer(questions, {})],
		["answers not an array", resolve({})],
		["entry not an object", resolve([null])],
		["questionIndex not an integer", resolve([{ questionIndex: "0" }])],
		["optionIndexes not an array", both({ optionIndexes: 1 })],
		["optionIndexes not integers", both({ optionIndexes: [0.5] })],
		["text not a string", both({ text: 3 })],
		["notes not a string", both({ optionIndexes: [0], notes: {} })],
		["globalNote not a string", resolve([], { globalNote: 1 })],
		["cancel not a boolean", resolveExternalAnswer(questions, { cancel: 1 })],
	])("invalid_payload: %s", (_name, out) => {
		expect(codeOf(out)).toBe("invalid_payload");
	});

	it.each([
		["a question unanswered", resolve([{ questionIndex: 0, optionIndexes: [0] }])],
		[
			"a question answered twice",
			resolve([
				{ questionIndex: 0, optionIndexes: [0] },
				{ questionIndex: 0, optionIndexes: [1] },
				{ questionIndex: 1, optionIndexes: [0] },
			]),
		],
		["questionIndex out of range", resolve([{ questionIndex: 2, optionIndexes: [0] }])],
		["option index out of range", both({ optionIndexes: [2] })],
		["option index repeated", both({ optionIndexes: [0] }, { optionIndexes: [1, 1] })],
		["single-select with two options", both({ optionIndexes: [0, 1] })],
		["single-select with an option and text", both({ optionIndexes: [0], text: "t" })],
		["neither options nor text", both({ optionIndexes: [] })],
		["blank text", both({ text: "   " })],
		["blank text on multi-select", both({ optionIndexes: [0] }, { optionIndexes: [0], text: " " })],
	])("invalid_answer: %s", (_name, out) => {
		expect(codeOf(out)).toBe("invalid_answer");
	});

	it("ignores unknown fields", () => {
		expect(
			codeOf(
				resolve(
					[
						{ questionIndex: 0, optionIndexes: [0], extra: 1 },
						{ questionIndex: 1, text: "t" },
					],
					{ x: 1 },
				),
			),
		).toBe("ok");
	});
});
