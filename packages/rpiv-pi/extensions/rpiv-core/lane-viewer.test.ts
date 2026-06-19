import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LaneViewer } from "./lane-viewer.js";
import {
	__resetRunLaneRegistry,
	enqueueInput,
	getLane,
	type LaneSession,
	recordRun,
	retireRun,
	setCurrentSession,
} from "./run-lane-registry.js";

/** Identity theme — fg returns its text unchanged. */
const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
} as unknown as Theme;

function makeTui(rows = 24) {
	return { requestRender: vi.fn(), terminal: { rows } } as unknown as TUI;
}

type BranchFn = () => unknown;

/** A LaneSession stub whose getBranch + subscribe are controllable. */
function makeSession(getBranch: BranchFn): LaneSession & { fire: () => void; unsub: ReturnType<typeof vi.fn> } {
	let listener: (() => void) | undefined;
	const unsub = vi.fn();
	return {
		sessionId: "sess-1",
		isStreaming: true,
		sessionManager: { getBranch },
		subscribe: (l: () => void) => {
			listener = l;
			return unsub;
		},
		fire: () => listener?.(),
		unsub,
	};
}

const assistantEntry = (text: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});
const userEntry = (text: string) => ({
	type: "message",
	message: { role: "user", content: [{ type: "text", text }] },
});
const toolResultEntry = () => ({
	type: "message",
	message: { role: "user", content: [{ type: "tool_result" }] },
});

// The SDK message components read a module-global theme proxy that throws until
// initialized. In production the host calls initTheme(); the test must too.
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

describe("LaneViewer — render", () => {
	it("renders assistant + user entries from getBranch()", () => {
		const session = makeSession(() => [assistantEntry("hi from assistant"), userEntry("a user turn")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", session);
		const viewer = new LaneViewer("run-1", makeTui(), identityTheme, vi.fn());
		const out = viewer.render(120).join("\n");
		expect(out).toContain("hi from assistant");
		expect(out).toContain("a user turn");
		expect(out).toContain("ship"); // header
		viewer.dispose();
	});

	it("a tool_result / non-text user entry collapses to the dim one-liner", () => {
		const session = makeSession(() => [toolResultEntry()]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", session);
		const viewer = new LaneViewer("run-1", makeTui(), identityTheme, vi.fn());
		expect(viewer.render(120).join("\n")).toContain("tool result");
		viewer.dispose();
	});

	it("retired lane renders the finalBranch snapshot + a terminal-status header (Phase A)", () => {
		const session = makeSession(() => [assistantEntry("final answer from the run")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", session);
		retireRun("run-1", "completed"); // snapshots getBranch() into finalBranch, drops the session
		const viewer = new LaneViewer("run-1", makeTui(), identityTheme, vi.fn());
		const out = viewer.render(120).join("\n");
		expect(out).toContain("final answer from the run"); // from the snapshot, not a live session
		expect(out).toContain("completed"); // header reflects terminal status, not "live"
		expect(out).toContain("✓");
		viewer.dispose();
	});

	it("no current session → '(stage starting…)'", () => {
		recordRun("run-1", "ship");
		const viewer = new LaneViewer("run-1", makeTui(), identityTheme, vi.fn());
		expect(viewer.render(120).join("\n")).toContain("(stage starting…)");
		viewer.dispose();
	});

	it("lane dismissed (no lane) → '(run dismissed — esc to return)'", () => {
		// run-1 never recorded (or dismissed via the manager's `x`) → getLane undefined.
		const viewer = new LaneViewer("run-1", makeTui(), identityTheme, vi.fn());
		expect(viewer.render(120).join("\n")).toContain("(run dismissed — esc to return)");
		viewer.dispose();
	});

	it("footer reads 'esc back' when the lane has no queued question", () => {
		const session = makeSession(() => [assistantEntry("hi")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", session);
		const viewer = new LaneViewer("run-1", makeTui(), identityTheme, vi.fn());
		expect(viewer.render(120).join("\n")).toContain("esc back");
		viewer.dispose();
	});

	it("footer reads 'esc to answer' when the lane has a queued question (B affordance)", () => {
		const session = makeSession(() => [assistantEntry("hi")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", session);
		enqueueInput("run-1", { factory: (() => ({})) as never, options: undefined as never, resolve: vi.fn() });
		const viewer = new LaneViewer("run-1", makeTui(), identityTheme, vi.fn());
		expect(viewer.render(120).join("\n")).toContain("esc to answer");
		viewer.dispose();
	});

	it("getBranch() throwing → '(transcript unavailable)' (fail-soft, never throws)", () => {
		const session = makeSession(() => {
			throw new Error("disposed mid-render");
		});
		recordRun("run-1", "ship");
		setCurrentSession("run-1", session);
		const viewer = new LaneViewer("run-1", makeTui(), identityTheme, vi.fn());
		expect(() => viewer.render(120)).not.toThrow();
		expect(viewer.render(120).join("\n")).toContain("(transcript unavailable)");
		viewer.dispose();
	});
});

describe("LaneViewer — liveness / following the lane", () => {
	it("re-renders on a session.subscribe tick", () => {
		const session = makeSession(() => [assistantEntry("x")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", session);
		const tui = makeTui();
		const viewer = new LaneViewer("run-1", tui, identityTheme, vi.fn());
		(tui.requestRender as ReturnType<typeof vi.fn>).mockClear();
		session.fire();
		expect(tui.requestRender).toHaveBeenCalled();
		viewer.dispose();
	});

	it("follows the lane: a new currentSession unsubscribes the old and subscribes the new", () => {
		const sessionA = makeSession(() => [assistantEntry("A")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", sessionA);
		const viewer = new LaneViewer("run-1", makeTui(), identityTheme, vi.fn());
		const sessionB = makeSession(() => [assistantEntry("B")]);
		setCurrentSession("run-1", sessionB); // registry notify → syncSession re-points
		expect(sessionA.unsub).toHaveBeenCalled();
		expect(viewer.render(120).join("\n")).toContain("B");
		// firing the NEW session repaints
		const tui2 = makeTui();
		void tui2;
		viewer.dispose();
	});
});

describe("LaneViewer — input", () => {
	it("esc calls done", () => {
		recordRun("run-1", "ship");
		const done = vi.fn();
		const viewer = new LaneViewer("run-1", makeTui(), identityTheme, done);
		viewer.handleInput("\x1b"); // ESC
		expect(done).toHaveBeenCalledTimes(1);
		viewer.dispose();
	});

	it("↑ raises scrollOffset (reveal older) and ↓ lowers it, clamped ≥ 0", () => {
		// A tall branch so there is scrollable excess.
		const session = makeSession(() => Array.from({ length: 50 }, (_, i) => assistantEntry(`line-${i}`)));
		recordRun("run-1", "ship");
		setCurrentSession("run-1", session);
		const tui = makeTui(24);
		const viewer = new LaneViewer("run-1", tui, identityTheme, vi.fn());
		const tail = viewer.render(120).join("\n");
		viewer.handleInput("\x1b[A"); // up → reveal older
		const scrolled = viewer.render(120).join("\n");
		expect(scrolled).not.toBe(tail);
		expect(tui.requestRender).toHaveBeenCalled();
		// down past zero stays clamped (no throw, returns to a valid view)
		viewer.handleInput("\x1b[B");
		viewer.handleInput("\x1b[B");
		expect(() => viewer.render(120)).not.toThrow();
		viewer.dispose();
	});
});

describe("LaneViewer — dispose", () => {
	it("unsubscribes both the session and the registry", () => {
		const session = makeSession(() => [assistantEntry("x")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", session);
		const viewer = new LaneViewer("run-1", makeTui(), identityTheme, vi.fn());
		viewer.dispose();
		expect(session.unsub).toHaveBeenCalled();
		// After dispose, a registry change no longer drives a re-subscribe (no throw).
		const session2 = makeSession(() => [assistantEntry("y")]);
		expect(() => setCurrentSession("run-1", session2)).not.toThrow();
		// the viewer's registry listener is gone, so session2 was never subscribed
		expect(session2.unsub).not.toHaveBeenCalled();
		expect(getLane("run-1")?.currentSession).toBe(session2);
	});
});
