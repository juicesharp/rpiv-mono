import { createMockCtx, createMockPi, makeTheme, makeTui } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";

type CustomFn = (...args: unknown[]) => Promise<unknown>;

/** Minimal keybindings stub — the render assertion never dispatches input. */
const keybindings = { matches: () => false };

function register() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return { tool: captured.tools.get("ask_user_question")!, captured };
}

/** The issue's reproduction: bare CRs inside every user-facing string field. */
const CR_PARAMS = {
	questions: [
		{
			question: "Which\r option\r is best?",
			header: "Pick\r",
			options: [
				{ label: "Option\rA\r (Recommended)", description: "choice with\r\r stray CR" },
				{ label: "GEMBA\r_LOG\r_FILE", description: "crlf\r\nline", preview: "a\r\nb" },
			],
		},
	],
};

describe("ask_user_question — bare CR in model-supplied text (#192)", () => {
	it("renders the TUI overlay with normalized question, header, labels, and descriptions", async () => {
		const { tool } = register();
		let rendered = "";
		// Mirror `ctx.ui.custom`: run the factory the tool hands us and render the component it returns.
		const custom = vi.fn(async (factory: (...args: never[]) => { render(width: number): string[] }) => {
			const tui = { ...makeTui(), terminal: { columns: 80, rows: 40 } };
			const component = factory(tui as never, makeTheme() as never, keybindings as never, (() => {}) as never);
			rendered = component.render(80).join("\n");
			return { answers: [], cancelled: false };
		}) as unknown as CustomFn;
		const ctx = createMockCtx({ hasUI: true, ui: { custom } as never });

		await tool.execute?.("tc", CR_PARAMS as never, undefined as never, undefined as never, ctx as never);

		expect(custom).toHaveBeenCalledTimes(1);
		expect(rendered).toContain("Which option is best?");
		expect(rendered).toContain(" Pick ");
		expect(rendered).toContain("1. OptionA (Recommended)");
		expect(rendered).toContain("choice with stray CR");
		expect(rendered).toContain("2. GEMBA_LOG_FILE");
		expect(rendered).not.toContain("\r");
	});

	it("emits the prompt event with normalized text", async () => {
		const { tool, captured } = register();
		const custom = vi.fn(async () => ({ answers: [], cancelled: false })) as unknown as CustomFn;
		const ctx = createMockCtx({ hasUI: true, ui: { custom } as never });

		await tool.execute?.("tc", CR_PARAMS as never, undefined as never, undefined as never, ctx as never);

		expect(captured.eventsEmitted.get("rpiv:ask-user:prompt")![0]).toEqual({
			questions: [
				{
					question: "Which option is best?",
					header: "Pick",
					multiSelect: false,
					options: [
						{ label: "OptionA (Recommended)", description: "choice with stray CR", hasPreview: false },
						{ label: "GEMBA_LOG_FILE", description: "crlf\nline", hasPreview: true },
					],
				},
			],
		});
	});

	it("shows the RPC host normalized titles and option lines", async () => {
		const { tool } = register();
		const select = vi.fn(async (_title: string, options: string[]) => options[0]);
		const ctx = createMockCtx({
			hasUI: true,
			mode: "rpc",
			ui: { select: select as never, input: vi.fn(async () => "") as never } as never,
		});

		const r = await tool.execute?.("tc", CR_PARAMS as never, undefined as never, undefined as never, ctx as never);

		const [title, options] = select.mock.calls[0]!;
		expect(title).toContain("[Pick] Which option is best?");
		expect(title).toContain("--- 2. GEMBA_LOG_FILE preview ---\na\nb");
		expect(options).toEqual([
			"1. OptionA (Recommended) — choice with stray CR",
			"2. GEMBA_LOG_FILE — crlf\nline",
			"3. Type something.",
		]);
		expect(title).not.toContain("\r");
		expect(options.join("")).not.toContain("\r");
		expect(r?.content[0]).toMatchObject({
			text: expect.stringContaining('"Which option is best?"="OptionA (Recommended)"'),
		});
	});

	it("rejects a reserved label that only differed by a trailing CR", async () => {
		const { tool } = register();
		const custom = vi.fn(async () => ({ answers: [], cancelled: false })) as unknown as CustomFn;
		const ctx = createMockCtx({ hasUI: true, ui: { custom } as never });
		const params = {
			questions: [
				{
					question: "Q?",
					header: "H",
					options: [
						{ label: "Other\r", description: "d" },
						{ label: "B", description: "d" },
					],
				},
			],
		};

		const r = await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);

		expect(r?.details).toMatchObject({ cancelled: true, error: "reserved_label" });
		expect(custom).not.toHaveBeenCalled();
	});

	it("rejects duplicate labels that only differed by a CR", async () => {
		const { tool } = register();
		const custom = vi.fn(async () => ({ answers: [], cancelled: false })) as unknown as CustomFn;
		const ctx = createMockCtx({ hasUI: true, ui: { custom } as never });
		const params = {
			questions: [
				{
					question: "Q?",
					header: "H",
					options: [
						{ label: "A\r", description: "d" },
						{ label: "A", description: "d" },
					],
				},
			],
		};

		const r = await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);

		expect(r?.details).toMatchObject({ cancelled: true, error: "duplicate_option_label" });
		expect(custom).not.toHaveBeenCalled();
	});
});
