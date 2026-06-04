/**
 * Keyboard-flow tests for showFilterablePicker — the /rpiv-models cascade picker
 * primitive. Drives ctx.ui.custom with a real factory + real pi-tui keybindings,
 * mirroring rpiv-advisor/advisor-ui.picker.test.ts (this picker is a clone).
 */

import type { SelectItem } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showFilterablePicker } from "./models-picker.js";

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

function driveCustom<T>(script: (c: RenderableComponent, done: (v: T) => void) => void) {
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
			script(component, resolve as (v: T) => void);
		});
	});
	return { custom, requestRender };
}

const items: SelectItem[] = [
	{ label: "Claude Opus", value: "anthropic/opus" },
	{ label: "Claude Sonnet", value: "anthropic/sonnet" },
	{ label: "GPT", value: "openai/gpt" },
];

const baseOpts = { title: "Model", proseLines: ["Select model."], items };

afterEach(() => {
	vi.restoreAllMocks();
});

describe("showFilterablePicker — keyboard flow", () => {
	it("ENTER on first item resolves with its value", async () => {
		const { custom } = driveCustom<string | null>((c) => c.handleInput("\r"));
		const ctx = { ui: { custom } } as never;
		expect(await showFilterablePicker(ctx, baseOpts)).toBe("anthropic/opus");
	});

	it("DOWN then ENTER resolves with the second item", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("[B");
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		expect(await showFilterablePicker(ctx, baseOpts)).toBe("anthropic/sonnet");
	});

	it("ESC resolves with null", async () => {
		const { custom } = driveCustom<string | null>((c) => c.handleInput(""));
		const ctx = { ui: { custom } } as never;
		expect(await showFilterablePicker(ctx, baseOpts)).toBeNull();
	});

	it("typing filters by substring (label or value), then ENTER selects the match", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			// "gpt" matches only the GPT item; the filtered list collapses to it.
			c.handleInput("g");
			c.handleInput("p");
			c.handleInput("t");
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		expect(await showFilterablePicker(ctx, baseOpts)).toBe("openai/gpt");
	});

	it("backspace removes filter characters; emptying the query restores the full list", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("g"); // filter to GPT
			c.handleInput(""); // DEL — back to full list
			c.handleInput(""); // BS on empty query is a no-op
			c.handleInput("\r"); // first item of the restored list
		});
		const ctx = { ui: { custom } } as never;
		expect(await showFilterablePicker(ctx, baseOpts)).toBe("anthropic/opus");
	});

	it("preferredValue preselects that row while the query is empty", async () => {
		const { custom } = driveCustom<string | null>((c) => c.handleInput("\r"));
		const ctx = { ui: { custom } } as never;
		const r = await showFilterablePicker(ctx, { ...baseOpts, preferredValue: "openai/gpt" });
		expect(r).toBe("openai/gpt");
	});

	it("escHint customizes the nav hint wording (defaults to 'cancel')", async () => {
		const renders: string[] = [];
		const { custom } = driveCustom<string | null>((c, done) => {
			renders.push(c.render(80).join("\n"));
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showFilterablePicker(ctx, { ...baseOpts, escHint: "back" });
		expect(renders[0]).toContain("esc back");
		expect(renders[0]).not.toContain("esc cancel");

		const renders2: string[] = [];
		const { custom: custom2 } = driveCustom<string | null>((c, done) => {
			renders2.push(c.render(80).join("\n"));
			done(null);
		});
		await showFilterablePicker({ ui: { custom: custom2 } } as never, baseOpts);
		expect(renders2[0]).toContain("esc cancel");
	});

	it("handleInput triggers tui.requestRender and render()/invalidate() are callable", async () => {
		const { custom, requestRender } = driveCustom<string | null>((c, done) => {
			expect(() => c.render(80)).not.toThrow();
			expect(() => c.invalidate()).not.toThrow();
			c.handleInput("x");
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showFilterablePicker(ctx, baseOpts);
		expect(requestRender).toHaveBeenCalled();
	});
});
