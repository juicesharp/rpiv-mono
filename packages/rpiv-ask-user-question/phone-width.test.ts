import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.ts";

// The dialog on a phone: an SSH app on a phone in portrait shows about 45 columns,
// and with the on-screen keyboard up, about 16 rows.

interface RenderableComponent {
	render: (w: number) => string[];
	handleInput: (data: string) => void;
}

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

const KEY = { DOWN: "\x1b[B", ESC: "\x1b" };

const commitDates = {
	question: "Which dates should the new commits use?",
	header: "New commit dates",
	options: [
		{
			label: "Actual file-save times (Recommended)",
			description: "Nov 5, 2026, about 11:00-11:10 PM, when the files were last changed. These are true dates.",
		},
		{ label: "Today", description: "Nov 21, 2026, with the current time on each commit." },
	],
};
const forcePush = { question: "Force-push main?", header: "Force-push", options: [{ label: "Yes" }, { label: "No" }] };
const unused = {
	question: "Delete unused files?",
	header: "Unused files",
	options: [{ label: "Yes" }, { label: "No" }],
};

/** Opens the questionnaire on a `columns`×`rows` terminal, runs `script`, then cancels it. */
async function onTerminal(
	columns: number,
	rows: number,
	questions: unknown[],
	script: (dialog: RenderableComponent) => void,
): Promise<void> {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	const tool = captured.tools.get("ask_user_question")!;
	const custom = (factory: unknown) =>
		new Promise((resolve) => {
			const dialog = (factory as (...args: unknown[]) => RenderableComponent)(
				{ requestRender() {}, terminal: { columns, rows } },
				identityTheme,
				getKeybindings(),
				resolve,
			);
			script(dialog);
			dialog.handleInput(KEY.ESC);
		});
	const ctx = { hasUI: true, ui: { custom } } as never;
	await tool.execute?.("tc", { questions } as never, undefined as never, undefined as never, ctx);
}

/** The key hints: the dialog's last row of text (blank rows may pad it to a steady height). */
const hintLine = (lines: string[]) =>
	lines
		.filter((line) => line.trim() !== "")
		.at(-1)!
		.trim();

describe("ask_user_question on a 45-column phone screen", () => {
	it("shortens the key hints so every key fits on one row", async () => {
		await onTerminal(45, 16, [commitDates, forcePush, unused], (dialog) => {
			const lines = dialog.render(45);
			expect(hintLine(lines)).toBe("Enter · ↑/↓ · n notes · Tab · Esc · ^] hide");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(45);
		});
	});

	it("keeps the full key hints where they fit", async () => {
		await onTerminal(160, 40, [commitDates, forcePush, unused], (dialog) => {
			expect(hintLine(dialog.render(160))).toBe(
				"Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel · Ctrl+] to collapse",
			);
		});
	});
});
