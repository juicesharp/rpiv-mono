import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LaneManager, type ManagerResult } from "./lane-manager.js";
import {
	__resetRunLaneRegistry,
	enqueueInput,
	evictRun,
	recordRun,
	retireRun,
	setLaneStatus,
} from "./run-lane-registry.js";

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
} as unknown as Theme;

function makeTui(rows = 24) {
	return { requestRender: vi.fn(), terminal: { rows } } as unknown as TUI;
}

const ESC = "\x1b";
const TAB = "\t";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";

function makeManager() {
	const done = vi.fn<(r: ManagerResult) => void>();
	const tui = makeTui();
	const manager = new LaneManager(identityTheme, tui, done);
	return { manager, done, tui };
}

beforeEach(() => {
	__resetRunLaneRegistry();
});
afterEach(() => {
	vi.restoreAllMocks();
	__resetRunLaneRegistry();
});

describe("LaneManager — rendering", () => {
	it("lists the root row at index 0 then a row per lane; every line within width", () => {
		recordRun("run-1", "ship");
		recordRun("run-2", "build");
		const { manager } = makeManager();
		const lines = manager.render(80);
		expect(lines[0]).toContain("Lanes");
		expect(lines[1]).toContain("root");
		expect(lines.join("\n")).toContain("ship");
		expect(lines.join("\n")).toContain("build");
		expect(lines[lines.length - 1]).toContain("⏎ switch");
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
	});

	it("a needs-input lane shows the ⚑ glyph + 'needs input'", () => {
		recordRun("run-1", "ship");
		enqueueInput("run-1", { factory: (() => ({})) as never, options: undefined as never, resolve: () => {} });
		const { manager } = makeManager();
		const out = manager.render(120).join("\n");
		expect(out).toContain("⚑");
		expect(out).toContain("needs input");
	});

	it("renders the distinguishing hex short-id for same-second runs (Phase 7.4)", () => {
		recordRun("2026-06-19_08-14-17-a1b2", "ship");
		recordRun("2026-06-19_08-14-17-c3d4", "vet");
		const { manager } = makeManager();
		const out = manager.render(120).join("\n");
		expect(out).toContain("a1b2");
		expect(out).toContain("c3d4");
	});
});

describe("LaneManager — navigation", () => {
	it("↓ / ↑ move and clamp at both ends (root=0 .. lanes.length)", () => {
		recordRun("run-1", "ship");
		recordRun("run-2", "build");
		const { manager, done } = makeManager();
		// up at root clamps (still root → dismiss on enter)
		manager.handleInput(UP);
		manager.handleInput(ENTER);
		expect(done).toHaveBeenLastCalledWith({ kind: "dismiss" });
		done.mockClear();
		// down to lane 1, down to lane 2, extra down clamps at lane 2
		manager.handleInput(DOWN);
		manager.handleInput(DOWN);
		manager.handleInput(DOWN); // clamp
		manager.handleInput(ENTER);
		expect(done).toHaveBeenLastCalledWith({ kind: "switch", runId: "run-2" });
	});
});

describe("LaneManager — selection resolution", () => {
	it("enter on root resolves dismiss", () => {
		recordRun("run-1", "ship");
		const { manager, done } = makeManager();
		manager.handleInput(ENTER);
		expect(done).toHaveBeenCalledWith({ kind: "dismiss" });
	});

	it("enter on a lane resolves switch with the runId", () => {
		recordRun("run-1", "ship");
		const { manager, done } = makeManager();
		manager.handleInput(DOWN);
		manager.handleInput(ENTER);
		expect(done).toHaveBeenCalledWith({ kind: "switch", runId: "run-1" });
	});

	it("esc resolves dismiss; tab resolves ambient", () => {
		recordRun("run-1", "ship");
		const a = makeManager();
		a.manager.handleInput(ESC);
		expect(a.done).toHaveBeenCalledWith({ kind: "dismiss" });
		const b = makeManager();
		b.manager.handleInput(TAB);
		expect(b.done).toHaveBeenCalledWith({ kind: "ambient" });
	});
});

describe("LaneManager — cancel / remove (Phase D)", () => {
	const X = "x";

	it("footer advertises the x affordance", () => {
		recordRun("run-1", "ship");
		const { manager } = makeManager();
		expect(manager.render(120)[manager.render(120).length - 1]).toContain("x stop");
	});

	it("x on a running lane resolves cancel with the runId", () => {
		recordRun("run-1", "ship");
		const { manager, done } = makeManager();
		manager.handleInput(DOWN);
		manager.handleInput(X);
		expect(done).toHaveBeenCalledWith({ kind: "cancel", runId: "run-1" });
	});

	it("x on a finished (retained) lane resolves remove with the runId", () => {
		recordRun("run-1", "ship");
		retireRun("run-1", "completed");
		const { manager, done } = makeManager();
		manager.handleInput(DOWN);
		manager.handleInput(X);
		expect(done).toHaveBeenCalledWith({ kind: "remove", runId: "run-1" });
	});

	it("x on the root row is a no-op", () => {
		recordRun("run-1", "ship");
		const { manager, done } = makeManager();
		manager.handleInput(X); // selectedIndex 0 = root
		expect(done).not.toHaveBeenCalled();
	});
});

describe("LaneManager — live registry sync", () => {
	it("a shrinking list clamps selectedIndex so enter cannot switch out of range", () => {
		recordRun("run-1", "ship");
		recordRun("run-2", "build");
		const { manager, done } = makeManager();
		manager.handleInput(DOWN);
		manager.handleInput(DOWN); // selected = lane 2 (run-2)
		evictRun("run-2"); // registry notify → list shrinks, index clamps to 1
		manager.handleInput(ENTER);
		// clamped selection now points at the surviving lane (run-1), never out of range
		expect(done).toHaveBeenCalledWith({ kind: "switch", runId: "run-1" });
	});

	it("a status change repaints (requestRender called via the registry subscription)", () => {
		recordRun("run-1", "ship");
		const { manager, tui } = makeManager();
		(tui.requestRender as ReturnType<typeof vi.fn>).mockClear();
		setLaneStatus("run-1", "completed");
		expect(tui.requestRender).toHaveBeenCalled();
		void manager;
	});
});

describe("LaneManager — dispose", () => {
	it("dispose unsubscribes from the registry (later mutations do not repaint)", () => {
		recordRun("run-1", "ship");
		const { manager, tui } = makeManager();
		manager.dispose();
		(tui.requestRender as ReturnType<typeof vi.fn>).mockClear();
		setLaneStatus("run-1", "completed");
		expect(tui.requestRender).not.toHaveBeenCalled();
	});
});
