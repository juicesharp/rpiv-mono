/**
 * Scrolling the lane transcript in Pi's fullscreen TUI (#173).
 *
 * Fullscreen Pi consumes PageUp/PageDown in its viewport before an editor-slot component
 * (where /lanes mounts) sees them — only a focused overlay gets them. So the browser also
 * pages on `u`/`d` (plain letters reach it), and takes the mouse wheel through
 * `handleMouse`: Pi offers a wheel event to the component under the pointer before it
 * scrolls the parent transcript. The last describe drives a REAL `TuiAltScreen`.
 */

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	ScrollView,
	type Terminal,
	Text,
	type TUI,
	TuiAltScreen,
	type TuiMouseEvent,
	VStack,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LaneConsole } from "./lane-console.js";
import {
	__resetRunLaneRegistry,
	enqueueInput,
	type LaneSession,
	recordRun,
	SINGLE_UNIT_KEY,
	setCurrentSession,
	setUnitStarted,
} from "./run-lane-registry.js";

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
} as unknown as Theme;

const PAGE_UP = "\x1b[5~";

function makeTui(rows = 24) {
	return { requestRender: vi.fn(), terminal: { rows, columns: 100 } } as unknown as TUI;
}

/** A live single-unit lane whose transcript is 50 numbered lines — taller than any window here. */
function longLane(): void {
	const branch = Array.from({ length: 50 }, (_v, i) => ({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: `line-${i}` }] },
	}));
	recordRun("run-1", "ship");
	setUnitStarted("run-1", SINGLE_UNIT_KEY, "unit");
	setCurrentSession("run-1", SINGLE_UNIT_KEY, {
		sessionId: "s",
		isStreaming: true,
		sessionManager: { getBranch: () => branch, getCwd: () => "/tmp" },
		getToolDefinition: () => undefined,
		getStreamingMessage: () => undefined,
		getUsage: () => undefined,
		subscribe: () => () => {},
	} as unknown as LaneSession);
}

function makePanel(tui: TUI = makeTui()): LaneConsole {
	const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, tui, identityTheme, {} as never, vi.fn(), vi.fn());
	panel.render(80); // prime the cached scroll bound (render computes it; scroll reads it)
	return panel;
}

const view = (panel: LaneConsole) => panel.render(80).join("\n");
const wheel = (wheelDelta: number, type: TuiMouseEvent["type"] = "wheel") =>
	({ type, wheelDelta, x: 1, y: 1, screenX: 1, screenY: 1, width: 80, height: 24 }) as TuiMouseEvent;

beforeAll(() => {
	initTheme();
});
beforeEach(() => {
	__resetRunLaneRegistry();
});
afterEach(() => {
	vi.restoreAllMocks();
	__resetRunLaneRegistry();
});

describe("LaneConsole — mouse wheel scrolls the lane transcript (#173)", () => {
	it("wheel up leaves the newest tail and is handled; wheel down returns to it", () => {
		longLane();
		const panel = makePanel();
		const tail = view(panel);
		expect(tail).toContain("line-49");

		expect(panel.handleMouse(wheel(-3))).toEqual({ handled: true });
		expect(view(panel)).not.toContain("line-49"); // paused above the tail

		panel.handleMouse(wheel(+3));
		expect(view(panel)).toBe(tail); // back on the tail: follow resumed
		panel.dispose();
	});

	it("ignores non-wheel mouse events (no handled result, no scroll)", () => {
		longLane();
		const panel = makePanel();
		const tail = view(panel);
		expect(panel.handleMouse(wheel(0, "press"))).toBeUndefined();
		expect(view(panel)).toBe(tail);
		panel.dispose();
	});

	it("scrolls the transcript in question focus too", async () => {
		longLane();
		const typed: string[] = [];
		const inner = {
			render: () => ["q0"],
			handleInput: (d: string) => typed.push(d),
			invalidate: vi.fn(),
			dispose: vi.fn(),
		} as unknown as Component;
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: (() => inner) as never,
			options: undefined as never,
			resolve: vi.fn(),
		});
		const panel = makePanel();
		await Promise.resolve(); // the eager question mount settles on a microtask
		panel.handleInput("\r"); // ⏎ arms the question → question focus
		panel.render(80);
		expect(panel.handleMouse(wheel(-3))).toEqual({ handled: true });
		expect(view(panel)).not.toContain("line-49");
		expect(typed).toEqual([]); // nothing reached the questionnaire
		panel.dispose();
	});
});

describe("LaneConsole — u/d page the transcript (#173)", () => {
	it("u pages up exactly like PageUp, d pages back down", () => {
		longLane();
		const viaPageUp = makePanel();
		viaPageUp.handleInput(PAGE_UP);
		const pagedUp = view(viaPageUp);
		viaPageUp.dispose();

		const panel = makePanel();
		const tail = view(panel);
		panel.handleInput("u");
		expect(view(panel)).toBe(pagedUp);
		panel.handleInput("d");
		expect(view(panel)).toBe(tail);
		panel.dispose();
	});

	it("the footer advertises u/d", () => {
		longLane();
		const panel = makePanel();
		expect(view(panel)).toContain("u/d scroll");
		panel.dispose();
	});

	it("in question focus u/d are typed into the question, not scrolled", async () => {
		longLane();
		const typed: string[] = [];
		const inner = {
			render: () => ["q0"],
			handleInput: (d: string) => typed.push(d),
			invalidate: vi.fn(),
			dispose: vi.fn(),
		} as unknown as Component;
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: (() => inner) as never,
			options: undefined as never,
			resolve: vi.fn(),
		});
		const panel = makePanel();
		await Promise.resolve();
		panel.handleInput("\r");
		const armed = view(panel);
		panel.handleInput("u");
		panel.handleInput("d");
		expect(typed).toEqual(["u", "d"]);
		expect(view(panel)).toBe(armed);
		panel.dispose();
	});
});

describe("LaneConsole in Pi's fullscreen TUI — the wheel reaches the lane, not the parent (#173)", () => {
	/** A headless terminal for TuiAltScreen: fixed size, input fed through the captured callback. */
	function headlessTerminal(rows: number, columns: number): { terminal: Terminal; send: (data: string) => void } {
		let onInput: (data: string) => void = () => {};
		const terminal = new Proxy({} as Terminal, {
			get: (_t, key) => {
				if (key === "columns") return columns;
				if (key === "rows") return rows;
				if (key === "kittyProtocolActive") return false;
				if (key === "start") return (input: (data: string) => void) => (onInput = input);
				if (key === "drainInput") return async () => {};
				return () => {};
			},
		});
		return { terminal, send: (data) => onInput(data) };
	}

	it("a wheel over /lanes scrolls the lane transcript; over the transcript it scrolls the parent", async () => {
		longLane();
		const { terminal, send } = headlessTerminal(30, 80);
		const screen = new TuiAltScreen(terminal, false);
		const parent = new Container();
		for (let i = 0; i < 100; i++) parent.addChild(new Text(`parent ${i}`));
		const panel = new LaneConsole(
			"run-1",
			SINGLE_UNIT_KEY,
			makeTui(20),
			identityTheme,
			{} as never,
			vi.fn(),
			vi.fn(),
		);
		const editor = new Container();
		editor.addChild(panel);
		// Pi's fullscreen layout (createChatViewport): the primary transcript scroll view above a
		// dock holding the editor slot, where a non-overlay `ui.custom` (this browser) mounts.
		const transcript = new ScrollView(parent, { follow: "end", primary: true, overscroll: "chain" });
		const dock = new VStack([
			{ component: editor, shrink: 1, minSize: 3 },
			{ component: new Text("footer"), shrink: 1, minSize: 0 },
		]);
		screen.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]),
		);
		screen.start();
		screen.setFocus(panel);
		await new Promise((r) => setTimeout(r, 30)); // first frame lays the boxes out

		const parentTop = transcript.scrollTop;
		const laneTail = view(panel);
		send("\x1b[<64;10;15M"); // SGR wheel-up at row 15 → over the lane browser (dock rows 10–27)
		expect(transcript.scrollTop).toBe(parentTop); // the parent did not move
		expect(view(panel)).not.toBe(laneTail); // the lane transcript did

		send("\x1b[<64;10;2M"); // wheel-up over the transcript area → the parent scrolls, as before
		expect(transcript.scrollTop).toBeLessThan(parentTop);
		screen.stop();
		panel.dispose();
	});
});
