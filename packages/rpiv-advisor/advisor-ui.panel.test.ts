import type { SelectItem } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showAdvisorPicker, showEffortPicker } from "./advisor-ui.ts";

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

// Drives ctx.ui.custom with a real factory; script runs once, then completes.
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
	{ label: "Claude Opus", value: "anthropic:claude-opus-4-7", description: "top-tier reasoning" },
	{ label: "Claude Sonnet", value: "anthropic:claude-sonnet-4-6", description: "balanced" },
];

const effortItems: SelectItem[] = [
	{ label: "Off", value: "off" },
	{ label: "Low", value: "low" },
	{ label: "Medium", value: "medium" },
	{ label: "High", value: "high" },
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("advisor-ui panel — showAdvisorPicker layout", () => {
	it("renders without throwing at reasonable widths", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			expect(() => c.render(60)).not.toThrow();
			expect(() => c.render(80)).not.toThrow();
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showAdvisorPicker(ctx, advisorItems);
	});

	it("output contains title 'Advisor Tool' and both prose paragraphs", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(100).join("\n");
			expect(out).toContain("Advisor Tool");
			expect(out).toContain("escalates to the");
			expect(out).toContain("near-top-tier performance");
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showAdvisorPicker(ctx, advisorItems);
	});

	it("output contains the nav hint", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(100).join("\n");
			expect(out).toContain("↑↓ navigate • enter select • esc cancel");
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showAdvisorPicker(ctx, advisorItems);
	});

	it("output contains every item label", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(120).join("\n");
			for (const item of advisorItems) {
				expect(out).toContain(item.label);
			}
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showAdvisorPicker(ctx, advisorItems);
	});
});

describe("advisor-ui panel — showEffortPicker layout", () => {
	it("renders without throwing at reasonable widths", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			expect(() => c.render(60)).not.toThrow();
			expect(() => c.render(80)).not.toThrow();
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showEffortPicker(ctx, effortItems, undefined, "medium");
	});

	it("output contains 'Reasoning Level' title and prose", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(100).join("\n");
			expect(out).toContain("Reasoning Level");
			expect(out).toContain("Higher levels produce stronger judgment");
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showEffortPicker(ctx, effortItems, undefined, "medium");
	});

	it("output contains every effort item label", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(100).join("\n");
			for (const item of effortItems) {
				expect(out).toContain(item.label);
			}
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showEffortPicker(ctx, effortItems, undefined, "medium");
	});

	it("output contains the nav hint", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			const out = c.render(100).join("\n");
			expect(out).toContain("↑↓ navigate • enter select • esc cancel");
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showEffortPicker(ctx, effortItems, undefined, "medium");
	});
});
