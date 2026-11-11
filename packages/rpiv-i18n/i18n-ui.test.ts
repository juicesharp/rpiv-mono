import type { SelectItem } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showLanguagePicker } from "./i18n-ui.ts";

const ESC = String.fromCharCode(27);
const KEY_DOWN = `${ESC}[B`;
const KEY_UP = `${ESC}[A`;
const KEY_ESC = ESC;

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

const localeItems: SelectItem[] = [
	{ label: "English", value: "en" },
	{ label: "Українська", value: "uk" },
	{ label: "Deutsch", value: "de" },
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("showLanguagePicker — keyboard flow (real pi-tui keybindings)", () => {
	it("ENTER on first item resolves with that locale value", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		const r = await showLanguagePicker(ctx, localeItems);
		expect(r).toBe("en");
	});

	it("DOWN then ENTER resolves with the second item", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput(KEY_DOWN);
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		const r = await showLanguagePicker(ctx, localeItems);
		expect(r).toBe("uk");
	});

	it("UP from index 0 wraps to last item", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput(KEY_UP);
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		const r = await showLanguagePicker(ctx, localeItems);
		expect(r).toBe("de");
	});

	it("ESC resolves with null (cancel)", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput(KEY_ESC);
		});
		const ctx = { ui: { custom } } as never;
		const r = await showLanguagePicker(ctx, localeItems);
		expect(r).toBeNull();
	});

	it("handleInput triggers tui.requestRender", async () => {
		const { custom, requestRender } = driveCustom<string | null>((c) => {
			c.handleInput(KEY_DOWN);
			c.handleInput(KEY_ESC);
		});
		const ctx = { ui: { custom } } as never;
		await showLanguagePicker(ctx, localeItems);
		expect(requestRender).toHaveBeenCalled();
	});

	it("invalidate() is callable without throwing", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			expect(() => c.invalidate()).not.toThrow();
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showLanguagePicker(ctx, localeItems);
	});

	it("render(width) returns a non-empty panel containing the title and prose", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const lines = c.render(80);
			expect(lines.length).toBeGreaterThan(0);
			expect(lines.some((l) => l.includes("UI Language"))).toBe(true);
			// Prose copy explaining the locale persistence path:
			expect(lines.some((l) => l.includes("rpiv-i18n"))).toBe(true);
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showLanguagePicker(ctx, localeItems);
	});

	it("render includes the nav hint footer", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const lines = c.render(80);
			expect(lines.some((l) => l.includes("navigate"))).toBe(true);
			expect(lines.some((l) => l.includes("select"))).toBe(true);
			expect(lines.some((l) => l.includes("cancel"))).toBe(true);
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showLanguagePicker(ctx, localeItems);
	});

	it("handles single-item list (visible rows clamps to items.length)", async () => {
		const single: SelectItem[] = [{ label: "Only", value: "only" }];
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		const r = await showLanguagePicker(ctx, single);
		expect(r).toBe("only");
	});
});
