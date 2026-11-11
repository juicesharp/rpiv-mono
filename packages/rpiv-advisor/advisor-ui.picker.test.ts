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

// Drives ctx.ui.custom with a real factory + real pi-tui keybindings. The script
// runs once and is expected to either complete via the SelectList's onSelect/
// onCancel (triggered by the provided escape sequences) or by calling done().
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

describe("showAdvisorPicker — keyboard flow (real pi-tui keybindings)", () => {
	it("ENTER on first item resolves with that value", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		const r = await showAdvisorPicker(ctx, advisorItems);
		expect(r).toBe("anthropic:claude-opus-4-7");
	});

	it("DOWN then ENTER resolves with second item", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\u001b[B");
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		const r = await showAdvisorPicker(ctx, advisorItems);
		expect(r).toBe("anthropic:claude-sonnet-4-6");
	});

	it("UP from index 0 wraps to last item", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\u001b[A");
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		const r = await showAdvisorPicker(ctx, advisorItems);
		expect(r).toBe("anthropic:claude-haiku-4-5");
	});

	it("ESC resolves with null", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\u001b");
		});
		const ctx = { ui: { custom } } as never;
		const r = await showAdvisorPicker(ctx, advisorItems);
		expect(r).toBeNull();
	});

	it("handleInput triggers tui.requestRender", async () => {
		const { custom, requestRender } = driveCustom<string | null>((c) => {
			c.handleInput("\u001b[B");
			c.handleInput("\u001b");
		});
		const ctx = { ui: { custom } } as never;
		await showAdvisorPicker(ctx, advisorItems);
		expect(requestRender).toHaveBeenCalled();
	});

	it("invalidate() is callable without throwing", async () => {
		const { custom } = driveCustom<string | null>((c, done) => {
			expect(() => c.invalidate()).not.toThrow();
			done(null);
		});
		const ctx = { ui: { custom } } as never;
		await showAdvisorPicker(ctx, advisorItems);
	});
});

describe("showEffortPicker — preselection + keyboard flow", () => {
	it("preselects currentEffort when present in items — ENTER resolves with it", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		const r = await showEffortPicker(ctx, effortItems, "high", "medium");
		expect(r).toBe("high");
	});

	it("falls back to defaultEffort when currentEffort is undefined", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		const r = await showEffortPicker(ctx, effortItems, undefined, "medium");
		expect(r).toBe("medium");
	});

	it("falls back to defaultEffort when currentEffort is not in items", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		// "xhigh" is not in effortItems, so preselection should fall back to "low"
		const r = await showEffortPicker(ctx, effortItems, "xhigh" as never, "low");
		expect(r).toBe("low");
	});

	it("DOWN from preselected index moves selection forward", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\u001b[B");
			c.handleInput("\r");
		});
		const ctx = { ui: { custom } } as never;
		// Preselected: "low" (index 1) → DOWN → "medium" (index 2)
		const r = await showEffortPicker(ctx, effortItems, "low", "minimal");
		expect(r).toBe("medium");
	});

	it("ESC resolves with null", async () => {
		const { custom } = driveCustom<string | null>((c) => {
			c.handleInput("\u001b");
		});
		const ctx = { ui: { custom } } as never;
		const r = await showEffortPicker(ctx, effortItems, "medium", "medium");
		expect(r).toBeNull();
	});
});
