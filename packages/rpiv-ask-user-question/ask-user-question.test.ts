import { describe, expect, it } from "vitest";
import { buildItemsForQuestion, buildQuestionnaireResponse, buildToolResult } from "./ask-user-question.js";
import type { QuestionnaireResult, QuestionParams } from "./types.js";

describe("buildItemsForQuestion", () => {
	it("appends the Type-something sentinel", () => {
		const items = buildItemsForQuestion({
			question: "q",
			header: "H",
			options: [
				{ label: "A", description: "a-desc" },
				{ label: "B", description: "b-desc" },
			],
		});
		expect(items).toEqual([
			{ label: "A", description: "a-desc" },
			{ label: "B", description: "b-desc" },
			{ label: "Type something.", isOther: true },
		]);
	});

	it("skips the sentinel when multiSelect is true", () => {
		const items = buildItemsForQuestion({
			question: "Pick areas",
			header: "Areas",
			multiSelect: true,
			options: [
				{ label: "FE", description: "Frontend" },
				{ label: "BE", description: "Backend" },
				{ label: "Tests", description: "Tests" },
			],
		});
		expect(items).toEqual([
			{ label: "FE", description: "Frontend" },
			{ label: "BE", description: "Backend" },
			{ label: "Tests", description: "Tests" },
		]);
		expect(items.some((i) => i.isOther)).toBe(false);
	});

	it("appends the sentinel when multiSelect is false", () => {
		const items = buildItemsForQuestion({
			question: "Pick one",
			header: "Pick",
			multiSelect: false,
			options: [{ label: "Yes", description: "yes" }],
		});
		expect(items).toEqual([
			{ label: "Yes", description: "yes" },
			{ label: "Type something.", isOther: true },
		]);
	});

	it("appends the sentinel when multiSelect is undefined (default single-select)", () => {
		const items = buildItemsForQuestion({
			question: "Pick one",
			header: "Pick",
			options: [{ label: "No", description: "no" }],
		});
		expect(items).toHaveLength(2);
		expect(items[1]).toEqual({ label: "Type something.", isOther: true });
	});

	it("skips the sentinel when any single-select option carries a preview", () => {
		const items = buildItemsForQuestion({
			question: "Layout?",
			header: "Layout",
			options: [
				{ label: "Centered", description: "centered logo", preview: "## Centered\n\nbody" },
				{ label: "Left", description: "left logo" },
			],
		});
		expect(items).toEqual([
			{ label: "Centered", description: "centered logo" },
			{ label: "Left", description: "left logo" },
		]);
		expect(items.some((i) => i.isOther)).toBe(false);
	});

	it("appends the sentinel when single-select options have only empty-string previews", () => {
		const items = buildItemsForQuestion({
			question: "Pick",
			header: "Pick",
			options: [
				{ label: "A", description: "a", preview: "" },
				{ label: "B", description: "b" },
			],
		});
		expect(items).toHaveLength(3);
		expect(items[2]).toEqual({ label: "Type something.", isOther: true });
	});

	it("skips the sentinel for multiSelect even if an option has a preview", () => {
		const items = buildItemsForQuestion({
			question: "Areas",
			header: "Areas",
			multiSelect: true,
			options: [
				{ label: "FE", description: "Frontend", preview: "## FE" },
				{ label: "BE", description: "Backend" },
			],
		});
		expect(items).toEqual([
			{ label: "FE", description: "Frontend" },
			{ label: "BE", description: "Backend" },
		]);
		expect(items.some((i) => i.isOther)).toBe(false);
	});
});

describe("buildQuestionnaireResponse — cancelled", () => {
	const params: QuestionParams = {
		questions: [
			{
				question: "Q?",
				header: "H",
				options: [
					{ label: "A", description: "a" },
					{ label: "B", description: "b" },
				],
			},
		],
	};

	it("null result → decline envelope + empty answers + cancelled true", () => {
		const r = buildQuestionnaireResponse(null, params);
		expect(r.content[0]).toEqual({ type: "text", text: "User declined to answer questions" });
		expect(r.details.cancelled).toBe(true);
		expect(r.details.answers).toEqual([]);
	});

	it("cancelled result preserves partial answers in details (not in content)", () => {
		const result: QuestionnaireResult = {
			cancelled: true,
			answers: [{ questionIndex: 0, question: "Q?", answer: "A", wasCustom: false }],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0]).toMatchObject({ text: "User declined to answer questions" });
		expect(r.details.cancelled).toBe(true);
		expect(r.details.answers).toEqual(result.answers);
	});
});

describe("buildQuestionnaireResponse — completed", () => {
	it("single answered question → CC envelope wrapper with question text and answer", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Pick one",
					header: "Architecture",
					options: [
						{ label: "Option A", description: "First" },
						{ label: "B", description: "Second" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Pick one", answer: "Option A", wasCustom: false }],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0]).toEqual({
			type: "text",
			text: 'User has answered your questions: "Pick one"="Option A". You can now continue with the user\'s answers in mind.',
		});
		expect(r.details).toBe(result);
	});

	it("envelope uses question text not header (no Q1 prefix)", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Pick",
					header: "Pick",
					options: [
						{ label: "Yes", description: "Y" },
						{ label: "No", description: "N" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Pick", answer: "Yes" }],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0].text).toContain('"Pick"="Yes"');
		expect(r.content[0].text).not.toContain("Q1");
	});

	it("two answered questions render as separate sentences inside one envelope", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Q1?",
					header: "H1",
					options: [
						{ label: "Yes", description: "Y" },
						{ label: "No", description: "N" },
					],
				},
				{
					question: "Q2?",
					header: "Real",
					options: [
						{ label: "Yes", description: "Y" },
						{ label: "No", description: "N" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [
				{ questionIndex: 0, question: "Q1?", answer: "Yes" },
				{ questionIndex: 1, question: "Q2?", answer: "No" },
			],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0].text.split("\n").length).toBe(1);
		expect(r.content[0].text).toContain('"Q1?"="Yes"');
		expect(r.content[0].text).toContain('"Q2?"="No"');
	});

	it("multiSelect answer renders as comma-joined labels in <A> position", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Areas",
					header: "Areas",
					multiSelect: true,
					options: [
						{ label: "FE", description: "Frontend" },
						{ label: "BE", description: "Backend" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Areas", answer: null, selected: ["FE", "BE"] }],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0].text).toContain('"Areas"="FE, BE"');
	});

	it("custom typed answer renders raw text (no 'User answered:' prefix)", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Free?",
					header: "Free",
					options: [
						{ label: "Yes", description: "Y" },
						{ label: "No", description: "N" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Free?", answer: "my custom", wasCustom: true }],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0].text).toContain('"Free?"="my custom"');
		expect(r.content[0].text).not.toContain("User answered:");
	});

	it("empty custom answer renders as (no input) in <A> position", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Free?",
					header: "H",
					options: [
						{ label: "Yes", description: "Y" },
						{ label: "No", description: "N" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Free?", answer: null, wasCustom: true }],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0].text).toContain('"Free?"="(no input)"');
	});

	it("chat answer's <A> is the chat continuation message verbatim", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Help",
					header: "Help",
					options: [
						{ label: "Yes", description: "Y" },
						{ label: "No", description: "N" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Help", answer: "Chat about this", wasChat: true }],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0].text).toContain("Continue the conversation");
	});

	it("notes are echoed as 'user notes: <text>' AND preserved in details", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Pick",
					header: "H",
					options: [
						{ label: "Yes", description: "Y" },
						{ label: "No", description: "N" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Pick", answer: "Yes", notes: "because of X" }],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0].text).toContain("user notes: because of X");
		expect(r.details.answers[0].notes).toBe("because of X");
	});

	it("cancelled: false with no matching answers still returns DECLINE_MESSAGE text", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Q?",
					header: "H",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
			],
		};
		const result: QuestionnaireResult = { cancelled: false, answers: [] };
		const r = buildQuestionnaireResponse(result, params);
		expect(r.details.cancelled).toBe(true);
		expect(r.content[0]).toEqual({ type: "text", text: "User declined to answer questions" });
	});
});

describe("buildQuestionnaireResponse — multi-question mixed types", () => {
	it("formats 2 answered questions as comma-period-separated segments inside one envelope", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Framework?",
					header: "Framework",
					options: [
						{ label: "React", description: "R" },
						{ label: "Vue", description: "V" },
					],
				},
				{
					question: "Areas?",
					header: "Areas",
					multiSelect: true,
					options: [
						{ label: "FE", description: "Frontend" },
						{ label: "BE", description: "Backend" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [
				{ questionIndex: 0, question: "Framework?", answer: "React", wasCustom: false },
				{ questionIndex: 1, question: "Areas?", answer: null, selected: ["FE", "BE"] },
			],
		};
		const r = buildQuestionnaireResponse(result, params);
		const text = r.content[0].text;
		expect(text).toContain('"Framework?"="React"');
		expect(text).toContain('"Areas?"="FE, BE"');
		expect(text.split("\n").length).toBe(1);
	});

	it("formats 3 questions with mixed answer types in single-line envelope", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Q1?",
					header: "Scope",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
				{
					question: "Q2?",
					header: "Custom",
					options: [
						{ label: "X", description: "x" },
						{ label: "Y", description: "y" },
					],
				},
				{
					question: "Q3?",
					header: "Help",
					options: [
						{ label: "Y", description: "y" },
						{ label: "N", description: "n" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [
				{ questionIndex: 0, question: "Q1?", answer: "A", wasCustom: false },
				{ questionIndex: 1, question: "Q2?", answer: "my own thing", wasCustom: true },
				{ questionIndex: 2, question: "Q3?", answer: "Chat about this", wasChat: true },
			],
		};
		const r = buildQuestionnaireResponse(result, params);
		const text = r.content[0].text;
		expect(text).toContain('"Q1?"="A"');
		expect(text).toContain('"Q2?"="my own thing"');
		expect(text).toContain("Continue the conversation");
	});

	it("skips unanswered questions (omits their segment from envelope)", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Q1?",
					header: "First",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
				{
					question: "Q2?",
					header: "Second",
					options: [
						{ label: "B", description: "b" },
						{ label: "C", description: "c" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 1, question: "Q2?", answer: "B", wasCustom: false }],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0].text).toBe(
			'User has answered your questions: "Q2?"="B". You can now continue with the user\'s answers in mind.',
		);
		expect(r.content[0].text).not.toContain("Q1?");
	});

	it("preserves notes in details AND echoes them across multiple questions", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Q1?",
					header: "H1",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
				{
					question: "Q2?",
					header: "H2",
					options: [
						{ label: "B", description: "b" },
						{ label: "C", description: "c" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [
				{ questionIndex: 0, question: "Q1?", answer: "A", notes: "secret note 1" },
				{ questionIndex: 1, question: "Q2?", answer: "B", notes: "secret note 2" },
			],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0].text).toContain("user notes: secret note 1");
		expect(r.content[0].text).toContain("user notes: secret note 2");
		expect(r.details.answers[0].notes).toBe("secret note 1");
		expect(r.details.answers[1].notes).toBe("secret note 2");
	});
});

describe("buildQuestionnaireResponse — preview echo + envelope wrapper shape (Slice 3)", () => {
	it("echoes preview text in envelope when single-select answer matches a preview-bearing option", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Layout?",
					header: "Layout",
					options: [
						{ label: "Centered", description: "centered logo", preview: "## Centered\n\nbody" },
						{ label: "Left", description: "left logo" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [
				{
					questionIndex: 0,
					question: "Layout?",
					answer: "Centered",
					wasCustom: false,
					preview: "## Centered\n\nbody",
				},
			],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0].text).toContain('"Layout?"="Centered"');
		expect(r.content[0].text).toContain("selected preview: ## Centered");
	});

	it("omits 'selected preview:' fragment when answer has no preview", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Pick?",
					header: "Pick",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Pick?", answer: "A", wasCustom: false }],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0].text).not.toContain("selected preview:");
	});

	it("omits 'user notes:' fragment when answer has no notes", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Pick?",
					header: "Pick",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Pick?", answer: "A" }],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0].text).not.toContain("user notes:");
	});

	it("envelope wraps with CC prefix and suffix sentences", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Q?",
					header: "H",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
			],
		};
		const result: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Q?", answer: "A" }],
		};
		const r = buildQuestionnaireResponse(result, params);
		expect(r.content[0].text).toMatch(/^User has answered your questions:/);
		expect(r.content[0].text).toMatch(/You can now continue with the user's answers in mind\.$/);
	});
});

describe("buildToolResult", () => {
	it("locks the envelope shape", () => {
		const details: QuestionnaireResult = { answers: [], cancelled: false };
		const r = buildToolResult("msg", details);
		expect(r).toEqual({
			content: [{ type: "text", text: "msg" }],
			details: { answers: [], cancelled: false },
		});
	});

	it("passes details by reference (no clone)", () => {
		const details: QuestionnaireResult = { answers: [], cancelled: true };
		const r = buildToolResult("msg", details);
		expect(r.details).toBe(details);
	});

	it("accepts error field in envelope", () => {
		const details: QuestionnaireResult = { answers: [], cancelled: true, error: "no_questions" };
		const r = buildToolResult("msg", details);
		expect(r).toEqual({
			content: [{ type: "text", text: "msg" }],
			details: { answers: [], cancelled: true, error: "no_questions" },
		});
	});
});
