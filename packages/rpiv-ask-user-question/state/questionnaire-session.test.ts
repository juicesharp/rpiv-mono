import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import type { QuestionnaireResult, QuestionParams } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import { QuestionnaireSession } from "./questionnaire-session.js";

const DOWN = "<DOWN>";
const UP = "<UP>";
const ENTER = "<ENTER>";
const ESC = "\x1b";
const CTRL_G = "\x07";
const CTRL_U = "\x15";

const params: QuestionParams = {
	questions: [
		{
			question: "Which?",
			header: "Pick",
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		},
	],
};

const itemsByTab: WrappingSelectItem[][] = [
	[
		{ kind: "option", label: "A", description: "a" },
		{ kind: "option", label: "B", description: "b" },
		{ kind: "other", label: "Type something." },
	],
];

const keybindings = {
	matches(data: string, name: string): boolean {
		switch (name) {
			case "tui.select.up":
				return data === UP;
			case "tui.select.down":
				return data === DOWN;
			case "tui.select.confirm":
				return data === ENTER;
			case "tui.select.cancel":
				return data === ESC;
			case "tui.editor.deleteToLineStart":
				return data === CTRL_U;
			case "app.editor.external":
				return data === CTRL_G;
			default:
				return false;
		}
	},
};

function makeSession(editInput: (value: string) => Promise<string | undefined> = async () => undefined) {
	const done = vi.fn<(result: QuestionnaireResult) => void>();
	const session = new QuestionnaireSession({
		tui: { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() },
		theme: makeTheme() as unknown as Theme,
		params,
		itemsByTab,
		done,
		keybindings,
		editInput,
		collapseKey: "off",
	});
	return { session, done };
}

function focusCustomAnswer(session: QuestionnaireSession): void {
	session.dispatch(DOWN);
	session.dispatch(DOWN);
}

describe("QuestionnaireSession — custom-answer drafts", () => {
	it("preserves a draft while browsing options and restores it on return", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("draft answer");
		session.dispatch(UP);
		const browsingView = session.component.render(120).join("\n");
		expect(browsingView).toContain("draft answer");
		expect(browsingView).not.toContain("Type something.");
		session.dispatch(DOWN);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [
				{
					questionIndex: 0,
					question: "Which?",
					kind: "custom",
					answer: "draft answer",
				},
			],
			cancelled: false,
		});
	});

	it("clears the whole draft with Pi's Ctrl+U line-kill binding", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("discard me");
		session.dispatch(CTRL_U);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: null })],
			cancelled: false,
		});
	});

	it("replaces the inline draft with the external editor result", async () => {
		const editInput = vi.fn(async (value: string) => `${value} + edited`);
		const { session, done } = makeSession(editInput);
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.dispatch(CTRL_G);
		await Promise.resolve();
		await Promise.resolve();
		expect(editInput).toHaveBeenCalledWith("draft");
		session.dispatch(ENTER);

		expect(done).toHaveBeenLastCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "draft + edited" })],
			cancelled: false,
		});
	});
});
