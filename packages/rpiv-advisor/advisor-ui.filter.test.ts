import type { SelectItem } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showAdvisorPicker } from "./advisor-ui.js";

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

const advisorItems: SelectItem[] = [
	{ label: "Claude Opus", value: "anthropic:claude-opus-4-7" },
	{ label: "Claude Sonnet", value: "anthropic:claude-sonnet-4-6" },
	{ label: "Claude Haiku", value: "anthropic:claude-haiku-4-5" },
	{ label: "GPT-5", value: "openai:gpt-5" },
	{ label: "GLM-4.6", value: "zai:glm-4-6" },
	{ label: "No advisor", value: "__none__" },
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("showAdvisorPicker — type-to-filter flow", () => {
	it("typing narrows the list so ENTER picks the filtered match", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			for (const ch of "opus") c.handleInput(ch);
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		const r = await showAdvisorPicker(ctx, advisorItems);
		expect(r).toBe("anthropic:claude-opus-4-7");
	});

	it("backspace widens the query again", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			for (const ch of "glm") c.handleInput(ch);
			// remove all three chars (DEL) -> full list restored, first item selected
			c.handleInput("\u007f");
			c.handleInput("\u007f");
			c.handleInput("\u007f");
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		const r = await showAdvisorPicker(ctx, advisorItems);
		expect(r).toBe("anthropic:claude-opus-4-7");
	});

	it("renders the typed filter in the panel", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			for (const ch of "son") c.handleInput(ch);
			const out = c.render(100).join("\n");
			expect(out).toContain("Filter: son");
			expect(out).toContain("Claude Sonnet");
			expect(out).not.toContain("Claude Haiku");
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showAdvisorPicker(ctx, advisorItems);
	});

	it("shows the type-to-filter hint before any input", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(100).join("\n");
			expect(out).toContain("Type to filter…");
			expect(out).toContain("type to filter • ↑↓ navigate • enter select • esc cancel");
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showAdvisorPicker(ctx, advisorItems);
	});
});
