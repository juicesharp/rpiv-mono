import { describe, expect, it } from "vitest";
import { renderQuestionnaireResult } from "./ask-user-question.js";
import type { QuestionnaireResult } from "./tool/types.js";

const identityTheme = {
	fg: (_token: string, text: string) => text,
};

function render(details: QuestionnaireResult, expanded = false, content = "model-facing envelope"): string[] {
	return renderQuestionnaireResult(
		{ content: [{ type: "text", text: content }], details },
		expanded,
		identityTheme as never,
	)
		.render(120)
		.map((line) => line.trimEnd());
}

describe("ask_user_question result rendering", () => {
	it("shows only the selected answer in the collapsed result", () => {
		expect(
			render({
				cancelled: false,
				answers: [
					{
						questionIndex: 0,
						question: "How should we proceed?",
						kind: "option",
						answer: "Close task 05 first (Recommended)",
					},
				],
			}),
		).toEqual(["Close task 05 first"]);
	});

	it("puts multiple and free-form answers on separate lines", () => {
		expect(
			render({
				cancelled: false,
				answers: [
					{
						questionIndex: 0,
						question: "First?",
						kind: "multi",
						answer: null,
						selected: ["A (Recommended)", "B"],
					},
					{ questionIndex: 1, question: "Second?", kind: "custom", answer: "A custom answer" },
				],
			}),
		).toEqual(["A, B", "A custom answer"]);
	});

	it("keeps the complete model envelope available when expanded", () => {
		const envelope = 'User has answered your questions: "Q"="A". Continue.';
		expect(
			render(
				{
					cancelled: false,
					answers: [{ questionIndex: 0, question: "Q", kind: "option", answer: "A" }],
				},
				true,
				envelope,
			),
		).toEqual([envelope]);
	});

	it("uses the full tool output for validation and runtime errors", () => {
		expect(
			render({ answers: [], cancelled: true, error: "reserved_label" }, false, "Reserved labels are invalid"),
		).toEqual(["Reserved labels are invalid"]);
	});

	it("summarizes cancellation without echoing the model envelope", () => {
		const lines = render({ answers: [], cancelled: true });
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("model-facing envelope");
	});
});
