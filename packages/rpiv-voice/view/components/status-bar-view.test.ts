import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STATUS_BAR_PULSE_FRAME_INTERVAL_MS, StatusBarView } from "./status-bar-view.ts";

const theme = makeTheme() as unknown as Theme;
const WIDTH = 80;

// Date.now() is sampled three times: at construction (startedAtMs), on each
// setProps that crosses a paused boundary, and inside elapsedMs() during
// render. Pinning it deterministically lets us assert the rendered timer
// without timing flake.
function pinTime(initial: number): {
	advance(ms: number): void;
	restore(): void;
} {
	let now = initial;
	const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
	return {
		advance(ms: number) {
			now += ms;
		},
		restore() {
			spy.mockRestore();
		},
	};
}

describe("StatusBarView.tickPulse()", () => {
	it("cycles glyph color through the 4-frame pulse pattern", () => {
		// RECORDING_PULSE_COLORS is ["error","error","error","dim"] — three loud
		// frames + one dim = a heartbeat blink. We assert the full sequence by
		// observing the glyph's color key across consecutive ticks.
		const tagged = makeTheme({
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		}) as unknown as Theme;
		const view = new StatusBarView(tagged);
		view.setProps({ status: "recording", hints: [] });

		// Glyph is the first wrapped span in the line. Pull just the color key.
		const colorOf = (line: string): string | undefined => {
			const m = line.match(/^<([^>]+)>/);
			return m ? m[1] : undefined;
		};

		const sequence: string[] = [];
		for (let i = 0; i < 8; i++) {
			const c = colorOf(view.render(WIDTH)[0]);
			if (c) sequence.push(c);
			view.tickPulse();
		}
		expect(sequence).toEqual(["error", "error", "error", "dim", "error", "error", "error", "dim"]);
	});

	it("does not change pulse color when status is paused", () => {
		const tagged = makeTheme({
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		}) as unknown as Theme;
		const view = new StatusBarView(tagged);
		view.setProps({ status: "paused", hints: [] });
		const before = view.render(WIDTH)[0];
		view.tickPulse();
		view.tickPulse();
		view.tickPulse();
		view.tickPulse();
		const after = view.render(WIDTH)[0];
		expect(after).toBe(before);
		// Pause uses the static "warning" glyph color from STATUS_META, not error.
		expect(before).toContain("<warning>");
		expect(before).not.toContain("<error>");
	});
});

describe("StatusBarView elapsed-time formatting", () => {
	let clock: ReturnType<typeof pinTime>;

	beforeEach(() => {
		clock = pinTime(1_000_000);
	});

	afterEach(() => {
		clock.restore();
	});

	it("renders 0:00 immediately after construction", () => {
		const view = new StatusBarView(theme);
		view.setProps({ status: "recording", hints: [] });
		const line = view.render(WIDTH)[0];
		expect(line).toContain("0:00");
	});

	it("formats sub-minute elapsed as m:ss with zero-padded seconds", () => {
		const view = new StatusBarView(theme);
		view.setProps({ status: "recording", hints: [] });
		clock.advance(7_000);
		expect(view.render(WIDTH)[0]).toContain("0:07");
		clock.advance(53_000);
		expect(view.render(WIDTH)[0]).toContain("1:00");
	});

	it("rolls past minute boundaries cleanly", () => {
		const view = new StatusBarView(theme);
		view.setProps({ status: "recording", hints: [] });
		clock.advance(125_000); // 2:05
		expect(view.render(WIDTH)[0]).toContain("2:05");
	});

	it("excludes paused duration from the elapsed timer", () => {
		const view = new StatusBarView(theme);
		view.setProps({ status: "recording", hints: [] });
		clock.advance(5_000); // 0:05 recording
		view.setProps({ status: "paused", hints: [] });
		clock.advance(60_000); // pause for a minute — should NOT count
		view.setProps({ status: "recording", hints: [] });
		clock.advance(3_000); // resume + 0:03
		expect(view.render(WIDTH)[0]).toContain("0:08");
	});

	it("freezes the timer while paused (live pause excluded)", () => {
		const view = new StatusBarView(theme);
		view.setProps({ status: "recording", hints: [] });
		clock.advance(10_000); // 0:10
		view.setProps({ status: "paused", hints: [] });
		clock.advance(30_000); // still paused
		expect(view.render(WIDTH)[0]).toContain("0:10");
		clock.advance(30_000); // still paused
		expect(view.render(WIDTH)[0]).toContain("0:10");
	});
});

describe("StatusBarView constants", () => {
	it("exports a sensible pulse interval", () => {
		expect(STATUS_BAR_PULSE_FRAME_INTERVAL_MS).toBeGreaterThan(0);
		expect(STATUS_BAR_PULSE_FRAME_INTERVAL_MS).toBeLessThan(1000);
	});
});
