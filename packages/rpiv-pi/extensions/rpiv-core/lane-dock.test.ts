import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createMockUI } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LaneDock } from "./lane-dock.js";
import {
	__resetRunLaneRegistry,
	dequeueInput,
	enqueueInput,
	evictRun,
	getDockState,
	recordRun,
	setDockActive,
	setDockSelection,
	setLaneProgress,
	setLaneStatus,
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
		enqueueInput("run-1", { factory: (() => ({})) as never, options: undefined as never, resolve: () => {} });
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("●");
		expect(out).toContain("needs input");
		overlay.dispose();
	});

	it("aging heading: shouts the needs-input count and a relative age (Phase C)", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		enqueueInput("run-1", { factory: (() => ({})) as never, options: undefined as never, resolve: () => {} });
		const heading = (widget?.render(120) ?? [])[1] ?? ""; // [0] is the top rule
		expect(heading).toMatch(/1 run needs input · \d+s/);
	});

	it("aging heading: pluralizes when multiple lanes need input (Phase C)", () => {
		recordRun("run-1", "ship");
		recordRun("run-2", "vet");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const pend = { factory: (() => ({})) as never, options: undefined as never, resolve: () => {} };
		enqueueInput("run-1", pend);
		enqueueInput("run-2", pend);
		expect((widget?.render(120) ?? [])[1]).toContain("2 runs need input"); // [0] is the top rule
	});

	it("needs-input lane is never hidden below the '+N more' fold (Phase B priority sort)", () => {
		// 12 lanes (> the 11-row budget) → collapse; the LAST-launched one needs input.
		for (let i = 0; i < 12; i++) recordRun(`run-${i}`, `lane${i}`);
		enqueueInput("run-11", { factory: (() => ({})) as never, options: undefined as never, resolve: () => {} });
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(200) ?? []).join("\n");
		expect(out).toContain("+"); // collapse line present
		expect(out).toContain("more");
		expect(out).toContain("lane11"); // the needs-input lane sorted above the fold
		expect(out).toContain("⚑");
		overlay.dispose();
	});

	it("renders the distinguishing hex short-id, not the shared date prefix (Phase 7.4)", () => {
		// Two runs launched the same second share the timestamp slug; only the hex
		// suffix differs. slice(0,6) would render "2026-0" for both — useless.
		recordRun("2026-06-19_08-14-17-a1b2", "ship");
		recordRun("2026-06-19_08-14-17-c3d4", "vet");
		const overlay = new LaneDock();
		const { widget } = mount(overlay, makeCtx());
		const out = (widget?.render(120) ?? []).join("\n");
		expect(out).toContain("a1b2");
		expect(out).toContain("c3d4");
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

	it("setFooterText injects the resolved hotkey glyph into the footer (Phase E)", () => {
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		overlay.setFooterText("^Q · /lanes — open run manager");
		const { widget } = mount(overlay, makeCtx());
		const lines = widget?.render(120) ?? [];
		const footerIdx = lines.findIndex((l) => l.includes("/lanes"));
		expect(lines[footerIdx]).toContain("^Q");
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

	it("needs-input still wins the trailing label over live progress", () => {
		recordRun("run-1", "ship");
		setLaneProgress("run-1", { stageNumber: 3, totalStages: 7, stageName: "plan-layers", phase: "running" });
		enqueueInput("run-1", { factory: (() => ({})) as never, options: undefined as never, resolve: () => {} });
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

describe("LaneDock — spinner animation", () => {
	it("a running lane renders a spinner glyph; advancing the timer cycles the frame + requests render", () => {
		vi.useFakeTimers();
		recordRun("run-1", "ship");
		const overlay = new LaneDock();
		const { widget, tui } = mount(overlay, makeCtx());
		const frame0 = widget?.render(120)[1]; // [0] is the top rule; heading carries the spinner
		// rpiv-warp's ambient-activity braille indicator (title-spinner.ts SPINNER_FRAMES).
		const SPINNER_FRAMES = ["⠴", "⠦", "⠖", "⠲"];
		expect(SPINNER_FRAMES.some((g) => frame0?.includes(g))).toBe(true);
		// Drive the interval → frame advances and the widget repaints.
		vi.advanceTimersByTime(160);
		expect(tui?.requestRender).toHaveBeenCalled();
		const frame1 = widget?.render(120)[1];
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
		enqueueInput("run-1", { factory: (() => ({})) as never, options: undefined as never, resolve: () => {} });
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
		enqueueInput("run-1", { factory: (() => ({})) as never, options: undefined as never, resolve: () => {} });
		setLaneStatus("run-1", "completed");
		const overlay = new LaneDock();
		mount(overlay, makeCtx());
		// Drain the queue → next update clears the heartbeat timer.
		dequeueInput("run-1");
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
		expect(out).toContain("↓ to step in"); // the DOWN-from-empty entry gesture is labeled
		expect(out).not.toContain("Enter to view"); // no run-action contract in the ambient footer
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
		expect(out).toContain("Enter to view");
		expect(out).not.toContain("/lanes"); // ambient discoverability hint is replaced by the nav footer
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
