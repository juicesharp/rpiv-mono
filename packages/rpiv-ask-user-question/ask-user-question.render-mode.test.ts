import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import type { QuestionnaireSessionComponent } from "./state/questionnaire-session.js";
import type { QuestionnaireResult } from "./tool/types.js";

let root: string;
let configPath: string;
const params = {
	questions: [
		{
			question: "Where should the dialog appear?",
			header: "Layout",
			options: [{ label: "Inline" }, { label: "Overlay" }],
		},
	],
};
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function configure(renderMode: string): void {
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, JSON.stringify({ renderMode }));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "rpiv-question-render-"));
	vi.stubEnv("XDG_CONFIG_HOME", root);
	configPath = join(root, "rpiv-ask-user-question", "config.json");
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("questionnaire presentation", () => {
	it("an inline questionnaire keeps its visible collapse row and still submits an answer", async () => {
		// Inline presentation replaces Pi's editor area instead of covering the transcript.
		configure("inline");
		const { pi, captured } = createMockPi();
		registerAskUserQuestionTool(pi);
		const onTerminalInput = vi.fn();
		const custom = vi.fn(
			async (
				factory: (
					tui: unknown,
					activeTheme: unknown,
					keybindings: unknown,
					done: (result: QuestionnaireResult) => void,
				) => QuestionnaireSessionComponent,
				options?: { overlay?: boolean },
			) => {
				expect(options?.overlay).toBe(false);
				let result: QuestionnaireResult | undefined;
				const component = factory(
					{ requestRender() {}, terminal: { columns: 100, rows: 24 } },
					theme,
					getKeybindings(),
					(answer) => {
						result = answer;
					},
				);
				expect(component.render(100).length).toBeGreaterThan(1);
				// Inline has no overlay handle: collapse must remain reachable through the component.
				component.handleInput("\x1d");
				expect(component.render(100)).toHaveLength(1);
				component.handleInput("\x1d");
				expect(component.render(100).length).toBeGreaterThan(1);
				component.handleInput("\r");
				return result;
			},
		);
		const ctx = createMockCtx({ hasUI: true, ui: { custom, onTerminalInput } as never });
		const result = await captured.tools.get("ask_user_question")!.execute!(
			"tc",
			params as never,
			undefined,
			undefined,
			ctx as never,
		);
		expect(result.details).toMatchObject({ cancelled: false, answers: [{ kind: "option", answer: "Inline" }] });
		expect(onTerminalInput).not.toHaveBeenCalled();
	});

	it.each([undefined, "overlay", "unknown"])("keeps overlay behavior for renderMode=%s", async (mode) => {
		if (mode !== undefined) configure(mode);
		const { pi, captured } = createMockPi();
		registerAskUserQuestionTool(pi);
		const removeListener = vi.fn();
		const onTerminalInput = vi.fn(() => removeListener);
		const custom = vi.fn(async (_factory: unknown, _options: unknown) => ({ answers: [], cancelled: true }));
		const ctx = createMockCtx({ hasUI: true, ui: { custom, onTerminalInput } as never });
		await captured.tools.get("ask_user_question")!.execute!(
			"tc",
			params as never,
			undefined,
			undefined,
			ctx as never,
		);
		expect(custom.mock.calls[0]?.[1]).toMatchObject({ overlay: true, overlayOptions: { anchor: "bottom-center" } });
		expect(onTerminalInput).toHaveBeenCalledOnce();
		expect(removeListener).toHaveBeenCalledOnce();
	});
});
