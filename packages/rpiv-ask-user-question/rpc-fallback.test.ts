import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";

type SelectFn = (title: string, options: string[]) => Promise<string | undefined>;
type InputFn = (title: string, placeholder?: string) => Promise<string | undefined>;

function register() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

/**
 * Build a mock ctx that looks like RPC mode: `mode === "rpc"` plus working
 * `ui.select` / `ui.input`. `createMockCtx` doesn't set `ctx.mode`, and the
 * production guard reads it via a structural cast — set it on the mock the
 * same way so the `=== "rpc"` branch fires.
 */
function ctxRpc(opts: { select: SelectFn; input: InputFn }) {
	const ctx = createMockCtx({
		hasUI: true,
		ui: { select: opts.select as never, input: opts.input as never } as never,
	});
	(ctx as { mode?: string }).mode = "rpc";
	return ctx;
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

describe("ask_user_question.execute — RPC fallback (ctx.mode === 'rpc')", () => {
	it("single-select uses ctx.ui.select and returns the chosen label in the envelope", async () => {
		const tool = register();
		const select = vi.fn(async (_t: string, options: string[]) => options[1]); // "2. B — b"
		const ctx = ctxRpc({ select, input: vi.fn(async () => "") });
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
			ui: {
				custom: custom as never,
				select: vi.fn(async (_t: string, o: string[]) => o[0]) as never,
				input: vi.fn(async () => "") as never,
			} as never,
		});
		(ctx as { mode?: string }).mode = "rpc";
		await run(tool, SINGLE, ctx);
		expect(custom).not.toHaveBeenCalled();
	});

	it("multi-select uses ctx.ui.input and parses comma-separated indices into labels", async () => {
		const tool = register();
		const input = vi.fn(async () => "1,3"); // red, blue
		const ctx = ctxRpc({ select: vi.fn(async () => ""), input });
		const r = await run(tool, MULTI, ctx);
		expect(input).toHaveBeenCalledOnce();
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Pick colors?"="red, blue"') });
	});

	it("'Type something.' sentinel follows up with ctx.ui.input for custom text", async () => {
		const tool = register();
		const select = vi.fn(async (_t: string, options: string[]) => options[options.length - 2]); // "Type something."
		const input = vi.fn(async () => "typed it");
		const ctx = ctxRpc({ select, input });
		const r = await run(tool, SINGLE, ctx);
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="typed it"') });
	});

	it("'Chat about this.' sentinel records a chat answer (not declined)", async () => {
		const tool = register();
		const select = vi.fn(async (_t: string, options: string[]) => options[options.length - 1]); // "Chat about this."
		const ctx = ctxRpc({ select, input: vi.fn(async () => "") });
		const r = await run(tool, SINGLE, ctx);
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("User wants to chat about this") });
	});

	it("dismiss (select returns undefined) → decline envelope", async () => {
		const tool = register();
		const select = vi.fn(async () => undefined);
		const ctx = ctxRpc({ select, input: vi.fn(async () => "") });
		const r = await run(tool, SINGLE, ctx);
		expect(r?.details).toMatchObject({ cancelled: true });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("declined") });
	});

	it("stays on the custom() path when ctx.mode is unset (TUI / older pi / tests)", async () => {
		// No mode set → guard (=== "rpc") is false → ctx.ui.custom is used, not select.
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
		// deliberately NOT setting ctx.mode
		const r = await run(tool, SINGLE, ctx);
		expect(custom).toHaveBeenCalledOnce();
		expect(select).not.toHaveBeenCalled();
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="A"') });
	});
});
