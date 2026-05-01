import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		openSync: vi.fn(),
		writeSync: vi.fn(),
		closeSync: vi.fn(),
	};
});

import {
	__resetState,
	activeTitle,
	FRAME_INTERVAL_MS,
	SPINNER_FRAMES,
	startSpinner,
	stopSpinner,
} from "./title-spinner.js";

const PUSH = "\x1b[22;0t";
const POP = "\x1b[23;0t";

function primeFs(): { open: Mock; write: Mock; close: Mock } {
	(fs.openSync as unknown as Mock).mockReturnValue(11);
	(fs.writeSync as unknown as Mock).mockReturnValue(0);
	(fs.closeSync as unknown as Mock).mockReturnValue(undefined);
	return {
		open: fs.openSync as unknown as Mock,
		write: fs.writeSync as unknown as Mock,
		close: fs.closeSync as unknown as Mock,
	};
}

function bytesAt(write: Mock, callIndex: number): string {
	return String(write.mock.calls[callIndex][1]);
}

function titleSetBody(write: Mock, callIndex: number): string {
	return bytesAt(write, callIndex)
		.replace(/^\x1b\]0;/, "")
		.replace(/\x07$/, "");
}

beforeEach(() => {
	__resetState();
	(fs.openSync as unknown as Mock).mockReset();
	(fs.writeSync as unknown as Mock).mockReset();
	(fs.closeSync as unknown as Mock).mockReset();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	__resetState();
});

describe("activeTitle", () => {
	it("returns the spinner glyph alone when no suffix is given", () => {
		expect(activeTitle(0)).toBe(SPINNER_FRAMES[0]);
	});
	it("appends the suffix verbatim — only the first character is the rotating glyph", () => {
		expect(activeTitle(0, " - rpiv-mono")).toBe(`${SPINNER_FRAMES[0]} - rpiv-mono`);
		expect(activeTitle(3, " - rpiv-mono")).toBe(`${SPINNER_FRAMES[3]} - rpiv-mono`);
	});
	it("wraps frame index modulo SPINNER_FRAMES.length", () => {
		expect(activeTitle(SPINNER_FRAMES.length)).toBe(activeTitle(0));
		expect(activeTitle(SPINNER_FRAMES.length + 3)).toBe(activeTitle(3));
	});
});

describe("SPINNER_FRAMES", () => {
	it("rotates a 3-of-4 cluster — the missing dot walks the 2×2 grid clockwise", () => {
		expect(SPINNER_FRAMES).toEqual(["⠴", "⠦", "⠖", "⠲"]);
		for (const f of SPINNER_FRAMES) expect(f).toMatch(/^[⠀-⣿]$/);
	});
});

describe("startSpinner / stopSpinner", () => {
	it("start pushes the title stack and does not write a glyph synchronously", () => {
		const { write } = primeFs();
		startSpinner();
		expect(write).toHaveBeenCalledOnce();
		expect(bytesAt(write, 0)).toBe(PUSH);
	});

	it("ticks the title every FRAME_INTERVAL_MS, advancing through SPINNER_FRAMES", () => {
		const { write } = primeFs();
		startSpinner();
		vi.advanceTimersByTime(FRAME_INTERVAL_MS);
		expect(titleSetBody(write, 1)).toBe(activeTitle(0));
		vi.advanceTimersByTime(FRAME_INTERVAL_MS);
		expect(titleSetBody(write, 2)).toBe(activeTitle(1));
		vi.advanceTimersByTime(FRAME_INTERVAL_MS);
		expect(titleSetBody(write, 3)).toBe(activeTitle(2));
	});

	it("threads the suffix through every tick — only the first character rotates", () => {
		const { write } = primeFs();
		startSpinner(" - rpiv-mono");
		vi.advanceTimersByTime(FRAME_INTERVAL_MS);
		expect(titleSetBody(write, 1)).toBe(`${SPINNER_FRAMES[0]} - rpiv-mono`);
		vi.advanceTimersByTime(FRAME_INTERVAL_MS);
		expect(titleSetBody(write, 2)).toBe(`${SPINNER_FRAMES[1]} - rpiv-mono`);
	});

	it("wraps the frame index back to 0 after SPINNER_FRAMES.length ticks", () => {
		const { write } = primeFs();
		startSpinner();
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * (SPINNER_FRAMES.length + 1));
		expect(titleSetBody(write, 1)).toBe(activeTitle(0));
		expect(titleSetBody(write, 1 + SPINNER_FRAMES.length)).toBe(activeTitle(0));
	});

	it("stop clears the interval and pops the title stack (original restored)", () => {
		const { write } = primeFs();
		startSpinner();
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 2);
		const before = write.mock.calls.length;
		stopSpinner();
		expect(write).toHaveBeenCalledTimes(before + 1);
		expect(bytesAt(write, before)).toBe(POP);
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 5);
		expect(write).toHaveBeenCalledTimes(before + 1);
	});

	it("startSpinner is idempotent — second call while running does NOT push again", () => {
		const { write } = primeFs();
		startSpinner();
		startSpinner();
		const pushes = write.mock.calls.filter((c) => String(c[1]) === PUSH).length;
		expect(pushes).toBe(1);
	});

	it("stopSpinner is idempotent — call without an active ticker does NOT pop", () => {
		const { write } = primeFs();
		stopSpinner();
		expect(write).not.toHaveBeenCalled();
	});

	it("__resetState clears any pending interval without emitting a pop", () => {
		const { write } = primeFs();
		startSpinner();
		const afterPush = write.mock.calls.length;
		__resetState();
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 5);
		expect(write).toHaveBeenCalledTimes(afterPush);
	});
});
