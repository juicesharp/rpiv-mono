import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import { hasDialogUI } from "./rpc-fallback.js";

type SelectFn = (title: string, options: string[]) => Promise<string | undefined>;
type InputFn = (title: string, placeholder?: string) => Promise<string | undefined>;

function register() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

/** Mock ctx shaped like a pi ≥0.79 RPC host: `mode: "rpc"` + dialog primitives. */
function ctxRpc(opts: { select?: SelectFn; input?: InputFn } = {}) {
	return createMockCtx({
		hasUI: true,
		mode: "rpc",
		ui: {
			select: (opts.select ?? vi.fn(async () => undefined)) as never,
			input: (opts.input ?? vi.fn(async () => "")) as never,
		} as never,
	});
}

const SINGLE = {
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

const MULTI = {
	questions: [
		{
			question: "Pick colors?",
			header: "Colors",
			multiSelect: true,
			options: [
				{ label: "red", description: "r" },
				{ label: "green", description: "g" },
				{ label: "blue", description: "b" },
			],
		},
	],
};

async function run(tool: ReturnType<typeof register>, params: unknown, ctx: unknown) {
	return await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
}

describe("hasDialogUI", () => {
	it("requires both select and input to be functions", () => {
		expect(hasDialogUI({ select: async () => undefined, input: async () => "" })).toBe(true);
		expect(hasDialogUI({ select: async () => undefined })).toBe(false);
		expect(hasDialogUI({ input: async () => "" })).toBe(false);
		expect(hasDialogUI(undefined)).toBe(false);
	});
});

describe("ask_user_question.execute — RPC dialog walker (ctx.mode === 'rpc')", () => {
	it("single-select uses ctx.ui.select and returns the chosen label in the envelope", async () => {
		const tool = register();
		const select = vi.fn(async (_t: string, options: string[]) => options[1]); // "2. B — b"
		const ctx = ctxRpc({ select });
		const r = await run(tool, SINGLE, ctx);
		expect(select).toHaveBeenCalledOnce();
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="B"') });
		expect(r?.content[0]).toMatchObject({ text: expect.stringMatching(/^User has answered your questions:/) });
	});

	it("does NOT call ctx.ui.custom in RPC mode", async () => {
		const tool = register();
		const custom = vi.fn(async () => ({ answers: [], cancelled: true }));
		const ctx = createMockCtx({
			hasUI: true,
			mode: "rpc",
			ui: {
				custom: custom as never,
				select: vi.fn(async (_t: string, o: string[]) => o[0]) as never,
				input: vi.fn(async () => "") as never,
			} as never,
		});
		await run(tool, SINGLE, ctx);
		expect(custom).not.toHaveBeenCalled();
	});

	it("appends the 'Type something.' sentinel row sourced from ROW_INTENT_META", async () => {
		const tool = register();
		let offered: string[] = [];
		const select = vi.fn(async (_t: string, options: string[]) => {
			offered = options;
			return options[0];
		});
		await run(tool, SINGLE, ctxRpc({ select }));
		expect(offered).toEqual(["1. A — a", "2. B — b", "3. Type something."]);
	});

	it("'Type something.' sentinel follows up with ctx.ui.input for custom text", async () => {
		const tool = register();
		const select = vi.fn(async (_t: string, options: string[]) => options[options.length - 1]);
		const input = vi.fn(async () => "typed it");
		const r = await run(tool, SINGLE, ctxRpc({ select, input }));
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="typed it"') });
	});

	it("folds option previews into the select title and echoes the selected preview", async () => {
		const tool = register();
		const withPreview = {
			questions: [
				{
					question: "Which?",
					header: "Pick",
					options: [
						{ label: "A", description: "a", preview: "PREVIEW-A" },
						{ label: "B", description: "b" },
					],
				},
			],
		};
		let title = "";
		const select = vi.fn(async (t: string, options: string[]) => {
			title = t;
			return options[0];
		});
		const r = await run(tool, withPreview, ctxRpc({ select }));
		expect(title).toContain("PREVIEW-A");
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("selected preview: PREVIEW-A") });
	});

	it("multi-select uses ctx.ui.input and parses comma-separated indices into labels", async () => {
		const tool = register();
		const input = vi.fn(async () => "1,3"); // red, blue
		const r = await run(tool, MULTI, ctxRpc({ input }));
		expect(input).toHaveBeenCalledOnce();
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Pick colors?"="red, blue"') });
	});

	it("multi-select treats non-index input as a typed custom answer, not a silent drop", async () => {
		const tool = register();
		const input = vi.fn(async () => "red, something else entirely");
		const r = await run(tool, MULTI, ctxRpc({ input }));
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({
			text: expect.stringContaining('"Pick colors?"="red, something else entirely"'),
		});
	});

	it("multi-select empty input commits an empty selection (Next with nothing toggled)", async () => {
		const tool = register();
		const input = vi.fn(async () => "  ");
		const r = await run(tool, MULTI, ctxRpc({ input }));
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Pick colors?"="(no input)"') });
	});

	it("dismiss (select resolves undefined) → decline envelope", async () => {
		const tool = register();
		const select = vi.fn(async () => undefined);
		const r = await run(tool, SINGLE, ctxRpc({ select }));
		expect(r?.details).toMatchObject({ cancelled: true });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("declined") });
	});

	it("walks multiple questions sequentially, one dialog each", async () => {
		const tool = register();
		const params = { questions: [...SINGLE.questions, ...MULTI.questions] };
		const select = vi.fn(async (_t: string, options: string[]) => options[0]); // "1. A — a"
		const input = vi.fn(async () => "2"); // green
		const r = await run(tool, params, ctxRpc({ select, input }));
		expect(select).toHaveBeenCalledOnce();
		expect(input).toHaveBeenCalledOnce();
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="A"') });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Pick colors?"="green"') });
	});
});

describe("ask_user_question.execute — dialog walker as custom()-undefined backstop", () => {
	// RPC builds that predate ctx.mode: the mode guard misses, custom() resolves
	// undefined, and the walker must still run off the capability signal.
	it("falls back to the dialog walker when ctx.mode is unset and custom() resolves undefined", async () => {
		const tool = register();
		const custom = vi.fn(async () => undefined);
		const select = vi.fn(async (_t: string, options: string[]) => options[1]);
		const ctx = createMockCtx({
			hasUI: true,
			ui: { custom: custom as never, select: select as never, input: vi.fn(async () => "") as never } as never,
		});
		const r = await run(tool, SINGLE, ctx);
		expect(custom).toHaveBeenCalledOnce();
		expect(select).toHaveBeenCalledOnce();
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="B"') });
	});

	it("stays on the custom() path when ctx.mode is unset and custom() renders (TUI)", async () => {
		const tool = register();
		const custom = vi.fn(async () => ({
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Which?", kind: "option", answer: "A" }],
		}));
		const select = vi.fn(async () => "should-not-be-called");
		const ctx = createMockCtx({
			hasUI: true,
			ui: { custom: custom as never, select: select as never } as never,
		});
		const r = await run(tool, SINGLE, ctx);
		expect(custom).toHaveBeenCalledOnce();
		expect(select).not.toHaveBeenCalled();
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="A"') });
	});
});
