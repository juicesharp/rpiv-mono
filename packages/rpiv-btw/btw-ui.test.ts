import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { makeTui } from "@juicesharp/rpiv-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BtwTurn } from "./btw.ts";
import { BtwOverlayController, showBtwOverlay } from "./btw-ui.ts";

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
} as unknown as Theme;

function makeTurn(q: string, a = "ans"): BtwTurn {
	return {
		userMessage: { role: "user", content: q, timestamp: 0 },
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text: a }],
			api: "anthropic" as never,
			provider: "anthropic" as never,
			model: "m",
			usage: {} as never,
			stopReason: "done" as never,
			timestamp: 0,
		},
	};
}

function makeController(opts: { question?: string; history?: BtwTurn[]; tui?: TUI; rows?: number } = {}) {
	const tui = opts.tui ?? (makeTui() as unknown as TUI);
	(tui as unknown as { terminal: { rows: number } }).terminal = { rows: opts.rows ?? 24 };
	const done = vi.fn();
	const controller = new AbortController();
	const onClearHistory = vi.fn();
	const ctl = new BtwOverlayController(
		opts.question ?? "what?",
		opts.history ?? [],
		identityTheme,
		tui,
		done,
		controller,
		onClearHistory,
	);
	return { ctl, tui, done, controller, onClearHistory };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("BtwOverlayController — initial (pending) render", () => {
	it("contains the banner, echo line, pending glyph, and dismiss footer", () => {
		const { ctl } = makeController({ question: "hello?" });
		const out = ctl.render(80).join("\n");
		expect(out).toContain("/btw hello?");
		expect(out).toContain("…"); // PENDING_GLYPH
		expect(out).toContain("Esc to dismiss");
	});

	it("does NOT show 'scroll' or 'clear' hints when pending + no history", () => {
		const { ctl } = makeController({ question: "q" });
		const out = ctl.render(80).join("\n");
		expect(out).not.toContain("↑/↓ to scroll");
		expect(out).not.toContain("x to clear history");
	});

	it("shows 'x to clear history' hint when history is non-empty", () => {
		const { ctl } = makeController({ history: [makeTurn("prev")] });
		const out = ctl.render(80).join("\n");
		expect(out).toContain("x to clear history");
	});
});

describe("BtwOverlayController — setAnswer", () => {
	it("replaces pending glyph with the answer text", () => {
		const { ctl, tui } = makeController();
		ctl.setAnswer("forty-two");
		const out = ctl.render(80).join("\n");
		expect(out).toContain("forty-two");
		expect(out).not.toContain("…");
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("enables the 'scroll' footer hint once the mode is no longer pending", () => {
		const { ctl } = makeController();
		ctl.setAnswer("a");
		expect(ctl.render(80).join("\n")).toContain("↑/↓ to scroll");
	});

	it("wraps multi-line answers into the answer body", () => {
		const { ctl } = makeController();
		ctl.setAnswer("line1\nline2\nline3");
		const out = ctl.render(80);
		expect(out.some((l) => l.includes("line1"))).toBe(true);
		expect(out.some((l) => l.includes("line2"))).toBe(true);
		expect(out.some((l) => l.includes("line3"))).toBe(true);
	});
});

describe("BtwOverlayController — setError", () => {
	it("renders the error message in the answer slot", () => {
		const { ctl } = makeController();
		ctl.setError("boom: nope");
		const out = ctl.render(80).join("\n");
		expect(out).toContain("boom: nope");
		expect(out).not.toContain("…");
	});
});

describe("BtwOverlayController — setTrimmed", () => {
	it("appends exactly one notice line and triggers requestRender", () => {
		const { ctl, tui } = makeController({ rows: 100 });
		ctl.setAnswer("answer-body");
		const beforeLines = ctl.render(80).length; // 7 (un-trimmed parity)
		ctl.setTrimmed();
		const afterLines = ctl.render(80);
		expect(afterLines.length).toBe(beforeLines + 1); // 8 — exactly one more line
		expect(afterLines.join("\n")).toContain("context trimmed to fit budget");
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("is a no-op on the un-trimmed path (line count unchanged)", () => {
		const { ctl } = makeController({ rows: 100 });
		ctl.setAnswer("answer-body");
		// setTrimmed never called — render stays at the un-trimmed line count
		expect(ctl.render(80).length).toBe(7);
	});
});

describe("BtwOverlayController — handleInput", () => {
	it("Esc aborts the controller and resolves done()", () => {
		const { ctl, controller, done } = makeController();
		ctl.handleInput("\u001b");
		expect(controller.signal.aborted).toBe(true);
		expect(done).toHaveBeenCalled();
	});

	it("'x' clears in-memory history and invokes onClearHistory", () => {
		const { ctl, onClearHistory, tui } = makeController({ history: [makeTurn("a"), makeTurn("b")] });
		ctl.handleInput("x");
		expect(onClearHistory).toHaveBeenCalledTimes(1);
		const out = ctl.render(80).join("\n");
		expect(out).not.toContain("/btw a");
		expect(out).not.toContain("/btw b");
		expect(out).not.toContain("x to clear history");
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("unknown keys do not abort or clear", () => {
		const { ctl, controller, done, onClearHistory } = makeController();
		ctl.handleInput("z");
		expect(controller.signal.aborted).toBe(false);
		expect(done).not.toHaveBeenCalled();
		expect(onClearHistory).not.toHaveBeenCalled();
	});
});

describe("BtwOverlayController — scroll + clipping", () => {
	it("render() returns all natural lines when within maxRows", () => {
		const { ctl } = makeController({ rows: 100 });
		ctl.setAnswer("answer-body");
		const lines = ctl.render(80);
		// banner + blank + 0 history + echo + blank + 1 answer + blank + footer = 7
		expect(lines.length).toBe(7);
	});

	it("clips top when content overflows terminal height; scroll↑ reveals older history", () => {
		// Use distinct non-overlapping markers so substring matches are unambiguous.
		const history: BtwTurn[] = Array.from({ length: 20 }, (_, i) => makeTurn(`mark-${i + 1}-end`));
		const { ctl } = makeController({ history, rows: 10 });
		ctl.setAnswer("A");
		const base = ctl.render(80);
		const maxRows = Math.floor(10 * 0.85); // 8
		expect(base.length).toBe(maxRows);
		// Bottom-anchored: footer + answer visible; earliest history hidden
		expect(base.join("\n")).not.toContain("mark-1-end");
		expect(base.join("\n")).toContain("mark-20-end");
		expect(base.join("\n")).toContain("Esc to dismiss");
		// Scroll up reveals older history at the top.
		ctl.handleInput("\u001b[A");
		const scrolled = ctl.render(80);
		expect(scrolled.length).toBe(maxRows);
	});

	it("scroll↓ at bottom stays clamped (no throw, still renders maxRows)", () => {
		const history: BtwTurn[] = Array.from({ length: 20 }, (_, i) => makeTurn(`mark-${i + 1}-end`));
		const { ctl } = makeController({ history, rows: 10 });
		ctl.setAnswer("A");
		ctl.handleInput("\u001b[B"); // down
		const out = ctl.render(80);
		const maxRows = Math.floor(10 * 0.85);
		expect(out.length).toBe(maxRows);
	});

	it("invalidate() is a callable no-op", () => {
		const { ctl } = makeController();
		expect(() => ctl.invalidate()).not.toThrow();
	});
});

describe("BtwOverlayController — banner + echo formatting", () => {
	it("banner is padded to full visible width", () => {
		const { ctl } = makeController({ question: "q" });
		const banner = ctl.render(40)[0];
		expect(visibleWidth(banner)).toBe(40);
	});

	it("truncates long questions in the banner with ellipsis", () => {
		const long = "a".repeat(200);
		const { ctl } = makeController({ question: long });
		const banner = ctl.render(40)[0];
		expect(visibleWidth(banner)).toBe(40);
		expect(banner).toContain("…");
	});

	it("history echo uses '/btw ' prefix and trims whitespace", () => {
		const { ctl } = makeController({ history: [makeTurn("  multi\nline   q  ")] });
		const out = ctl.render(80).join("\n");
		expect(out).toContain("/btw multi line q");
	});
});

describe("showBtwOverlay — factory wiring", () => {
	it("invokes ctx.ui.custom with overlay options and resolves controllerReady with the BtwOverlayController", async () => {
		const requestRender = vi.fn();
		const tui = { requestRender, terminal: { rows: 24 } } as unknown as TUI;
		const custom = vi.fn((factory: unknown, opts: unknown) => {
			const f = factory as (
				tui: TUI,
				theme: Theme,
				kb: undefined,
				done: (v: undefined) => void,
			) => BtwOverlayController;
			const ctl = f(tui, identityTheme, undefined, () => {});
			// Keep `opts` addressable for the assertion below.
			(custom as unknown as { lastOpts: unknown }).lastOpts = opts;
			return new Promise<void>(() => {
				// keep pending so we can inspect the controller
				void ctl;
			});
		});
		const ctx = { ui: { custom } } as never;

		const { controllerReady } = showBtwOverlay({
			ctx,
			question: "q",
			history: [],
			controller: new AbortController(),
			onClearHistory: vi.fn(),
		});

		const ctl = await controllerReady;
		expect(ctl).toBeInstanceOf(BtwOverlayController);
		expect(custom).toHaveBeenCalledTimes(1);
		const opts = (custom as unknown as { lastOpts: { overlay: boolean; overlayOptions: unknown } }).lastOpts;
		expect(opts).toMatchObject({ overlay: true });
		expect(opts.overlayOptions).toMatchObject({ anchor: "bottom-center" });
	});

	it("controller returned by the factory is the same one exposed via controllerReady", async () => {
		let factoryCtl: BtwOverlayController | undefined;
		const custom = vi.fn((factory: unknown) => {
			const f = factory as (
				tui: TUI,
				theme: Theme,
				kb: undefined,
				done: (v: undefined) => void,
			) => BtwOverlayController;
			factoryCtl = f(
				{ requestRender: vi.fn(), terminal: { rows: 24 } } as unknown as TUI,
				identityTheme,
				undefined,
				() => {},
			);
			return new Promise<void>(() => {});
		});
		const ctx = { ui: { custom } } as never;
		const { controllerReady } = showBtwOverlay({
			ctx,
			question: "q",
			history: [],
			controller: new AbortController(),
			onClearHistory: vi.fn(),
		});
		const ctl = await controllerReady;
		expect(ctl).toBe(factoryCtl);
	});
});
