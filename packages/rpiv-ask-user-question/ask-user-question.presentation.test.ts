import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import { HOST_ALLOCATED_ROWS, resolvePresentation } from "./presentation.js";
import type { QuestionnaireSessionComponent } from "./state/questionnaire-session.js";
import type { QuestionnaireResult } from "./tool/types.js";
import { HINT_PART_CANCEL } from "./view/dialog-builder.js";

type Factory = (
	tui: unknown,
	theme: unknown,
	keybindings: unknown,
	done: (result: QuestionnaireResult) => void,
) => QuestionnaireSessionComponent;
type CustomOptions = { overlay?: boolean; overlayOptions?: unknown };

const DOWN = "\x1b[B";
const ENTER = "\r";
const COLLAPSE = "\x1d"; // ctrl+]

const twoOptions = {
	questions: [
		{
			question: "Where should the dialog appear?",
			header: "Layout",
			options: [{ label: "Inline" }, { label: "Overlay" }],
		},
	],
};
// Renders 19 rows at width 100 — taller than the inline budget on a 24-row terminal.
const fourDescribedOptions = {
	questions: [
		{
			question: "Which approach should we take for the cache layer?",
			header: "Cache",
			options: [1, 2, 3, 4].map((i) => ({
				label: `Option ${i}`,
				description: `A reasonably long description of option ${i} that explains the trade-off.`,
			})),
		},
	],
};
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

let root: string;

function writeConfig(config: object): void {
	const path = join(root, "rpiv-ask-user-question", "config.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config));
}

/** Occupy the inline slot as a concurrent questionnaire would, so the next one falls back to the overlay. */
async function withInlineSlotHeld(body: () => Promise<void>): Promise<void> {
	const holder = resolvePresentation();
	try {
		await body();
	} finally {
		holder.release?.();
	}
}

function mount(factory: Factory, rows = 24, done: (r: QuestionnaireResult) => void = () => {}) {
	return factory({ requestRender() {}, terminal: { columns: 100, rows } }, theme, getKeybindings(), done);
}

function setup(custom: (factory: Factory, options?: CustomOptions) => Promise<unknown>) {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	const removeListener = vi.fn();
	const onTerminalInput = vi.fn(() => removeListener);
	const ctx = createMockCtx({ hasUI: true, ui: { custom: vi.fn(custom), onTerminalInput } as never });
	const run = (params: object) =>
		captured.tools.get("ask_user_question")!.execute!("tc", params as never, undefined, undefined, ctx as never);
	return { run, ctx, onTerminalInput, removeListener };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "rpiv-question-render-"));
	vi.stubEnv("XDG_CONFIG_HOME", root);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("inline presentation", () => {
	it.each([{}, { renderMode: "overlay" }])("mounts in the editor slot (config %j)", async (config) => {
		// `renderMode` shipped only in unreleased builds; a leftover value is ignored.
		writeConfig(config);
		const { run, ctx, onTerminalInput } = setup(async () => ({ answers: [], cancelled: true }));
		await run(twoOptions);
		expect(vi.mocked(ctx.ui.custom).mock.calls[0]?.[1]).toEqual({ overlay: false });
		expect(onTerminalInput).not.toHaveBeenCalled();
	});

	it("collapses to a visible row without a raw listener, and still submits", async () => {
		const { run, ctx, onTerminalInput } = setup(async (factory, options) => {
			expect(options).toEqual({ overlay: false });
			let result: QuestionnaireResult | undefined;
			const component = mount(factory, 24, (answer) => {
				result = answer;
			});
			expect(component.render(100).length).toBeGreaterThan(1);
			// No overlay handle to hide: collapse keeps a focused one-row component that re-expands.
			component.handleInput(COLLAPSE);
			expect(component.render(100)).toHaveLength(1);
			component.handleInput(COLLAPSE);
			expect(component.render(100).length).toBeGreaterThan(1);
			component.handleInput(ENTER);
			return result;
		});
		const result = await run(twoOptions);
		expect(ctx.ui.custom).toHaveBeenCalledOnce();
		expect(result.details).toMatchObject({ cancelled: false, answers: [{ kind: "option", answer: "Inline" }] });
		expect(onTerminalInput).not.toHaveBeenCalled();
	});

	it("caps the dialog to the inline row budget and keeps the footer and focused option visible", async () => {
		const rows = 24;
		const budget = 16; // 70% of 24 — pinned literally so a budget regression cannot move the goalposts
		const { run } = setup(async (factory) => {
			const component = mount(factory, rows);
			for (const pressDown of [false, true, true, true]) {
				if (pressDown) component.handleInput(DOWN);
				const lines = component.render(100);
				expect(lines.length).toBeLessThanOrEqual(budget);
				// The host clips the editor slot from the bottom, so the hint row must be last.
				expect(lines.at(-1)).toContain(HINT_PART_CANCEL);
				// The question being answered stays pinned while the options scroll.
				expect(lines.some((line) => line.includes("Which approach should we take"))).toBe(true);
			}
			expect(component.render(100).some((line) => line.includes("Option 4"))).toBe(true);
			return { answers: [], cancelled: true };
		});
		await run(fourDescribedOptions);
	});

	it.each([
		{ cols: 120, rows: 24, layout: "side-by-side", described: false },
		{ cols: 90, rows: 30, layout: "stacked", described: true },
	])(
		"fits a long preview into the inline budget as a closed box ($layout, $cols×$rows) — #210",
		async ({ cols, rows, described }) => {
			initTheme(); // markdown preview rendering reads Pi's theme
			const code = (tag: string) =>
				`\`\`\`\n${Array.from({ length: 40 }, (_, i) => `${tag}${i + 1}`).join("\n")}\n\`\`\``;
			const withPreviews = {
				questions: [
					{
						question: "Apply which patch to the pricing cache?",
						header: "Patch",
						options: [1, 2, 3, 4].slice(0, described ? 4 : 2).map((i) => ({
							label: `Patch ${i}`,
							description: described ? `Trade-off summary for patch ${i}, one sentence long.` : "",
							preview: code(`L${i}_`),
						})),
					},
				],
			};
			const { run } = setup(async (factory) => {
				const lines = factory(
					{ requestRender() {}, terminal: { columns: cols, rows } },
					theme,
					getKeybindings(),
					() => {},
				)
					.render(cols)
					.map((l) => l.replace(/\x1b\[[0-9;:]*m/g, ""));
				expect(lines.length).toBeLessThanOrEqual(Math.floor(rows * 0.7));
				expect(lines.some((l) => l.includes("Apply which patch"))).toBe(true);
				expect(lines.some((l) => l.includes("L1_1"))).toBe(true); // the focused option's preview is in view
				expect(lines.some((l) => l.includes("┌"))).toBe(true);
				expect(lines.some((l) => l.includes("└") && l.includes("lines hidden"))).toBe(true);
				expect(lines.at(-1)).toContain(HINT_PART_CANCEL);
				return { answers: [], cancelled: true };
			});
			await run(withPreviews);
		},
	);

	it("uses a host's whole allocated band instead of capping it again", async () => {
		// rpiv-pi's lane console reports its band as terminal.rows and marks it allocated.
		const { run } = setup(async (factory) => {
			const tui = { requestRender() {}, terminal: { columns: 100, rows: 19, [HOST_ALLOCATED_ROWS]: true } };
			const lines = factory(tui, theme, getKeybindings(), () => {}).render(100);
			expect(lines.length).toBe(19); // natural height 19; the 70% inline cap would be 13
			expect(lines.some((line) => line.includes("Option 4"))).toBe(true);
			return { answers: [], cancelled: true };
		});
		await run(fourDescribedOptions);
	});

	it("leaves the fallback overlay at its natural height for the same questionnaire", async () => {
		const { run } = setup(async (factory, options) => {
			expect(options?.overlay).toBe(true);
			const lines = mount(factory, 24).render(100);
			expect(lines.length).toBeGreaterThan(16);
			expect(lines.length).toBeLessThanOrEqual(24);
			return { answers: [], cancelled: true };
		});
		await withInlineSlotHeld(() => run(fourDescribedOptions).then(() => {}));
	});

	it("degrades a concurrent questionnaire to the overlay instead of replacing the mounted one", async () => {
		const modes: Array<boolean | undefined> = [];
		const pending: Array<() => void> = [];
		const { run } = setup(
			(_factory, options) =>
				new Promise((resolve) => {
					modes.push(options?.overlay);
					pending.push(() => resolve({ answers: [], cancelled: true }));
				}),
		);
		const first = run(twoOptions);
		const second = run(twoOptions);
		await vi.waitFor(() => expect(modes).toHaveLength(2));
		expect(modes).toEqual([false, true]);
		for (const settle of pending) settle();
		await Promise.all([first, second]);

		// The slot is free again once both settle.
		const third = run(twoOptions);
		await vi.waitFor(() => expect(modes).toHaveLength(3));
		expect(modes[2]).toBe(false);
		pending[2]!();
		await third;
	});

	it("stacks as an overlay instead when another overlay (e.g. /btw) is already on screen", async () => {
		const calls: Array<CustomOptions | undefined> = [];
		let overlayShowing = true;
		const { run, onTerminalInput } = setup(
			(factory, options) =>
				new Promise((resolve) => {
					calls.push(options);
					const tui = {
						requestRender() {},
						terminal: { columns: 100, rows: 24 },
						hasOverlay: () => overlayShowing,
					};
					const component = factory(tui, theme, getKeybindings(), resolve);
					if (options?.overlay) {
						expect(component.render(100).length).toBeGreaterThan(1);
						component.handleInput(ENTER);
					} else {
						// A yielding factory has already resolved; otherwise settle the inline mount.
						resolve({ answers: [], cancelled: true });
					}
				}),
		);
		const result = await run(twoOptions);
		expect(calls.map((o) => o?.overlay)).toEqual([false, true]);
		expect(calls[1]).toMatchObject({ overlayOptions: { anchor: "bottom-center" } });
		// Stacked over another overlay, collapse must not hide (Pi pops the TOPMOST overlay on
		// close), so no raw reopen listener is registered and collapse keeps a visible row.
		expect(onTerminalInput).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({ cancelled: false, answers: [{ kind: "option", answer: "Inline" }] });

		// The inline slot was handed back: with nothing on screen the next question goes inline.
		overlayShowing = false;
		await run(twoOptions);
		expect(calls[2]?.overlay).toBe(false);
	});

	it("releases the slot when the questionnaire throws", async () => {
		const modes: Array<boolean | undefined> = [];
		let fail = true;
		const { run } = setup(async (_factory, options) => {
			modes.push(options?.overlay);
			if (fail) throw new Error("mount failed");
			return { answers: [], cancelled: true };
		});
		await expect(run(twoOptions)).rejects.toThrow("mount failed");
		fail = false;
		await run(twoOptions);
		expect(modes).toEqual([false, false]);
	});
});

describe("overlay fallback", () => {
	it("opens a focused overlay with the raw collapse listener while another questionnaire holds the slot", async () => {
		const { run, ctx, onTerminalInput, removeListener } = setup(async () => ({ answers: [], cancelled: true }));
		await withInlineSlotHeld(() => run(twoOptions).then(() => {}));
		expect(vi.mocked(ctx.ui.custom).mock.calls[0]?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: { anchor: "bottom-center", maxHeight: "100%" },
		});
		expect(onTerminalInput).toHaveBeenCalledOnce();
		expect(removeListener).toHaveBeenCalledOnce();
	});
});
