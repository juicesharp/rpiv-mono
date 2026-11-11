import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";

import { EqualizerView } from "./equalizer-view.ts";

const WIDTH = 60;
const ROW_COUNT = 7;
const CENTER_ROW = 3;
const BAR_GLYPH = "█";

const taggedTheme = makeTheme({
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
}) as unknown as Theme;

function payload(line: string): string {
	return line.replace(/<\/?[^>]+>/g, "");
}

function colorKeys(line: string): string[] {
	const seen = new Set<string>();
	const order: string[] = [];
	for (const m of line.matchAll(/<([^/][^>]*)>/g)) {
		const key = m[1]!;
		if (seen.has(key)) continue;
		seen.add(key);
		order.push(key);
	}
	return order;
}

function barCellsForRow(line: string): string[] {
	const cells = [...line];
	const out: string[] = [];
	for (let c = 0; c < cells.length; c += 2) out.push(cells[c]!);
	return out;
}

function barHeights(rows: string[]): number[] {
	const stripped = rows.map(payload);
	const perRow = stripped.map(barCellsForRow);
	const nBars = perRow[0]?.length ?? 0;
	const h = new Array<number>(nBars).fill(0);
	for (const row of perRow) {
		for (let s = 0; s < nBars; s++) if (row[s] === BAR_GLYPH) h[s]! += 1;
	}
	return h;
}

describe("EqualizerView.render() — traveling-wave bar lattice", () => {
	it("renders ROW_COUNT rows while recording", () => {
		const view = new EqualizerView(taggedTheme);
		view.setProps({ level: 0.1, status: "recording", enabled: true });
		expect(view.render(WIDTH)).toHaveLength(ROW_COUNT);
	});

	it("keeps odd column indices blank — bars never touch each other", () => {
		const view = new EqualizerView(taggedTheme);
		for (let i = 0; i < 30; i++) view.setProps({ level: 0.1, status: "recording", enabled: true });
		const rows = view.render(WIDTH).map(payload);
		for (const row of rows) {
			for (let c = 1; c < row.length; c += 2) {
				expect(row[c]).toBe(" ");
			}
		}
	});

	it("paints every bar symmetrically around the centerline", () => {
		const view = new EqualizerView(taggedTheme);
		for (let i = 0; i < 30; i++) view.setProps({ level: 0.1, status: "recording", enabled: true });
		const rows = view.render(WIDTH).map(payload);
		const perRow = rows.map(barCellsForRow);
		const nBars = perRow[0]!.length;
		for (let s = 0; s < nBars; s++) {
			for (let k = 1; k <= CENTER_ROW; k++) {
				expect(perRow[CENTER_ROW - k]![s]).toBe(perRow[CENTER_ROW + k]![s]);
			}
		}
	});

	it("lights the centerline row first (centre-out fill)", () => {
		const view = new EqualizerView(taggedTheme);
		for (let i = 0; i < 30; i++) view.setProps({ level: 0.1, status: "recording", enabled: true });
		const rows = view.render(WIDTH).map(payload);
		const perRow = rows.map(barCellsForRow);
		const nBars = perRow[0]!.length;
		const center = perRow[CENTER_ROW]!;
		for (let s = 0; s < nBars; s++) {
			const anyLit = perRow.some((row) => row[s] === BAR_GLYPH);
			if (anyLit) expect(center[s]).toBe(BAR_GLYPH);
		}
	});

	it("clusters adjacent bars at similar heights (smooth traveling wave, not per-bar shimmer)", () => {
		const view = new EqualizerView(taggedTheme);
		for (let i = 0; i < 30; i++) view.setProps({ level: 0.1, status: "recording", enabled: true });
		const h = barHeights(view.render(WIDTH));
		let maxRun = 1;
		let currentRun = 1;
		for (let i = 1; i < h.length; i++) {
			if (h[i] === h[i - 1]) {
				currentRun += 1;
				if (currentRun > maxRun) maxRun = currentRun;
			} else {
				currentRun = 1;
			}
		}
		expect(maxRun).toBeGreaterThanOrEqual(3);
	});

	it("keeps the very edges at zero — equalizer never fills the row, however the wave is phased", () => {
		const view = new EqualizerView(taggedTheme);
		for (let i = 0; i < 100; i++) view.setProps({ level: 0.1, status: "recording", enabled: true });
		const h = barHeights(view.render(WIDTH));
		// Trapezoid envelope hits hard-zero past PLATEAU+FADE — the leftmost and
		// rightmost slots stay blank at every phase of the traveling wave.
		expect(h[0]).toBe(0);
		expect(h[h.length - 1]).toBe(0);
	});

	it("animates: the silhouette changes between successive recording ticks", () => {
		const view = new EqualizerView(taggedTheme);
		view.setProps({ level: 0.1, status: "recording", enabled: true });
		const frame0 = view.render(WIDTH).map(payload).join("\n");
		view.setProps({ level: 0.1, status: "recording", enabled: true });
		const frame1 = view.render(WIDTH).map(payload).join("\n");
		expect(frame1).not.toBe(frame0);
	});

	it("travels: the silhouette eventually visits a meaningfully different shape", () => {
		const view = new EqualizerView(taggedTheme);
		view.setProps({ level: 0.1, status: "recording", enabled: true });
		const startHeights = barHeights(view.render(WIDTH));
		let diverged = false;
		for (let i = 0; i < 30; i++) {
			view.setProps({ level: 0.1, status: "recording", enabled: true });
			const h = barHeights(view.render(WIDTH));
			let diff = 0;
			for (let s = 0; s < h.length; s++) diff += Math.abs(h[s]! - startHeights[s]!);
			if (diff > h.length / 2) {
				diverged = true;
				break;
			}
		}
		expect(diverged).toBe(true);
	});

	it("scales overall amplitude with audio level (loud taller than quiet)", () => {
		const quiet = new EqualizerView(taggedTheme);
		const loud = new EqualizerView(taggedTheme);
		for (let i = 0; i < 30; i++) {
			quiet.setProps({ level: 0.02, status: "recording", enabled: true });
			loud.setProps({ level: 0.5, status: "recording", enabled: true });
		}
		const sum = (rows: string[]) => barHeights(rows).reduce((a, b) => a + b, 0);
		expect(sum(loud.render(WIDTH))).toBeGreaterThan(sum(quiet.render(WIDTH)));
	});

	it("stays blank while recording is silent (level=0)", () => {
		const view = new EqualizerView(taggedTheme);
		// Pump 30 ticks of true silence (level=0) — the lattice should never
		// animate even though status=recording.
		for (let i = 0; i < 30; i++) view.setProps({ level: 0, status: "recording", enabled: true });
		const rows = view.render(WIDTH).map(payload);
		expect(rows).toHaveLength(ROW_COUNT);
		for (const row of rows) expect(row.replace(/ /g, "")).toBe("");
	});

	it("blanks the silhouette after sustained silence following speech (grace window expires)", () => {
		const view = new EqualizerView(taggedTheme);
		// Speak for a while so the wave runs.
		for (let i = 0; i < 20; i++) view.setProps({ level: 0.1, status: "recording", enabled: true });
		const speakingFrame = view.render(WIDTH).map(payload).join("\n");
		expect(speakingFrame.replace(/[\n ]/g, "")).not.toBe("");
		// Drop to silence and wait past the grace window.
		for (let i = 0; i < 30; i++) view.setProps({ level: 0, status: "recording", enabled: true });
		const silentFrame = view.render(WIDTH).map(payload);
		for (const row of silentFrame) expect(row.replace(/ /g, "")).toBe("");
	});

	it("keeps animating across brief inter-word silences (grace window bridges them)", () => {
		const view = new EqualizerView(taggedTheme);
		// Warm up with speech.
		for (let i = 0; i < 10; i++) view.setProps({ level: 0.1, status: "recording", enabled: true });
		const a = view.render(WIDTH).map(payload).join("\n");
		// One quick silent gap and back to speech for a few ticks. With the
		// sharp parabolic bell envelope only a handful of centre slots are
		// ever lit, so the post-silence frame needs enough phase advance to
		// guarantee the noise field has moved meaningfully — 6 speech ticks
		// covers it without exceeding the natural fade window.
		for (let i = 0; i < 3; i++) view.setProps({ level: 0, status: "recording", enabled: true });
		for (let i = 0; i < 6; i++) view.setProps({ level: 0.1, status: "recording", enabled: true });
		const b = view.render(WIDTH).map(payload).join("\n");
		// Lattice still shows bars (not all spaces) and has advanced beyond `a`.
		expect(b.replace(/[\n ]/g, "")).not.toBe("");
		expect(b).not.toBe(a);
	});

	it("freezes the silhouette while paused (no phase advance)", () => {
		const view = new EqualizerView(taggedTheme);
		for (let i = 0; i < 20; i++) view.setProps({ level: 0.1, status: "recording", enabled: true });
		const before = view.render(WIDTH).map(payload).join("\n");
		for (let i = 0; i < 20; i++) view.setProps({ level: 0.1, status: "paused", enabled: true });
		const during = view.render(WIDTH).map(payload).join("\n");
		// Stripped of colour, the lattice shape is identical — pause only swaps
		// the shade tag to dim.
		expect(during).toBe(before);
	});

	it("derives a 4-tier truecolor gradient from the theme's accent when getFgAnsi is available", () => {
		// Plug a truecolor accent (R=126, G=231, B=208 — a typical mint) into a
		// mock theme that exposes getFgAnsi. The view should multiply the
		// channels by GRADIENT_BRIGHTNESS=[1.0, 0.65, 0.4, 0.22] and emit each
		// row with the corresponding ANSI escape.
		const truecolorTheme = {
			...makeTheme({ fg: (color: string, text: string) => `<${color}>${text}</${color}>` }),
			getFgAnsi: (key: string) => (key === "accent" ? "\x1b[38;2;126;231;208m" : "\x1b[0m"),
		} as unknown as Theme;
		const view = new EqualizerView(truecolorTheme);
		for (let i = 0; i < 30; i++) view.setProps({ level: 0.1, status: "recording", enabled: true });
		const rows = view.render(WIDTH);
		const escapes = rows.map((row) => row.match(/\x1b\[38;2;\d+;\d+;\d+m/)?.[0] ?? null);
		// Centerline uses the unscaled accent RGB.
		expect(escapes[CENTER_ROW]).toBe("\x1b[38;2;126;231;208m");
		// Symmetric mirror around the centerline — equidistant rows share an escape.
		for (let k = 1; k <= CENTER_ROW; k++) {
			expect(escapes[CENTER_ROW - k]).toBe(escapes[CENTER_ROW + k]);
		}
		// Edges are visibly dimmer than the centerline.
		expect(escapes[0]).not.toBe(escapes[CENTER_ROW]);
		// Each row terminates with the foreground-reset SGR so colours don't bleed.
		for (const row of rows) expect(row.endsWith("\x1b[39m")).toBe(true);
	});

	it("paints a vertical gradient: accent at the centerline, dimmer shades toward the edges", () => {
		const view = new EqualizerView(taggedTheme);
		for (let i = 0; i < 30; i++) view.setProps({ level: 0.1, status: "recording", enabled: true });
		const rows = view.render(WIDTH);
		// Each row still uses exactly one fg() segment.
		for (const row of rows) expect(colorKeys(row)).toHaveLength(1);
		// Centerline = accent (the full theme colour), edges = dim, with
		// progressively subtler shades in between. Equidistant rows share a
		// shade — the gradient is vertically symmetric.
		const expected = ["dim", "muted", "borderAccent", "accent", "borderAccent", "muted", "dim"];
		const actual = rows.map((row) => colorKeys(row)[0]);
		expect(actual).toEqual(expected);
	});

	it("collapses every row to a single dim segment while paused", () => {
		const view = new EqualizerView(taggedTheme);
		view.setProps({ level: 0.1, status: "paused", enabled: true });
		for (const row of view.render(WIDTH)) expect(colorKeys(row)).toEqual(["dim"]);
	});

	it("returns ROW_COUNT empty rows when width is zero", () => {
		const view = new EqualizerView(taggedTheme);
		view.setProps({ level: 0.1, status: "recording", enabled: true });
		expect(view.render(0)).toEqual(new Array<string>(ROW_COUNT).fill(""));
	});

	it("renders zero rows when disabled (component absent from layout)", () => {
		const view = new EqualizerView(taggedTheme);
		for (let i = 0; i < 20; i++) view.setProps({ level: 0.1, status: "recording", enabled: false });
		expect(view.render(WIDTH)).toEqual([]);
	});

	it("does not advance the wave while disabled (silhouette stays at its initial phase)", () => {
		const ticking = new EqualizerView(taggedTheme);
		const idle = new EqualizerView(taggedTheme);
		for (let i = 0; i < 20; i++) ticking.setProps({ level: 0.1, status: "recording", enabled: false });
		// Both views are now enabled for a single tick — the ticking one should
		// not have accumulated phase from the disabled period.
		ticking.setProps({ level: 0.1, status: "recording", enabled: true });
		idle.setProps({ level: 0.1, status: "recording", enabled: true });
		const tickedFrame = ticking.render(WIDTH).map(payload).join("\n");
		const idleFrame = idle.render(WIDTH).map(payload).join("\n");
		expect(tickedFrame).toBe(idleFrame);
	});

	it("keeps every row the same character count at any width", () => {
		const view = new EqualizerView(taggedTheme);
		view.setProps({ level: 0.1, status: "recording", enabled: true });
		for (const w of [20, 40, 80, 120]) {
			const rows = view.render(w).map(payload);
			for (const row of rows) expect([...row]).toHaveLength(w);
		}
	});
});
