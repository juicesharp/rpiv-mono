import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type TUI } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { buildItemsForQuestion } from "../ask-user-question.js";
import type { QuestionData, QuestionnaireResult } from "../tool/types.js";
import type { QuestionnaireMouseEvent } from "./mouse-input.js";
import { QuestionnaireSession } from "./questionnaire-session.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const TAB = "\t";
const ENTER = "<REMAPPED_SUBMIT>";
const CTRL_G = "\x07";
const question: QuestionData = {
	question: "Which approach?",
	header: "Approach",
	options: [
		{ label: "Alpha", description: "First approach" },
		{ label: "Beta", description: "Second approach" },
	],
};

function makeSession(
	options: {
		questions?: QuestionData[];
		width?: number;
		rows?: number;
		editInput?: () => Promise<string | undefined>;
	} = {},
) {
	const questions = options.questions ?? [question];
	const terminal = { columns: options.width ?? 120, rows: options.rows ?? 40 };
	const requestRender = vi.fn();
	const done = vi.fn<(result: QuestionnaireResult) => void>();
	const session = new QuestionnaireSession({
		tui: { terminal, requestRender } as unknown as TUI,
		theme: makeTheme({ bold: (text) => `\x1b[1m${text}\x1b[22m` }) as unknown as Theme,
		params: { questions },
		itemsByTab: questions.map(buildItemsForQuestion),
		done,
		keybindings: {
			matches(data, name) {
				return (
					data ===
					(
						{
							"tui.select.up": UP,
							"tui.select.down": DOWN,
							"tui.input.submit": ENTER,
							"app.editor.external": CTRL_G,
						} as Record<string, string>
					)[name]
				);
			},
		},
		editInput: options.editInput ?? (async () => undefined),
		collapseKey: "off",
		canReopenWhileHidden: false,
	});
	const render = () => session.component.render(terminal.columns);
	const row = (text: string) => {
		const y = render().findIndex((line) => line.includes(text));
		expect(y, `visible row for ${text}`).toBeGreaterThanOrEqual(0);
		return y;
	};
	const mouse = (type: QuestionnaireMouseEvent["type"], y: number, overrides: Partial<QuestionnaireMouseEvent> = {}) =>
		session.component.handleMouse({
			type,
			button: type === "move" ? "none" : "left",
			x: 2,
			y,
			shift: false,
			alt: false,
			ctrl: false,
			...overrides,
		});
	const click = (text: string) => {
		const y = row(text);
		mouse("press", y);
		mouse("release", y);
		return mouse("click", y);
	};
	return { session, terminal, requestRender, done, render, row, mouse, click };
}

const previews: QuestionData = {
	...question,
	options: question.options.map((option) => ({ ...option, preview: `artifact-${option.label}` })),
};

const multi: QuestionData = { ...question, multiSelect: true };

describe("QuestionnaireSession — normalized pointer input", () => {
	it("hover highlights without confirming or moving keyboard focus", () => {
		const { session, row, render, mouse, done } = makeSession();
		const y = row("2. Beta");
		expect(render()[y]).not.toContain("\x1b[1m");
		expect(mouse("move", y)).toEqual({ handled: true, render: true });
		expect(render()[y]).toContain("\x1b[1m");
		expect(done).not.toHaveBeenCalled();
		session.dispatch(ENTER);
		expect(done).toHaveBeenCalledWith({ answers: [expect.objectContaining({ answer: "Alpha" })], cancelled: false });
	});

	it("repeated motion on the same row does not request another render", () => {
		const { row, mouse, requestRender } = makeSession();
		const y = row("2. Beta");
		mouse("move", y);
		requestRender.mockClear();
		expect(mouse("move", y)).toEqual({ handled: true, render: false });
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("moving onto chrome clears hover", () => {
		const { row, mouse, render } = makeSession();
		const y = row("2. Beta");
		mouse("move", y);
		mouse("move", 0);
		expect(render()[y]).not.toContain("\x1b[1m");
	});

	it("hovering custom text never activates or submits the editor", () => {
		const { row, mouse, render, done } = makeSession();
		mouse("move", row("Type something."));
		expect(render().join("\n")).not.toContain(CURSOR_MARKER);
		expect(done).not.toHaveBeenCalled();
	});

	it("click confirms the clicked option even with remapped confirmation keys", () => {
		const { click, done } = makeSession();
		expect(click("2. Beta")).toEqual({ handled: true });
		expect(done).toHaveBeenCalledWith({ answers: [expect.objectContaining({ answer: "Beta" })], cancelled: false });
	});

	it("a wrapped description is part of its option's click target", () => {
		const { click, done } = makeSession({
			width: 25,
			questions: [
				{
					...question,
					options: [question.options[0]!, { label: "Beta", description: "long description ending uniquely" }],
				},
			],
		});
		click("uniquely");
		expect(done.mock.calls[0]?.[0].answers[0]?.answer).toBe("Beta");
	});

	it("wraps long headings without shifting option hit targets", () => {
		const { click, done } = makeSession({
			width: 25,
			questions: [
				{
					...question,
					header: "A long header that wraps onto another row",
					question: "A long question that also wraps over several lines?",
				},
			],
		});
		click("2. Beta");
		expect(done.mock.calls[0]?.[0].answers[0]?.answer).toBe("Beta");
	});

	it("press and drag alone do not navigate or confirm", () => {
		const { session, row, mouse, done } = makeSession();
		const y = row("2. Beta");
		mouse("press", y);
		mouse("drag", y + 1);
		mouse("release", y + 1);
		expect(done).not.toHaveBeenCalled();
		session.dispatch(ENTER);
		expect(done.mock.calls[0]?.[0].answers[0]?.answer).toBe("Alpha");
	});

	it.each(["right", "middle", "none"] as const)("ignores %s-button clicks", (button) => {
		const { row, mouse, done } = makeSession();
		expect(mouse("click", row("2. Beta"), { button })).toBeUndefined();
		expect(done).not.toHaveBeenCalled();
	});

	it.each(["shift", "alt", "ctrl"] as const)("leaves %s-modified input to the host", (modifier) => {
		const { row, mouse, done } = makeSession();
		expect(mouse("click", row("2. Beta"), { [modifier]: true })).toBeUndefined();
		expect(done).not.toHaveBeenCalled();
	});

	it("does not swallow the mouse wheel", () => {
		const { row, mouse } = makeSession();
		expect(mouse("wheel", row("2. Beta"))).toBeUndefined();
	});

	it("ignores clicks before a render or outside the rendered option column", () => {
		const { mouse, render, done } = makeSession();
		expect(mouse("click", 5)).toBeUndefined();
		render();
		for (const [x, y] of [
			[-1, 5],
			[120, 5],
			[2, -1],
			[2, 200],
			[2, 0],
		]) {
			expect(mouse("click", y!, { x })).toBeUndefined();
		}
		expect(done).not.toHaveBeenCalled();
	});

	it("ignores repeated clicks after completion", () => {
		const { click, mouse, done } = makeSession();
		click("2. Beta");
		mouse("click", 5);
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("clicking custom text focuses the editor and preserves the draft when navigating away", () => {
		const { session, click, render, done } = makeSession({
			questions: [question, { ...question, header: "Second" }],
		});
		click("Type something.");
		expect(done).not.toHaveBeenCalled();
		expect(render().join("\n")).toContain(CURSOR_MARKER);
		session.dispatch("precious draft");
		click("2. Beta");
		session.dispatch(TAB);
		session.dispatch(TAB);
		click("precious draft");
		session.dispatch(ENTER);
		session.dispatch(TAB);
		session.dispatch(TAB);
		expect(render().join("\n")).toContain("precious draft");
	});

	it("mouse movement never steals focus while typing", () => {
		const { session, click, row, mouse, render } = makeSession();
		click("Type something.");
		session.dispatch("draft");
		expect(mouse("move", row("2. Beta"))).toBeUndefined();
		expect(render().join("\n")).toContain(CURSOR_MARKER);
	});

	it("mouse input is inactive while notes are open or the dialog is collapsed", () => {
		const { session, row, mouse, done } = makeSession();
		const y = row("2. Beta");
		session.dispatch("n");
		expect(mouse("click", y)).toBeUndefined();
		session.dispatch(ENTER);
		session.toggleCollapsedExternal();
		expect(mouse("move", y)).toBeUndefined();
		expect(mouse("click", y)).toBeUndefined();
		expect(done).not.toHaveBeenCalled();
	});

	it("mouse input is exclusive while the external editor is open", async () => {
		let resolve!: (value: string) => void;
		const { session, click, row, mouse, done } = makeSession({
			editInput: () =>
				new Promise((r) => {
					resolve = r;
				}),
		});
		click("Type something.");
		session.dispatch(CTRL_G);
		expect(mouse("click", row("2. Beta"))).toBeUndefined();
		resolve("edited draft");
		await Promise.resolve();
		session.dispatch(ENTER);
		expect(done.mock.calls[0]?.[0].answers[0]?.answer).toBe("edited draft");
	});

	it("updates hit targets after terminal resize", () => {
		const { terminal, click, done } = makeSession({
			questions: [
				{
					...question,
					options: [question.options[0]!, { label: "Beta", description: "long description ending uniquely" }],
				},
			],
		});
		terminal.columns = 25;
		click("uniquely");
		expect(done.mock.calls[0]?.[0].answers[0]?.answer).toBe("Beta");
	});

	it.each([80, 120])("hover updates previews and click confirms at width %i", (width) => {
		const { render, row, mouse, click, done } = makeSession({ width, questions: [previews] });
		mouse("move", row("2. Beta"));
		expect(render().join("\n")).toContain("artifact-Beta");
		click("2. Beta");
		expect(done.mock.calls[0]?.[0].answers[0]).toMatchObject({ answer: "Beta", preview: "artifact-Beta" });
	});

	it("preview text and the side-by-side gap are not option targets", () => {
		const { row, mouse, render, done } = makeSession({ questions: [previews] });
		const lines = render();
		const y = row("artifact-Alpha");
		const plain = lines[y]!.replace(/\x1b\[[0-9;]*m/g, "");
		const x = plain.indexOf("artifact-Alpha");
		expect(mouse("click", y, { x })).toBeUndefined();
		expect(mouse("click", y, { x: x - 3 })).toBeUndefined();
		expect(done).not.toHaveBeenCalled();
	});

	it("stacked preview text is not an option target", () => {
		const { row, mouse, done } = makeSession({ width: 80, questions: [previews] });
		expect(mouse("click", row("artifact-Alpha"))).toBeUndefined();
		expect(done).not.toHaveBeenCalled();
	});

	it("multi-select clicks toggle once and Next commits the checked options", () => {
		const { click, done, render } = makeSession({ questions: [multi] });
		click("Beta");
		expect(
			render()
				.join("\n")
				.replace(/\x1b\[[0-9;]*m/g, ""),
		).toContain("[✔] Beta");
		expect(done).not.toHaveBeenCalled();
		click("Alpha");
		click("Beta");
		click("Submit");
		expect(done.mock.calls[0]?.[0].answers[0]?.selected).toEqual(["Alpha"]);
	});

	it("multi-select hover is a highlight, not a checkbox toggle", () => {
		const { row, mouse, render, done } = makeSession({ questions: [multi] });
		mouse("move", row("Beta"));
		expect(render().join("\n")).not.toContain("[✔]");
		expect(done).not.toHaveBeenCalled();
	});

	it.each(["Submit answers", "Cancel"])("clicks %s on the Submit tab", (label) => {
		const { session, click, done } = makeSession({ questions: [question, question] });
		session.dispatch(TAB);
		session.dispatch(TAB);
		click(label);
		expect(done).toHaveBeenCalledWith({ answers: [], cancelled: label === "Cancel" });
	});

	it("a double-click cannot accidentally confirm a second question", () => {
		const { row, mouse, click, render, done } = makeSession({ questions: [question, question] });
		click("2. Beta");
		expect(mouse("click", row("2. Beta"), { clickCount: 2 })).toBeUndefined();
		expect(render().join("\n")).not.toContain("Review your answers");
		expect(done).not.toHaveBeenCalled();
	});

	it("overflow arrows never target the options they replace", () => {
		const { render, mouse, done } = makeSession({
			width: 35,
			rows: 12,
			questions: [
				{
					...question,
					options: question.options.map((option) => ({
						...option,
						description: "A long description that wraps over several lines in a short terminal",
					})),
				},
			],
		});
		const lines = render();
		const arrows = lines.flatMap((line, y) => (/^[↑↓↕]$/.test(line) ? [y] : []));
		expect(arrows.length).toBeGreaterThan(0);
		for (const y of arrows) expect(mouse("click", y)).toBeUndefined();
		expect(done).not.toHaveBeenCalled();
	});

	it("a chrome-only terminal has no invisible option targets", () => {
		const { render, mouse, done } = makeSession({ rows: 4 });
		const lines = render();
		for (let y = 0; y < lines.length; y++) expect(mouse("click", y)).toBeUndefined();
		expect(done).not.toHaveBeenCalled();
	});
});
