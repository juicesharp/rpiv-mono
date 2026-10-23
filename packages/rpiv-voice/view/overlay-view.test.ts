import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { initialVoiceState, type VoiceState } from "../state/state.ts";
import { OverlayView } from "./overlay-view.ts";
import type { ScreenContentStrategy } from "./screen-content-strategy.ts";

// Minimal fake Component: emits a fixed line per call. The OverlayView
// pipeline pours these through pi-tui's Container, which preserves line count
// and prepends/appends per-child lines verbatim — so we can count rows and
// recognize markers ("D"/"S"/"=") without depending on Container styling.
function fakeLines(lines: string[]): Component {
	return {
		render: () => [...lines],
		invalidate: () => {},
	};
}

class FakeStrategy implements ScreenContentStrategy {
	constructor(
		readonly kind: "dictation" | "settings",
		private readonly rows: string[][],
	) {}
	children(): readonly Component[] {
		return this.rows.map(fakeLines);
	}
}

function makeOverlay(opts: { rows: number | undefined; dictation: string[][]; settings: string[][] }): OverlayView {
	return new OverlayView({
		tui: { terminal: { columns: 80, rows: opts.rows } },
		dictation: new FakeStrategy("dictation", opts.dictation),
		settings: new FakeStrategy("settings", opts.settings),
	});
}

function withScreen(state: VoiceState, screen: VoiceState["currentScreen"]): VoiceState {
	return { ...state, currentScreen: screen };
}

// Equalizer ON: bottom chrome = [DIVIDER, EQ-1…EQ-7, STATUS] = 9 rows. The
// equalizer's mirrored vertical-bar design reserves 7 rows (centerline + 3
// above + 3 below) so each amp step is symmetric around the centre. All tests
// in this file exercise the eq-enabled layout because that's the non-trivial
// chrome anchor. The eq-disabled path is exercised by the equalizer-view
// tests (component returns []) and the projections tests.
const DRAFT = { hallucinationFilterEnabled: true, equalizerEnabled: true };
const CHROME = [["DIVIDER"], ["EQ-1"], ["EQ-2"], ["EQ-3"], ["EQ-4"], ["EQ-5"], ["EQ-6"], ["EQ-7"], ["STATUS"]];
const CHROME_ROWS = CHROME.length;

describe("OverlayView height stabilization", () => {
	it("renders empty when state has not been set yet", () => {
		const overlay = makeOverlay({
			rows: 24,
			dictation: [["d1", "d2", "d3"], ...CHROME],
			settings: [["s1"], ...CHROME],
		});
		expect(overlay.render(80)).toEqual([]);
	});

	it("pads the shorter screen up to the high-water-mark of the taller one", () => {
		const overlay = makeOverlay({
			rows: 24,
			// dictation body = 5 rows
			dictation: [["d1", "d2", "d3", "d4", "d5"], ...CHROME],
			// settings body = 1 row
			settings: [["s1"], ...CHROME],
		});

		const dict = initialVoiceState(DRAFT);
		overlay.setProps({ state: dict });
		const dictRows = overlay.render(80);
		// 5 body + 9 chrome = 14 rows, no padding needed.
		expect(dictRows).toHaveLength(5 + CHROME_ROWS);
		expect(dictRows[dictRows.length - 1]).toContain("STATUS");

		// Flip to settings — should pad up to 5 body rows even though settings
		// only has 1 row of body content.
		overlay.setProps({ state: withScreen(dict, "settings") });
		const settRows = overlay.render(80);
		expect(settRows).toHaveLength(5 + CHROME_ROWS);
		for (let i = 0; i < CHROME_ROWS; i++) {
			expect(settRows[settRows.length - CHROME_ROWS + i]).toContain(CHROME[i]![0]);
		}
		// First 4 rows should be empty padding, then "s1", then chrome rows.
		expect(settRows.slice(0, 4)).toEqual(["", "", "", ""]);
		expect(settRows[4]).toContain("s1");
	});

	it("never shrinks the high-water-mark once established", () => {
		const overlay = makeOverlay({
			rows: 24,
			dictation: [["d1", "d2", "d3", "d4"], ...CHROME],
			settings: [["s1"], ...CHROME],
		});
		const dict = initialVoiceState(DRAFT);

		overlay.setProps({ state: withScreen(dict, "settings") });
		const before = overlay.render(80);
		// 4 body (settings padded by dictation render) + 9 chrome = 13 rows.
		expect(before).toHaveLength(4 + CHROME_ROWS);

		overlay.setProps({ state: dict });
		expect(overlay.render(80)).toHaveLength(4 + CHROME_ROWS);

		overlay.setProps({ state: withScreen(dict, "settings") });
		const after = overlay.render(80);
		expect(after).toHaveLength(4 + CHROME_ROWS);
	});

	it("pins divider + equalizer + status to the bottom chrome rows regardless of screen", () => {
		const overlay = makeOverlay({
			rows: 24,
			dictation: [["d1", "d2", "d3"], ...CHROME],
			settings: [["s1"], ...CHROME],
		});
		const dict = initialVoiceState(DRAFT);

		const expectChromePinned = (rows: string[]) => {
			for (let i = 0; i < CHROME_ROWS; i++) {
				expect(rows[rows.length - CHROME_ROWS + i]).toContain(CHROME[i]![0]);
			}
		};

		overlay.setProps({ state: dict });
		expectChromePinned(overlay.render(80));

		overlay.setProps({ state: withScreen(dict, "settings") });
		expectChromePinned(overlay.render(80));
	});
});

describe("OverlayView clipToTerminalHeight integration", () => {
	it("top-clips when content exceeds 85% of terminal height", () => {
		// Terminal rows = 16 → maxRows = floor(16 * 0.85) = 13.
		const longBody = Array.from({ length: 12 }, (_, i) => `line-${i}`);
		const overlay = makeOverlay({
			rows: 16,
			dictation: [longBody, ...CHROME],
			settings: [["s1"], ...CHROME],
		});
		const dict = initialVoiceState(DRAFT);
		overlay.setProps({ state: dict });

		const rows = overlay.render(80);
		// 12 body + 9 chrome = 21 rendered, clipped to 13.
		expect(rows.length).toBe(13);
		// Bottom chrome must survive — the clip is from the top.
		for (let i = 0; i < CHROME_ROWS; i++) {
			expect(rows[rows.length - CHROME_ROWS + i]).toContain(CHROME[i]![0]);
		}
		// First content row should be one of the later body lines (top was dropped).
		const earliestSurvivingIdx = Number(rows[0].match(/line-(\d+)/)?.[1] ?? -1);
		expect(earliestSurvivingIdx).toBeGreaterThan(0);
	});

	it("falls back to 24 rows when terminal.rows is undefined", () => {
		// 24 rows → maxRows = 20. A 28-row payload should clip to 20.
		const longBody = Array.from({ length: 24 }, (_, i) => `line-${i}`);
		const overlay = makeOverlay({
			rows: undefined,
			dictation: [longBody, ...CHROME],
			settings: [["s1"], ...CHROME],
		});
		overlay.setProps({ state: initialVoiceState(DRAFT) });
		const rows = overlay.render(80);
		expect(rows.length).toBe(20);
		expect(rows[rows.length - 1]).toContain("STATUS");
	});

	it("respects the MIN_RENDER_ROWS=4 floor on tiny terminals", () => {
		// 1 row * 0.85 = 0 → floor 4.
		const overlay = makeOverlay({
			rows: 1,
			dictation: [["d1", "d2", "d3", "d4", "d5", "d6"], ...CHROME],
			settings: [["s1"], ...CHROME],
		});
		overlay.setProps({ state: initialVoiceState(DRAFT) });
		const rows = overlay.render(80);
		expect(rows.length).toBe(4);
		expect(rows[rows.length - 1]).toContain("STATUS");
	});
});
