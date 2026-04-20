import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";

interface RenderableComponent {
	render: (w: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
}

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

function register() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

// Drives ctx.ui.custom with a real factory invocation, then calls `script(component, done)`
// to exercise render + handleInput. `done` resolves the promise that the tool awaits.
function driveCustom(script: (c: RenderableComponent, done: (v: unknown) => void) => void) {
	const requestRender = vi.fn();
	const custom = vi.fn((factory: unknown) => {
		return new Promise((resolve) => {
			const f = factory as (
				tui: { requestRender: () => void },
				theme: typeof identityTheme,
				kb: undefined,
				done: (v: unknown) => void,
			) => RenderableComponent;
			const component = f({ requestRender }, identityTheme, undefined, resolve);
			script(component, resolve);
		});
	});
	return { custom, requestRender };
}

const params = {
	question: "Pick one",
	header: "HDR",
	options: [{ label: "A" }, { label: "B" }],
};

beforeEach(() => {});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("ask_user_question — factory driver (real pi-tui keybindings)", () => {
	it("renders a non-empty view at width 80", async () => {
		const tool = register();
		const { custom } = driveCustom((c, done) => {
			const lines = c.render(80);
			expect(lines.length).toBeGreaterThan(0);
			done(null);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("Esc cancels → returns decline envelope", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput("\u001b");
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ answer: null });
	});

	it("DOWN navigates without completing; then Esc cancels", async () => {
		const tool = register();
		const { custom, requestRender } = driveCustom((c) => {
			c.handleInput("\u001b[B");
			c.handleInput("\u001b");
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		expect(requestRender).toHaveBeenCalled();
	});

	it("UP wraps from first to last, then Esc", async () => {
		const tool = register();
		const { custom, requestRender } = driveCustom((c) => {
			c.handleInput("\u001b[A");
			c.handleInput("\u001b");
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		expect(requestRender).toHaveBeenCalled();
	});

	it("Enter on first item confirms with that label", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput("\r");
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ answer: "A", wasCustom: false });
	});

	it("inline-input: type then Enter returns a custom answer", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			// Options A, B, then 'Type something.' (isOther). Chat row is last. Navigate to isOther.
			c.handleInput("\u001b[B"); // A -> B
			c.handleInput("\u001b[B"); // B -> Type something (isOther)
			c.handleInput("h");
			c.handleInput("i");
			c.handleInput("\r");
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ answer: "hi", wasCustom: true });
	});

	it("inline-input: backspace removes a char before Enter", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput("\u001b[B");
			c.handleInput("\u001b[B");
			c.handleInput("a");
			c.handleInput("b");
			c.handleInput("\x7f");
			c.handleInput("\r");
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ answer: "a", wasCustom: true });
	});

	it("navigating to chat row + Enter yields wasChat envelope", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			// A -> B -> Type something -> Chat (4 DOWNs from index 0)
			c.handleInput("\u001b[B");
			c.handleInput("\u001b[B");
			c.handleInput("\u001b[B");
			c.handleInput("\r");
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ wasChat: true });
	});

	it("invalidate() is callable without throwing", async () => {
		const tool = register();
		const { custom } = driveCustom((c, done) => {
			c.invalidate();
			done(null);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});
});
