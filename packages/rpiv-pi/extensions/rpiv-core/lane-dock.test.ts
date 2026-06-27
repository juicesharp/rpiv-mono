import { type ExtensionUIContext, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createMockUI } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LaneDock } from "./lane-dock.js";
import type { ViewerMessage } from "./lane-transcript.js";
import {
	__resetRunLaneRegistry,
	captureFinalSnapshot,
	dequeueInput,
	enqueueInput,
	evictRun,
	getDockState,
	type LaneSession,
	markUnitDone,
	recordRun,
	retireRun,
	SINGLE_UNIT_KEY,
	setCurrentSession,
	setDockActive,
	setDockSelection,
	setLaneProgress,
	setLaneStatus,
	setUnitStarted,
} from "./run-lane-registry.js";

const WIDGET_KEY = "rpiv-lanes";

/** Identity theme — fg returns its text unchanged so render assertions read plainly. */
const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
} as unknown as Theme;

type WidgetFactory = (
	tui: { requestRender: () => void },
	theme: Theme,
) => { render: (w: number) => string[]; invalidate: () => void };

function makeCtx() {
	return createMockUI() as unknown as ExtensionUIContext;
}

/** Mount the overlay, invoke the captured setWidget factory, return the live widget + the tui spy. */
function mount(overlay: LaneDock, ui: ExtensionUIContext) {
	overlay.setUICtx(ui);
	overlay.update();
	const setWidget = ui.setWidget as unknown as ReturnType<typeof vi.fn>;
	const factory = setWidget.mock.calls[0]?.[1] as WidgetFactory | undefined;
	if (!factory) return { setWidget, widget: undefined, tui: undefined };
	const tui = { requestRender: vi.fn() };
	const widget = factory(tui, identityTheme);
	return { setWidget, widget, tui };
}

beforeAll(() => {
	initTheme(); // SDK message components (renderBranch in the preview) read a global theme proxy
});

function makeSession(getBranch: () => unknown = () => []): LaneSession & {
	unsub: ReturnType<typeof vi.fn>;
	setStreaming: (m: ViewerMessage | undefined) => void;
	setUsage: (stats: Record<string, unknown> | undefined) => void;
} {
	let streaming: ViewerMessage | undefined;
	let usage: Record<string, unknown> | undefined;
	const unsub = vi.fn();
	return {
		sessionId: "sess",
		isStreaming: true,
		sessionManager: { getBranch, getCwd: () => "/tmp" },
		getToolDefinition: () => undefined,
		getStreamingMessage: () => streaming,
		getUsage: () => usage,
		subscribe: vi.fn(() => unsub),
		unsub,
		setStreaming: (m) => {
			streaming = m;
		},
		setUsage: (u) => {
			usage = u;
		},
	};
}

/** A SessionStats-shaped object (agent-session.d.ts:135-153) that Phase 1's toLaneUsage
 *  narrows into a LaneUsage — tokens.{input,output,cacheRead,cacheWrite} + recomputed
 *  total. Drives a unit's finalUsage through the real captureFinalSnapshot path. */
function sessionStats(tokens: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}): Record<string, unknown> {
	return {
		tokens: {
			...tokens,
			total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
		},
	};
}

beforeEach(() => {
	__resetRunLaneRegistry();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	__resetRunLaneRegistry();
});

describe("LaneDock — lifecycle / auto-show-hide", () => {
	it("update() with no UI ctx bound is a no-op", () => {
		const overlay = new LaneDock();
		expect(() => overlay.update()).not.toThrow();
		overlay.dispose();
	});

	it("update() with no lanes registers no widget", () => {
		const overlay = new LaneDock();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		expect(ui.setWidget as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
		overlay.dispose();
	});

	it("first lane registers the widget exactly once via setWidget(KEY, factory, {belowEditor})", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as unknown as ReturnType<typeof vi.fn>;
		expect(setWidget).toHaveBeenCalledTimes(1);
		expect(setWidget.mock.calls[0][0]).toBe(WIDGET_KEY);
		expect(typeof setWidget.mock.calls[0][1]).toBe("function");
		expect(setWidget.mock.calls[0][2]).toEqual({ placement: "belowEditor" });
		overlay.dispose();
	});

	it("second update after registration calls tui.requestRender instead of re-registering", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const ui = makeCtx();
		const { setWidget, tui } = mount(overlay, ui);
		overlay.update();
		expect(setWidget).toHaveBeenCalledTimes(1);
		expect(tui?.requestRender).toHaveBeenCalled();
		overlay.dispose();
	});

	it("dropping to zero lanes unregisters the widget (auto-hide)", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const ui = makeCtx();
		mount(overlay, ui);
		__resetRunLaneRegistry();
		overlay.update();
		const setWidget = ui.setWidget as unknown as ReturnType<typeof vi.fn>;
		expect(setWidget).toHaveBeenCalledTimes(2);
		expect(setWidget.mock.calls[1]).toEqual([WIDGET_KEY, undefined]);
		overlay.dispose();
	});

	it("setUICtx(same ctx) is idempotent; a new ctx re-registers", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const ui1 = makeCtx();
		overlay.setUICtx(ui1);
		overlay.update();
		overlay.setUICtx(ui1);
		overlay.update();
		expect(ui1.setWidget as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
		const ui2 = makeCtx();
		overlay.setUICtx(ui2);
		overlay.update();
		expect(ui2.setWidget as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
		overlay.dispose();
	});
});

describe("LaneDock — forced redraw on height-shape change (duplicate-block fix)", () => {
	// pi-tui's differential renderer paints a GROWN frame below the shorter previous one when a
	// belowEditor widget changes height mid-frame, leaving a stale duplicate block. The dock
	// forces a full redraw (requestRender(true)) only when its row shape changes — spinner/
	// progress ticks that keep the shape stay cheap differential renders (requestRender(false)).
	it("a stable-shape progress tick does NOT force a full redraw", () => {
		recordRun("run-1", "ship");
		setUnitStarted("run-1", 0, "u0");
		setUnitStarted("run-1", 1, "u1");
		const overlay = new LaneDock();
		const { tui } = mount(overlay, makeCtx());
		setLaneProgress("run-1", { stageNumber: 4, totalStages: 15, stageName: "design", phase: "running" });
		overlay.update();
		expect(tui?.requestRender).toHaveBeenLastCalledWith(false);
		overlay.dispose();
	});

	it("adding a fan-out unit sub-row forces a full redraw", () => {
		recordRun("run-1", "ship");
		setUnitStarted("run-1", 0, "u0");
		const overlay = new LaneDock();
		const { tui } = mount(overlay, makeCtx());
		setUnitStarted("run-1", 1, "u1"); // +1 display row → the dock grows mid-frame
		overlay.update();
		expect(tui?.requestRender).toHaveBeenLastCalledWith(true);
		overlay.dispose();
	});

	it("removing fan-out unit sub-rows forces a full redraw", () => {
		recordRun("run-1", "ship");
		setUnitStarted("run-1", 0, "u0");
		setUnitStarted("run-1", 1, "u1");
		const overlay = new LaneDock();
		const { tui } = mount(overlay, makeCtx());
		// A new fan-out generation drops the prior stage's sub-rows (shrink is the same artifact class).
		__resetRunLaneRegistry();
		recordRun("run-1", "ship");
		overlay.update();
		expect(tui?.requestRender).toHaveBeenLastCalledWith(true);
		overlay.dispose();
	});

	it("stepping in and moving the active selection both force a full redraw", () => {
		recordRun("run-1", "ship");
		recordRun("run-2", "build");
		const overlay = new LaneDock();
		const { tui } = mount(overlay, makeCtx());
		const spy = tui?.requestRender as unknown as ReturnType<typeof vi.fn>;
		setDockActive(true); // ambient → active: the preview region + top rule appear (height step)
		overlay.update();
		expect(spy).toHaveBeenLastCalledWith(true);
		spy.mockClear();
		setDockSelection(1); // active selection moves → the preview re-targets another lane's tail
		overlay.update();
		expect(spy).toHaveBeenLastCalledWith(true);
		overlay.dispose();
	});
});

describe("LaneDock — rendering", () => {
	it("renders a heading + a row per lane, every line within width", () => {
		recordRun("run-1", "ship");
		recordRun("run-2", "build");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const lines = widget?.render(80) ?? [];
		expect(lines[0]).toBe(""); // leading blank (rhythm); no top rule — editor border is the top boundary
		expect(lines[1]).toContain("Runs (2 active)"); // title
		expect(lines[lines.length - 1]).toBe("─".repeat(80)); // bottom rule
		expect(lines.join("\n")).toContain("ship");
		expect(lines.join("\n")).toContain("build");
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
		overlay.dispose();
	});

	it("renders the title as a selectedBg chip (ask_user_question header style), not tightly truncated", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as unknown as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0]?.[1] as WidgetFactory;
		// bg-encoding theme makes the chip observable: bg(color, text) → "[color]text".
		const bgTheme = {
			fg: (_c: string, s: string) => s,
			bg: (c: string, s: string) => `[${c}]${s}`,
			bold: (s: string) => s,
			strikethrough: (s: string) => s,
		} as unknown as Theme;
		const widget = factory({ requestRender: vi.fn() }, bgTheme);
		const title = widget.render(120)[1] ?? "";
		// Same as ask_user_question's header badge: a selectedBg block with one space of
		// padding on each side around the full title text.
		expect(title).toContain("[selectedBg] Runs (1 active) ");
		overlay.dispose();
	});

	it("running lanes read 'streaming…'; terminal lanes show their raw status", () => {
		recordRun("run-1", "ship");
		recordRun("run-2", "build");
		setLaneStatus("run-2", "completed");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("streaming…");
		expect(out).toContain("completed");
		overlay.dispose();
	});

	it("heading flips to the accent ● when any lane needs input", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		expect(widget?.render(120)[0]).not.toContain("●");
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: (() => ({})) as never,
			options: undefined as never,
			resolve: () => {},
		});
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("●");
		expect(out).toContain("needs input");
		overlay.dispose();
	});

	it("aging heading: shouts the needs-input count and a relative age (Phase C)", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: (() => ({})) as never,
			options: undefined as never,
			resolve: () => {},
		});
		const heading = (widget?.render(120) ?? [])[1] ?? ""; // [0] is the top rule
		expect(heading).toMatch(/1 run needs input · \d+s/);
	});

	it("aging heading: pluralizes when multiple lanes need input (Phase C)", () => {
		recordRun("run-1", "ship");
		recordRun("run-2", "vet");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const pend = { factory: (() => ({})) as never, options: undefined as never, resolve: () => {} };
		enqueueInput("run-1", SINGLE_UNIT_KEY, pend);
		enqueueInput("run-2", SINGLE_UNIT_KEY, pend);
		expect((widget?.render(120) ?? [])[1]).toContain("2 runs need input"); // [0] is the top rule
	});

	it("needs-input lane is never hidden below the '+N more' fold (Phase B priority sort)", () => {
		// 12 lanes (> the 11-row budget) → collapse; the LAST-launched one needs input.
		for (let i = 0; i < 12; i++) recordRun(`run-${i}`, `lane${i}`);
		enqueueInput("run-11", SINGLE_UNIT_KEY, {
			factory: (() => ({})) as never,
			options: undefined as never,
			resolve: () => {},
		});
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(200) ?? []).join("\n");
		expect(out).toContain("+"); // collapse line present
		expect(out).toContain("more");
		expect(out).toContain("lane11"); // the needs-input lane sorted above the fold
		expect(out).toContain("⚑");
		overlay.dispose();
	});

	it("renders the workflow tag + truncated prompt as the descriptor (no --name)", () => {
		recordRun("run-1", "ship", { workflow: "ship", input: "refactor the auth module end to end" });
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("ship:"); // workflow tag with colon
		expect(out).toContain("refactor"); // truncated prompt descriptor
		overlay.dispose();
	});

	it("renders the --name alias as the descriptor when provided (alias wins over prompt)", () => {
		recordRun("run-1", "authfix", { workflow: "ship", input: "ignored when alias set" });
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("ship:"); // tag
		expect(out).toContain("authfix"); // alias descriptor
		expect(out).not.toContain("ignored when alias set"); // alias wins
		overlay.dispose();
	});

	it("renders the bare workflow name (no tag colon) when there is no --name and no input", () => {
		recordRun("run-1", "ship", { workflow: "ship" });
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("ship");
		expect(out).not.toContain("ship:"); // no colon — no descriptor follows
		overlay.dispose();
	});

	it("beyond MAX_WIDGET_LINES budget the last lane row is '+N more' (footer below it)", () => {
		// budget = MAX_WIDGET_LINES (12) - 1 heading = 11 rows; exceed it.
		for (let i = 0; i < 20; i++) recordRun(`run-${i}`, `wf-${i}`);
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const lines = widget?.render(120) ?? [];
		// Bottom rule last; no top rule (editor border is the top boundary).
		expect(lines[lines.length - 1]).toBe("─".repeat(120));
		expect(lines[0]).toBe(""); // leading blank, not a rule
		// The "+N more" summary is the last LANE row; the footer sits below it.
		const moreIdx = lines.findIndex((l) => l.includes("more") && l.includes("+"));
		const footerIdx = lines.findIndex((l) => l.includes("/lanes"));
		expect(moreIdx).toBeGreaterThan(0);
		expect(footerIdx).toBeGreaterThan(moreIdx);
		overlay.dispose();
	});

	it("bounds the dock with a single bottom rule; the footer sits directly above it (ask_user_question rhythm)", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const lines = widget?.render(120) ?? [];
		// No top rule (the editor border above is the top boundary); a single bottom rule.
		expect(lines[0]).toBe(""); // leading blank for breathing room under the editor border
		expect(lines[1]).toContain("Runs"); // title directly after the leading blank
		expect(lines[lines.length - 1]).toBe("─".repeat(120)); // bottom rule
		const footerIdx = lines.findIndex((l) => l.includes("/lanes"));
		expect(footerIdx).toBeGreaterThan(0);
		// A blank line precedes the footer (rhythm); the bottom rule follows it.
		expect(lines[footerIdx - 1]).toBe("");
		expect(lines[footerIdx + 1]).toBe("─".repeat(120));
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(120);
		overlay.dispose();
	});

	it("the ambient footer advertises step-in / lanes only — never the ^Q hotkey glyph", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const lines = widget?.render(120) ?? [];
		const footerIdx = lines.findIndex((l) => l.includes("/lanes"));
		expect(lines[footerIdx]).toContain("step in");
		expect(lines[footerIdx]).not.toContain("^Q");
		overlay.dispose();
	});
});

describe("LaneDock — live stage progress (Phase 8)", () => {
	it("a lane with progress renders N/total + stageName instead of 'streaming…'", () => {
		recordRun("run-1", "ship");
		setLaneProgress("run-1", { stageNumber: 3, totalStages: 7, stageName: "plan-layers", phase: "running" });
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("3/7");
		expect(out).toContain("plan-layers");
		expect(out).not.toContain("streaming…");
		overlay.dispose();
	});

	it("a retry shows the retry attempt; a fanout stage shows units x/y", () => {
		recordRun("run-1", "ship");
		setLaneProgress("run-1", { stageNumber: 2, totalStages: 7, stageName: "vet", phase: "retry", attempt: 2 });
		recordRun("run-2", "build");
		setLaneProgress("run-2", {
			stageNumber: 5,
			totalStages: 7,
			stageName: "synthesize",
			phase: "running",
			units: { done: 2, total: 4 },
		});
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("retry 2");
		expect(out).toContain("units 2/4");
		overlay.dispose();
	});

	it("the fraction is distinct-visited/total; a re-entered (looped) stage shows a ↻lap marker, not 'N of fewer'", () => {
		// Cyclic walk: 7th activation in a 4-stage graph, only 3 distinct nodes visited.
		recordRun("run-1", "ship");
		setLaneProgress("run-1", {
			stageNumber: 7,
			totalStages: 4,
			visited: 3,
			stageName: "implement",
			phase: "running",
		});
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("3/4"); // fraction never inverts — visited ≤ total
		expect(out).not.toContain("7/4"); // the old misleading ordinal/graph fraction is gone
		expect(out).toContain("↻7"); // path ordinal surfaced as a lap marker
		overlay.dispose();
	});

	it("an acyclic walk (ordinal == visited) shows a clean fraction with no lap marker", () => {
		recordRun("run-1", "ship");
		setLaneProgress("run-1", {
			stageNumber: 3,
			totalStages: 4,
			visited: 3,
			stageName: "implement",
			phase: "running",
		});
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("3/4");
		expect(out).not.toContain("↻"); // no re-entry → no lap noise
		overlay.dispose();
	});

	it("needs-input still wins the trailing label over live progress", () => {
		recordRun("run-1", "ship");
		setLaneProgress("run-1", { stageNumber: 3, totalStages: 7, stageName: "plan-layers", phase: "running" });
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: (() => ({})) as never,
			options: undefined as never,
			resolve: () => {},
		});
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("needs input");
		expect(out).not.toContain("plan-layers");
		overlay.dispose();
	});

	it("aligns the status column across rows despite differing name, id, and stage counts", () => {
		// Differing NAME lengths (fixed NAME_COL) AND differing totalStages (fixed-width
		// bar) must not shift the N/total column — a 6-stage and a 5-stage run align.
		recordRun("r-1", "x");
		recordRun("r-2", "a-very-long-workflow-name");
		setLaneProgress("r-1", { stageNumber: 1, totalStages: 6, stageName: "plan", phase: "running" });
		setLaneProgress("r-2", { stageNumber: 1, totalStages: 5, stageName: "build", phase: "running" });
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		// Strip ANSI: truncateToWidth injects reset codes into the truncated long name,
		// which would skew a raw indexOf — the ON-SCREEN column is what must align.
		const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, "");
		const rows = (widget?.render(120) ?? []).map(stripAnsi).filter((l) => l.includes("▰"));
		expect(rows.length).toBe(2);
		// Both the bar AND the N/total counter must start at the same on-screen column.
		expect(rows[0].indexOf("▰")).toBe(rows[1].indexOf("▰"));
		expect(rows[0].indexOf("1/6")).toBe(rows[1].indexOf("1/5"));
		overlay.dispose();
	});

	it("drops the bar first under narrow width; every line stays within width", () => {
		recordRun("run-1", "polish");
		setLaneProgress("run-1", { stageNumber: 3, totalStages: 7, stageName: "plan-layers", phase: "running" });
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const narrow = widget?.render(36) ?? [];
		// Measure DISPLAY width: truncateToWidth injects ANSI reset codes at the cut,
		// so raw string length overcounts — visibleWidth is the on-screen column count.
		for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(36);
		// The bar (▰/▱) is dropped first so the N/total label survives the squeeze.
		const out = narrow.join("\n");
		expect(out).not.toContain("▰");
		expect(out).toContain("3/7");
		overlay.dispose();
	});
});

describe("LaneDock — failure reason chip (Problem 1)", () => {
	it("a failed (error-phase) row appends the reason after the stage name, with the ✗ glyph", () => {
		recordRun("run-1", "ship");
		setLaneProgress("run-1", {
			stageNumber: 2,
			totalStages: 4,
			stageName: "blueprint",
			phase: "error",
			reason: "no plan artifact",
		});
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("✗"); // error-phase glyph
		expect(out).toContain("blueprint"); // stage name
		expect(out).toContain("no plan artifact"); // the cause chip
		expect(out).toContain("▰"); // wide enough → bar AND reason both shown
		overlay.dispose();
	});

	it("drops the bar before the reason under width pressure (reason > bar)", () => {
		recordRun("run-1", "polish");
		setLaneProgress("run-1", {
			stageNumber: 3,
			totalStages: 7,
			stageName: "plan",
			phase: "error",
			reason: "boom",
		});
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const narrow = widget?.render(40) ?? [];
		for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		const out = narrow.join("\n");
		expect(out).not.toContain("▰"); // bar sacrificed first
		expect(out).toContain("3/7"); // the signal survives
		expect(out).toContain("boom"); // the reason survives the squeeze
		overlay.dispose();
	});

	it("a retired failed lane surfaces termination.error from lane.error", () => {
		recordRun("run-1", "ship");
		setLaneProgress("run-1", { stageNumber: 2, totalStages: 4, stageName: "blueprint", phase: "error" });
		retireRun("run-1", "failed", "disk write failed — out of space");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("disk write failed"); // the trimmed leading clause
		expect(out).not.toContain("out of space"); // elaboration dropped at the ` — ` cut
		overlay.dispose();
	});
});

describe("LaneDock — spinner animation", () => {
	it("a running lane renders a spinner glyph; advancing the timer cycles the frame + requests render", () => {
		vi.useFakeTimers();
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const { widget, tui } = mount(overlay, makeCtx());
		// The spinner lives on the RUN ROW now (the title is a static label, no progress).
		const rowOf = (r: string[] | undefined) => (r ?? []).find((l) => l.includes("ship")) ?? "";
		const frame0 = rowOf(widget?.render(120));
		// rpiv-warp's ambient-activity braille indicator (title-spinner.ts SPINNER_FRAMES).
		const SPINNER_FRAMES = ["⠴", "⠦", "⠖", "⠲"];
		expect(SPINNER_FRAMES.some((g) => frame0.includes(g))).toBe(true);
		// Drive the interval → frame advances and the widget repaints.
		vi.advanceTimersByTime(160);
		expect(tui?.requestRender).toHaveBeenCalled();
		const frame1 = rowOf(widget?.render(120));
		expect(frame1).not.toBe(frame0);
		overlay.dispose();
	});

	it("the spin timer exists only while ≥1 lane is running and clears when none are", () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		mount(overlay, makeCtx());
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		// Move the only lane to a terminal status → next update clears the timer.
		setLaneStatus("run-1", "completed");
		overlay.update();
		expect(clearIntervalSpy).toHaveBeenCalled();
		overlay.dispose();
	});

	it("an all-completed lane set spins no timer", () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		recordRun("run-1", "ship");
		setLaneStatus("run-1", "completed");
		const overlay = new LaneDock();
		mount(overlay, makeCtx());
		expect(setIntervalSpy).not.toHaveBeenCalled();
		overlay.dispose();
	});

	it("dispose clears the spin timer (no requestRender after dispose)", () => {
		vi.useFakeTimers();
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const { tui } = mount(overlay, makeCtx());
		overlay.dispose();
		(tui?.requestRender as ReturnType<typeof vi.fn>)?.mockClear();
		vi.advanceTimersByTime(600);
		expect(tui?.requestRender).not.toHaveBeenCalled();
	});

	// Phase C — the needs-input heartbeat is INDEPENDENT of the spinner: it must age a
	// stalled run even when nothing is streaming. Synthetic state (a non-running lane that
	// still has queued input) isolates the heartbeat from the spinner timer.
	it("the needs-input heartbeat repaints to age the heading even when no lane is running (Phase C)", () => {
		vi.useFakeTimers();
		recordRun("run-1", "ship");
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: (() => ({})) as never,
			options: undefined as never,
			resolve: () => {},
		});
		setLaneStatus("run-1", "completed"); // not "running" → spinner timer stays off
		const overlay = new LaneDock();
		const { tui } = mount(overlay, makeCtx());
		(tui?.requestRender as ReturnType<typeof vi.fn>)?.mockClear();
		vi.advanceTimersByTime(10_000); // NEEDS_INPUT_TICK_MS
		expect(tui?.requestRender).toHaveBeenCalled();
		overlay.dispose();
	});

	it("the heartbeat clears when the queue drains (no repaint after)", () => {
		vi.useFakeTimers();
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		recordRun("run-1", "ship");
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: (() => ({})) as never,
			options: undefined as never,
			resolve: () => {},
		});
		setLaneStatus("run-1", "completed");
		const overlay = new LaneDock();
		mount(overlay, makeCtx());
		// Drain the queue → next update clears the heartbeat timer.
		dequeueInput("run-1", SINGLE_UNIT_KEY);
		overlay.update();
		expect(clearIntervalSpy).toHaveBeenCalled();
		overlay.dispose();
	});
});

describe("LaneDock — active (focused) state", () => {
	it("ambient state shows no selection cursor and the discoverability footer", () => {
		recordRun("run-1", "ship");
		recordRun("run-2", "build");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).not.toContain("❯");
		expect(out).toContain("/lanes");
		expect(out).toContain("↓ step in"); // DEFAULT_FOOTER_TEXT discoverability wording
		expect(out).not.toContain("transcript"); // no run-action contract in the ambient footer
		overlay.dispose();
	});

	it("active state paints the cursor on the selected row and the navigation footer", () => {
		recordRun("run-1", "ship");
		recordRun("run-2", "build");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		setDockActive(true);
		setDockSelection(1);
		const lines = widget?.render(120) ?? [];
		const out = lines.join("\n");
		// Exactly one row carries the cursor; the footer flips to the nav contract.
		expect(lines.filter((l) => l.includes("❯")).length).toBe(1);
		expect(out).toContain("→ transcript"); // dedicated transcript key (no queued input → no ⏎ answer hint)
		expect(out).not.toContain("/lanes"); // ambient discoverability hint is replaced by the nav footer
		overlay.dispose();
	});

	it("active footer advertises ⏎ answer when the selected lane has a queued question", () => {
		recordRun("run-1", "ship");
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: (() => ({})) as never,
			options: undefined as never,
			resolve: () => {},
		});
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		setDockActive(true);
		setDockSelection(0); // the needs-input lane
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("⏎ answer");
		expect(out).toContain("→ transcript");
		overlay.dispose();
	});

	it("active footer uses unified back wording (←/esc back), not the old 'esc exit'", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		setDockActive(true);
		setDockSelection(0);
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("←/esc back");
		expect(out).not.toContain("esc exit");
		overlay.dispose();
	});

	it("the cursor lands on the row at dockSelection (display order)", () => {
		recordRun("run-1", "ship");
		recordRun("run-2", "build");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		setDockActive(true);
		setDockSelection(0);
		const first = (widget?.render(120) ?? []).find((l) => l.includes("❯")) ?? "";
		expect(first).toContain("ship");
		setDockSelection(1);
		const second = (widget?.render(120) ?? []).find((l) => l.includes("❯")) ?? "";
		expect(second).toContain("build");
		overlay.dispose();
	});

	it("stepping in does NOT shift row content — the selection gutter is reserved in both states", () => {
		recordRun("run-1", "polish");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const ambientRow = (widget?.render(120) ?? []).find((l) => l.includes("polish")) ?? "";
		setDockActive(true);
		setDockSelection(0);
		const activeRow = (widget?.render(120) ?? []).find((l) => l.includes("polish")) ?? "";
		// The cursor appears only when active…
		expect(ambientRow).not.toContain("❯");
		expect(activeRow).toContain("❯");
		// …but the lane name sits at the SAME column in both (no layout jump).
		expect(activeRow.indexOf("polish")).toBe(ambientRow.indexOf("polish"));
		overlay.dispose();
	});

	it("active rows stay within width (the selection gutter never overflows)", () => {
		recordRun("run-1", "a-fairly-long-workflow-name");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		setDockActive(true);
		for (const line of widget?.render(40) ?? []) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		overlay.dispose();
	});

	it("the title is a plain label — no spinner/progress glyph even while a lane runs", () => {
		vi.useFakeTimers();
		recordRun("run-1", "ship"); // running → row spins, but the title must not
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const title = (widget?.render(120) ?? [])[1] ?? "";
		const SPINNER_FRAMES = ["⠴", "⠦", "⠖", "⠲"];
		expect(SPINNER_FRAMES.some((g) => title.includes(g))).toBe(false);
		expect(title).toContain("Runs (1 active)");
		overlay.dispose();
	});

	it("marks the selected row's descriptor with accent+bold and NO background block (ask_user_question style)", () => {
		recordRun("run-1", "ship", { workflow: "ship", input: "refactor auth" });
		recordRun("run-2", "build", { workflow: "build", input: "add tests" });
		const overlay = new LaneDock();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as unknown as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0]?.[1] as WidgetFactory;
		// Encoding theme: fg → "color:text", bold → "*text*", bg → "[color]text" so the
		// selected-row styling (accent+bold descriptor, no background) is observable.
		const encTheme = {
			fg: (c: string, s: string) => `${c}:${s}`,
			bg: (c: string, s: string) => `[${c}]${s}`,
			bold: (s: string) => `*${s}*`,
			strikethrough: (s: string) => s,
		} as unknown as Theme;
		const widget = factory({ requestRender: vi.fn() }, encTheme);
		setDockActive(true);
		setDockSelection(0);
		const lines = widget.render(60);
		// The selected row's descriptor is accent+bold; the unselected row's descriptor is plain "text".
		const selectedRow = lines.find((l) => l.includes("refactor auth")) ?? "";
		const otherRow = lines.find((l) => l.includes("add tests")) ?? "";
		// No background block on the ROWS — ask_user_question marks row selection with text
		// style, not a fill. (bg encodes as "[color]"; the title chip's selectedBg is a
		// separate line and intentionally excluded here.)
		expect(/\[[a-zA-Z]/.test(selectedRow)).toBe(false);
		expect(/\[[a-zA-Z]/.test(otherRow)).toBe(false);
		expect(selectedRow).toContain("accent:*refactor auth*");
		expect(otherRow).toContain("text:add tests");
		expect(otherRow).not.toContain("accent:*add tests*");
		// the workflow tag stays dim on BOTH rows (ask_user_question's always-dim description split)
		expect(selectedRow).toContain("dim:ship");
		expect(otherRow).toContain("dim:build");
		overlay.dispose();
	});

	it("ambient leaves a blank top (editor border is the boundary); active draws its own top rule", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		// Ambient: the editor's bottom border above is the top boundary, so line 0 is a
		// breathing-room blank — NOT a rule.
		const ambient = widget?.render(40) ?? [];
		expect(ambient[0]).toBe("");
		// Active: the editor hides itself, so the dock frames itself — a leading blank, its
		// own top rule, a blank, THEN the title (blank · HR · blank · title). Both ends carry a rule.
		setDockActive(true);
		const focused = widget?.render(40) ?? [];
		expect(focused[0]).toBe(""); // leading blank above the rule
		expect(focused[1]).toBe("─".repeat(40)); // top rule
		expect(focused[2]).toBe(""); // blank between the rule and the title
		expect(focused[3]).toContain("Runs"); // title under the blank
		expect(focused[focused.length - 1]).toBe("─".repeat(40)); // bottom rule still present
		overlay.dispose();
	});

	it("the bottom rule is dim when ambient and accent when focused", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as unknown as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0]?.[1] as WidgetFactory;
		// Color-encoding theme: fg(color, text) → "color:text", so the rule's color is observable.
		const colorTheme = {
			fg: (c: string, s: string) => `${c}:${s}`,
			bg: (_c: string, s: string) => s,
			bold: (s: string) => s,
			strikethrough: (s: string) => s,
		} as unknown as Theme;
		const widget = factory({ requestRender: vi.fn() }, colorTheme);
		const bottomRule = (r: string[]) => r[r.length - 1]; // the last line is the bottom rule
		expect(bottomRule(widget.render(20)).startsWith("dim:─")).toBe(true); // ambient → dim
		setDockActive(true);
		expect(bottomRule(widget.render(20)).startsWith("accent:─")).toBe(true); // focused → accent
		overlay.dispose();
	});

	it("dropping to zero lanes clears an active dock (auto-hide deactivates)", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		mount(overlay, makeCtx());
		setDockActive(true);
		expect(getDockState().active).toBe(true);
		evictRun("run-1"); // last lane gone
		overlay.update(); // lanes == 0 → update() calls setDockActive(false)
		expect(getDockState().active).toBe(false);
		overlay.dispose();
	});
});

describe("LaneDock — preview subscription (Slice 5)", () => {
	it("does not subscribe to any session while ambient (inactive)", () => {
		recordRun("run-1", "ship");
		const session = makeSession();
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const overlay = new LaneDock();
		mount(overlay, makeCtx());
		overlay.update();
		expect(session.subscribe).not.toHaveBeenCalled();
		overlay.dispose();
	});

	it("subscribes to the selected lane's session while active and identity-guards unrelated notifies", () => {
		recordRun("run-1", "ship");
		const session = makeSession();
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const overlay = new LaneDock();
		mount(overlay, makeCtx());
		setDockActive(true);
		setDockSelection(0);
		overlay.update(); // resolve selection → subscribe once
		expect(session.subscribe).toHaveBeenCalledTimes(1);
		// An unrelated registry change must NOT stack a second subscription.
		setLaneProgress("run-1", { stageNumber: 1, totalStages: 3, stageName: "plan", phase: "running" });
		overlay.update();
		expect(session.subscribe).toHaveBeenCalledTimes(1);
		expect(session.unsub).not.toHaveBeenCalled();
		overlay.dispose();
	});

	it("re-points the subscription when the selection moves to another lane", () => {
		recordRun("run-1", "ship");
		recordRun("run-2", "build");
		const s1 = makeSession();
		const s2 = makeSession();
		setCurrentSession("run-1", SINGLE_UNIT_KEY, s1);
		setCurrentSession("run-2", SINGLE_UNIT_KEY, s2);
		const overlay = new LaneDock();
		mount(overlay, makeCtx());
		setDockActive(true);
		setDockSelection(0);
		overlay.update(); // subscribe s1
		expect(s1.subscribe).toHaveBeenCalledTimes(1);
		setDockSelection(1);
		overlay.update(); // move to run-2 → unsub s1, subscribe s2
		expect(s1.unsub).toHaveBeenCalledTimes(1);
		expect(s2.subscribe).toHaveBeenCalledTimes(1);
		overlay.dispose();
	});

	it("dispose tears down the preview subscription", () => {
		recordRun("run-1", "ship");
		const session = makeSession();
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const overlay = new LaneDock();
		mount(overlay, makeCtx());
		setDockActive(true);
		setDockSelection(0);
		overlay.update();
		overlay.dispose();
		expect(session.unsub).toHaveBeenCalledTimes(1);
	});
});

describe("LaneDock — active transcript preview (Slice 6)", () => {
	const assistantEntry = (text: string) => ({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text }] },
	});

	it("ambient (inactive) shows NO preview — no transcript leaks into the ambient dock", () => {
		recordRun("run-1", "ship");
		setCurrentSession(
			"run-1",
			SINGLE_UNIT_KEY,
			makeSession(() => [assistantEntry("PREVIEW_BODY")]),
		);
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		expect((widget?.render(120) ?? []).join("\n")).not.toContain("PREVIEW_BODY");
		overlay.dispose();
	});

	it("active dock renders the selected lane's transcript tail beneath a dim separator rule", () => {
		recordRun("run-1", "ship");
		setCurrentSession(
			"run-1",
			SINGLE_UNIT_KEY,
			makeSession(() => [assistantEntry("PREVIEW_BODY")]),
		);
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		setDockActive(true);
		setDockSelection(0);
		const lines = widget?.render(120) ?? [];
		expect(lines.join("\n")).toContain("PREVIEW_BODY"); // tail of the selected lane
		// Assert the separator by POSITION, not mere presence: the active dock already emits
		// its own top + bottom rules (which under identityTheme also equal "─".repeat(120)), so
		// `lines.some(l => l === rule)` would pass even if the preview rule regressed. Pin the
		// rule to BETWEEN the lane row and the preview body — only the preview separator lives there.
		const rowIdx = lines.findIndex((l) => l.includes("ship")); // the selected lane row
		const bodyIdx = lines.findIndex((l) => l.includes("PREVIEW_BODY")); // the preview tail
		const ruleIdx = lines.findIndex((l, i) => i > rowIdx && i < bodyIdx && l === "─".repeat(120));
		expect(bodyIdx).toBeGreaterThan(rowIdx); // the preview renders after the lane rows
		expect(ruleIdx).toBeGreaterThan(-1); // a full-width separator introduces the preview block
		overlay.dispose();
	});

	it("caps the preview at PREVIEW_LINES — only the newest tail survives a long transcript", () => {
		const many = Array.from({ length: 50 }, (_, i) => assistantEntry(`preview-line-${i}`));
		recordRun("run-1", "ship");
		setCurrentSession(
			"run-1",
			SINGLE_UNIT_KEY,
			makeSession(() => many),
		);
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		setDockActive(true);
		setDockSelection(0);
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("preview-line-49"); // newest line in the tail
		expect(out).not.toContain("preview-line-0"); // the oldest is sliced off by the cap
		overlay.dispose();
	});

	it("stepping in does not shift ambient lane rows (preview is active-gated)", () => {
		recordRun("run-1", "polish");
		setCurrentSession(
			"run-1",
			SINGLE_UNIT_KEY,
			makeSession(() => [assistantEntry("body")]),
		);
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const ambientRow = (widget?.render(120) ?? []).find((l) => l.includes("polish")) ?? "";
		setDockActive(true);
		setDockSelection(0);
		const activeRow = (widget?.render(120) ?? []).find((l) => l.includes("polish")) ?? "";
		expect(activeRow.indexOf("polish")).toBe(ambientRow.indexOf("polish"));
		overlay.dispose();
	});

	it("active preview appends the live streaming partial's thinking in the tail", () => {
		recordRun("run-1", "ship");
		const session = makeSession(() => [assistantEntry("COMMITTED_BODY")]);
		session.setStreaming({ role: "assistant", content: [{ type: "thinking", thinking: "STREAMING_THOUGHT" }] });
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		setDockActive(true);
		setDockSelection(0);
		expect((widget?.render(120) ?? []).join("\n")).toContain("STREAMING_THOUGHT");
		overlay.dispose();
	});

	it("drops the streaming partial once the turn commits (getStreamingMessage → undefined)", () => {
		recordRun("run-1", "ship");
		const session = makeSession(() => [assistantEntry("COMMITTED_BODY")]);
		session.setStreaming({ role: "assistant", content: [{ type: "thinking", thinking: "TRANSIENT" }] });
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		setDockActive(true);
		setDockSelection(0);
		expect((widget?.render(120) ?? []).join("\n")).toContain("TRANSIENT");
		session.setStreaming(undefined);
		overlay.update(); // re-render after the turn commits
		expect((widget?.render(120) ?? []).join("\n")).not.toContain("TRANSIENT");
		overlay.dispose();
	});
});

describe("LaneDock — fanout unit sub-rows (Phase 6)", () => {
	const assistantEntry = (text: string) => ({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
	const pending = () => ({ factory: (() => ({})) as never, options: undefined as never, resolve: () => {} });

	it("flattens a fanout lane into 1 + N rows: the lane row + an indented sub-row per unit", () => {
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "phase 1/3");
		setUnitStarted("run-1", 1, "phase 2/3");
		setUnitStarted("run-1", 2, "phase 3/3");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		// the lane (parent) row + one labelled sub-row per fanout unit.
		expect(out).toContain("carve");
		expect(out).toContain("phase 1/3");
		expect(out).toContain("phase 2/3");
		expect(out).toContain("phase 3/3");
		overlay.dispose();
	});

	it("a single-stage run (sentinel-only) shows exactly one lane row, no sub-rows", () => {
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, makeSession());
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const lines = widget?.render(120) ?? [];
		// SINGLE_UNIT_KEY (-1) never flattens into a sub-row, so the workflow appears once.
		expect(lines.filter((l) => l.includes("ship")).length).toBe(1);
		overlay.dispose();
	});

	it("unit sub-row glyph priority: needs-input ⚑ wins; done shows ✓; a still-running unit spins", () => {
		vi.useFakeTimers();
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "u-running");
		setUnitStarted("run-1", 1, "u-done");
		markUnitDone("run-1", 1, "done");
		setUnitStarted("run-1", 2, "u-needs");
		enqueueInput("run-1", 2, pending());
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const lines = widget?.render(120) ?? [];
		const rowOf = (label: string) => lines.find((l) => l.includes(label)) ?? "";
		expect(rowOf("u-needs")).toContain("⚑");
		expect(rowOf("u-done")).toContain("✓");
		const SPINNER_FRAMES = ["⠴", "⠦", "⠖", "⠲"];
		expect(SPINNER_FRAMES.some((g) => rowOf("u-running").includes(g))).toBe(true);
		overlay.dispose();
	});

	it("the active preview follows the SELECTED unit sub-row's own session (not the lane's)", () => {
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "phase 1");
		setUnitStarted("run-1", 1, "phase 2");
		setCurrentSession(
			"run-1",
			1,
			makeSession(() => [assistantEntry("UNIT1_BODY")]),
		);
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		setDockActive(true);
		// flattened rows: 0=lane, 1=unit0, 2=unit1 — select the unit-1 sub-row.
		setDockSelection(2);
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("UNIT1_BODY");
		overlay.dispose();
	});

	it("x on a unit sub-row is the parent run's — the lane heading counts come from the lane set", () => {
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "phase 1");
		setUnitStarted("run-1", 1, "phase 2");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		// 1 running lane → heading reads "(1 active)" despite 3 display rows.
		expect((widget?.render(120) ?? [])[1]).toContain("Runs (1 active)");
		overlay.dispose();
	});
});

describe("LaneDock — token tally (Slice 2)", () => {
	it("the lane row shows the SUMMED aggregate tally across completed units", () => {
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "u0");
		setUnitStarted("run-1", 1, "u1");
		setLaneProgress("run-1", {
			stageNumber: 3,
			totalStages: 5,
			stageName: "implement",
			phase: "running",
			units: { done: 2, total: 2 },
		});
		const s0 = makeSession();
		s0.setUsage(sessionStats({ input: 1500, output: 800, cacheRead: 500, cacheWrite: 200 }));
		const s1 = makeSession();
		s1.setUsage(sessionStats({ input: 1200, output: 400, cacheRead: 300, cacheWrite: 100 }));
		captureFinalSnapshot("run-1", 0, s0);
		captureFinalSnapshot("run-1", 1, s1);
		markUnitDone("run-1", 0, "done");
		markUnitDone("run-1", 1, "done");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		// The lane (parent) row carries the workflow name; the aggregate is the SUM of both
		// units: input 2700→"2.7k", output 1200→"1.2k", cacheRead 800→"800".
		const laneRow = (widget?.render(120) ?? []).find((l) => l.includes("carve")) ?? "";
		expect(laneRow).toContain("↑2.7k");
		expect(laneRow).toContain("↓1.2k");
		expect(laneRow).toContain("R800");
		overlay.dispose();
	});

	it("each unit sub-row shows its OWN finalUsage tally (not the aggregate)", () => {
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "u0");
		setUnitStarted("run-1", 1, "u1");
		setLaneProgress("run-1", {
			stageNumber: 3,
			totalStages: 5,
			stageName: "implement",
			phase: "running",
			units: { done: 2, total: 2 },
		});
		const s0 = makeSession();
		s0.setUsage(sessionStats({ input: 1500, output: 800, cacheRead: 500, cacheWrite: 200 }));
		const s1 = makeSession();
		s1.setUsage(sessionStats({ input: 1200, output: 400, cacheRead: 300, cacheWrite: 100 }));
		captureFinalSnapshot("run-1", 0, s0);
		captureFinalSnapshot("run-1", 1, s1);
		markUnitDone("run-1", 0, "done");
		markUnitDone("run-1", 1, "done");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		// Unit 0's own tally (1500→"1.5k", 800, 500) — NOT the 2.7k aggregate.
		expect(out).toContain("↑1.5k ↓800 R500");
		// Unit 1's own tally (1200→"1.2k", 400, 300).
		expect(out).toContain("↑1.2k ↓400 R300");
		overlay.dispose();
	});

	it("omits each segment when zero and the whole tally when all-zero", () => {
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "u-partial"); // only input nonzero
		setUnitStarted("run-1", 1, "u-zero"); // all zero
		setLaneProgress("run-1", {
			stageNumber: 1,
			totalStages: 2,
			stageName: "plan",
			phase: "running",
			units: { done: 2, total: 2 },
		});
		const sPartial = makeSession();
		sPartial.setUsage(sessionStats({ input: 1500, output: 0, cacheRead: 0, cacheWrite: 0 }));
		const sZero = makeSession();
		sZero.setUsage(sessionStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
		captureFinalSnapshot("run-1", 0, sPartial);
		captureFinalSnapshot("run-1", 1, sZero);
		markUnitDone("run-1", 0, "done");
		markUnitDone("run-1", 1, "done");
		const overlay = new LaneDock();
		const lines = widgetLines(overlay);
		const partialRow = lines.find((l) => l.includes("u-partial")) ?? "";
		const zeroRow = lines.find((l) => l.includes("u-zero")) ?? "";
		// Per-segment omit: input-only → "↑1.5k" with no ↓ and no R.
		expect(partialRow).toContain("↑1.5k");
		expect(partialRow).not.toContain("↓");
		expect(partialRow).not.toContain("R500");
		// All-zero → no tally segment at all.
		expect(zeroRow).not.toContain("↑");
		expect(zeroRow).not.toContain("↓");
		overlay.dispose();
	});

	it("a lane with no captured units renders no aggregate tally and a running unit shows none", () => {
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "u-running"); // running, never captured → no finalUsage
		setLaneProgress("run-1", {
			stageNumber: 1,
			totalStages: 3,
			stageName: "research",
			phase: "running",
			units: { done: 0, total: 1 },
		});
		const overlay = new LaneDock();
		const lines = widgetLines(overlay);
		const laneRow = lines.find((l) => l.includes("carve")) ?? "";
		const unitRow = lines.find((l) => l.includes("u-running")) ?? "";
		// No unit has finalUsage → the lane-row aggregate is omitted.
		expect(laneRow).not.toContain("↑");
		// A running unit (no teardown capture yet) shows no tally.
		expect(unitRow).not.toContain("↑");
		overlay.dispose();
	});

	it("a running unit with a LIVE session tallies per-unit AND the lane aggregate (no teardown)", () => {
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "u-live");
		setLaneProgress("run-1", {
			stageNumber: 1,
			totalStages: 3,
			stageName: "research",
			phase: "running",
		});
		// Attach a LIVE child session (NO captureFinalSnapshot → finalUsage stays undefined),
		// so unitUsage reads the live getUsage() path, not the teardown snapshot.
		const s = makeSession();
		s.setUsage(sessionStats({ input: 1500, output: 800, cacheRead: 500, cacheWrite: 0 }));
		setCurrentSession("run-1", 0, s);
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const render = () => widget?.render(120) ?? [];
		// Per-unit sub-row reads the LIVE usage (1500→"1.5k", 800, 500) with NO teardown.
		const firstUnit = render().find((l) => l.includes("u-live")) ?? "";
		expect(firstUnit).toContain("↑1.5k");
		expect(firstUnit).toContain("↓800");
		expect(firstUnit).toContain("R500");
		// The lane-row aggregate now also tallies a RUNNING unit (previously frozen at zero
		// until teardown) — same live numbers, summed over the single unit.
		const firstLane = render().find((l) => l.includes("carve")) ?? "";
		expect(firstLane).toContain("↑1.5k");
		expect(firstLane).toContain("↓800");
		// Mutate the live stats and re-render the SAME widget → the tally ticks in real time.
		s.setUsage(sessionStats({ input: 2500, output: 400, cacheRead: 200, cacheWrite: 0 }));
		const secondUnit = render().find((l) => l.includes("u-live")) ?? "";
		expect(secondUnit).toContain("↑2.5k"); // 2500 → "2.5k"
		expect(secondUnit).not.toContain("↑1.5k"); // stale value cleared
		overlay.dispose();
	});

	it("a running unit whose live getUsage() throws renders no tally (fail-soft, never throws)", () => {
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "u-throw");
		setLaneProgress("run-1", {
			stageNumber: 1,
			totalStages: 3,
			stageName: "research",
			phase: "running",
		});
		// A live session whose getUsage() throws — unitUsage must swallow it and return
		// undefined (never propagate into a render tick), mirroring captureSnapshotInto.
		const throwing: LaneSession = {
			...makeSession(),
			getUsage: () => {
				throw new Error("stats unavailable");
			},
		};
		setCurrentSession("run-1", 0, throwing);
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		expect(() => widget?.render(120)).not.toThrow();
		const unitRow = (widget?.render(120) ?? []).find((l) => l.includes("u-throw")) ?? "";
		expect(unitRow).not.toContain("↑"); // fail-soft → no tally
		overlay.dispose();
	});

	it("unitUsage prefers the teardown snapshot over the live session after retirement", () => {
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "u-done");
		setLaneProgress("run-1", {
			stageNumber: 3,
			totalStages: 3,
			stageName: "implement",
			phase: "running",
			units: { done: 1, total: 1 },
		});
		const live = makeSession();
		// Live stats say 9999 — the snapshot (below) must win once captured.
		live.setUsage(sessionStats({ input: 9999, output: 0, cacheRead: 0, cacheWrite: 0 }));
		setCurrentSession("run-1", 0, live);
		// Teardown path: snapshot is captured WHILE the child is still live, THEN the
		// session is dropped. unitUsage must return the snapshot (1200), not the live 9999.
		const snapshotSession = makeSession();
		snapshotSession.setUsage(sessionStats({ input: 1200, output: 400, cacheRead: 300, cacheWrite: 0 }));
		captureFinalSnapshot("run-1", 0, snapshotSession);
		setCurrentSession("run-1", 0, undefined);
		markUnitDone("run-1", 0, "done");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const unitRow = (widget?.render(120) ?? []).find((l) => l.includes("u-done")) ?? "";
		expect(unitRow).toContain("↑1.2k"); // snapshot 1200 → "1.2k", NOT the live "9.9k"
		expect(unitRow).not.toContain("↑9.9k");
		overlay.dispose();
	});

	/** Render the dock at width 120 and return the lines (mounts the overlay). */
	function widgetLines(overlay: LaneDock): string[] {
		const { widget } = mount(overlay, makeCtx());
		return widget?.render(120) ?? [];
	}
});
