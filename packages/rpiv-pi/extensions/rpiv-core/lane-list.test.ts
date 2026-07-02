import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeLaneLayout, computeViewport, MAX_DOCK_ROWS, MAX_WIDGET_LINES, renderLaneList } from "./lane-list.js";
import {
	__resetRunLaneRegistry,
	type DisplayRow,
	enqueueInput,
	recordRun,
	retireRun,
	SINGLE_UNIT_KEY,
	setLaneProgress,
	setLaneStatus,
	setUnitStarted,
} from "./run-lane-registry.js";

/**
 * Identity theme — fg/bg/bold return their text unchanged so a rendered line reads
 * plainly and the active↔ambient row diff reduces to the leading gutter glyph only.
 * (Same helper the sibling lane tests use.)
 */
const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
} as unknown as Theme;

/**
 * Encoding theme — fg → "color:text", bg → "[color]text", bold → "*text*" so the
 * selected-row styling (accent+bold descriptor) is observable without ANSI.
 */
const encTheme = {
	fg: (c: string, s: string) => `${c}:${s}`,
	bg: (c: string, s: string) => `[${c}]${s}`,
	bold: (s: string) => `*${s}*`,
	strikethrough: (s: string) => s,
} as unknown as Theme;

/** Minimal DisplayRow cast helper — computeViewport reads ONLY `row.kind` + array
 *  position, so a `{ kind }` object is sufficient (no real lane/unit payload needed). */
const mk = (...kinds: ("lane" | "unit")[]): DisplayRow[] => kinds.map((kind) => ({ kind }) as DisplayRow);

beforeAll(() => {
	initTheme(); // SDK theme proxies read a global theme; seed it (mirrors sibling lane tests)
});

beforeEach(() => {
	__resetRunLaneRegistry();
});
afterEach(() => {
	__resetRunLaneRegistry();
});

describe("renderLaneList", () => {
	/** Lane budget well above every seeded row count so no scroll-follow fold appears. */
	const LANE_CAP = computeLaneLayout(40).laneCap; // 11
	const W = 80;

	/**
	 * The static-lanes invariant: under an identity theme, an ambient render
	 * (active:false) and a stepped-in render (active:true, selection=K) over the SAME
	 * registry state produce IDENTICAL line arrays except the selected row, which
	 * differs ONLY by its leading gutter (`❯ ` vs `  `). Identity theme collapses
	 * accent/bold/text descriptors to the same plain string, so the gutter glyph is
	 * the sole diff. `activeRow.replace(/^❯ /, "  ") === ambientRow` proves it — any
	 * positional shift would break the equality.
	 */
	function expectStaticLanes(selection: number, frame = 0): void {
		const ambient = renderLaneList(identityTheme, W, { active: false, selection, frame, laneCap: LANE_CAP });
		const active = renderLaneList(identityTheme, W, { active: true, selection, frame, laneCap: LANE_CAP });
		expect(active.length).toBe(ambient.length);
		// Exactly one active line carries the cursor; ambient carries none.
		expect(active.filter((l) => l.startsWith("❯ ")).length).toBe(1);
		expect(ambient.some((l) => l.startsWith("❯ "))).toBe(false);
		for (let i = 0; i < ambient.length; i++) {
			if (active[i].startsWith("❯ ")) {
				// The selected row differs ONLY by its leading gutter: ❯-space vs two spaces.
				expect(active[i].replace(/^❯ /, "  ")).toBe(ambient[i]);
			} else {
				expect(active[i]).toBe(ambient[i]);
			}
		}
	}

	it("static-lanes invariant: active differs from ambient only by the selected row's leading gutter", () => {
		// A mixed registry exercising several row shapes — none needs-input (those
		// stamp a Date.now() age into the heading, which could flake a byte-for-byte
		// comparison across a second boundary). running / completed / failed only.
		recordRun("run-1", "ship");
		setLaneProgress("run-1", { stageNumber: 2, totalStages: 5, stageName: "plan", phase: "running" });
		recordRun("run-2", "build");
		setLaneStatus("run-2", "completed");
		recordRun("run-3", "vet");
		retireRun("run-3", "failed", "boom");
		// Display order (needs→running→terminal, insertion-stable): run-1, run-2, run-3.
		// The invariant holds for EVERY row kind as the selected row.
		expectStaticLanes(0); // running + live progress lane
		expectStaticLanes(1); // completed lane
		expectStaticLanes(2); // failed lane
	});

	it("the invariant holds with the SAME spinner frame on both renders (frame is the only cross-render variable)", () => {
		recordRun("run-1", "ship");
		// A running lane's glyph comes from SPINNER_FRAMES[frame]; using identical frames
		// on both renders is what keeps the glyph identical (and the invariant intact).
		expectStaticLanes(0, 2);
	});

	it("covers a unit sub-row selection, not just a lane row", () => {
		// A fanout lane flattens to [lane, unit, unit] display rows; selecting the unit
		// sub-row still differs from ambient by only the gutter.
		recordRun("run-1", "build");
		setUnitStarted("run-1", 0, "phase 1/2");
		setUnitStarted("run-1", 1, "phase 2/2");
		// Display rows: 0 = lane, 1 = unit phase 1, 2 = unit phase 2.
		expectStaticLanes(2); // the LAST unit sub-row
	});

	it("styling invariant: under an encoding theme, only the selected row's descriptor flips to accent+bold; row count + columns are stable", () => {
		// Two running lanes whose descriptor is the runId (name === workflow) so the
		// accent/text descriptor styling is unambiguous: "accent:*run-1*" vs "text:run-1".
		recordRun("run-1", "ship", { workflow: "ship" });
		recordRun("run-2", "build", { workflow: "build" });
		const ambient = renderLaneList(encTheme, W, { active: false, selection: 0, frame: 0, laneCap: LANE_CAP });
		const active = renderLaneList(encTheme, W, { active: true, selection: 0, frame: 0, laneCap: LANE_CAP });
		// Equal row count.
		expect(active.length).toBe(ambient.length);
		const cursorIdx = active.findIndex((l) => l.includes("❯"));
		expect(cursorIdx).toBeGreaterThan(-1);
		// Every NON-selected line is byte-identical — the selected row is the only diff.
		for (let i = 0; i < ambient.length; i++) {
			if (i === cursorIdx) continue;
			expect(active[i]).toBe(ambient[i]);
		}
		// The selected row's descriptor is accent+bold; the ambient same row is plain text.
		expect(active[cursorIdx]).toContain("accent:*run-1*");
		expect(ambient[cursorIdx]).toContain("text:run-1");
		expect(active[cursorIdx]).not.toContain("text:run-1");
		// No positional shift: both lane descriptors start at the same column (the fixed
		// gutter + tag column are width-equal across rows under this theme).
		const r1 = ambient.find((l) => l.includes("run-1")) ?? "";
		const r2 = ambient.find((l) => l.includes("run-2")) ?? "";
		expect(r1.indexOf("text:run-1")).toBe(r2.indexOf("text:run-2"));
	});

	it("returns [] when the registry has no lanes", () => {
		expect(renderLaneList(identityTheme, W, { active: false, selection: 0, frame: 0, laneCap: LANE_CAP })).toEqual(
			[],
		);
	});

	it("otherwise frames ['', heading, '', ...rows] with NO footer or rule line (each surface owns those)", () => {
		recordRun("run-1", "ship");
		recordRun("run-2", "build");
		const lines = renderLaneList(identityTheme, W, { active: false, selection: 0, frame: 0, laneCap: LANE_CAP });
		expect(lines[0]).toBe(""); // leading rhythm blank
		expect(lines[1]).toContain("Runs"); // the shared heading chip
		expect(lines[2]).toBe(""); // blank under the heading
		expect(lines.some((l) => l.includes("ship"))).toBe(true);
		expect(lines.some((l) => l.includes("build"))).toBe(true);
		// No discoverability footer, no bottom rule — those are per-surface (dock/console).
		expect(lines.some((l) => l.includes("/lanes"))).toBe(false);
		expect(lines.some((l) => /^─+$/.test(l))).toBe(false);
	});

	it("renders the needs-input glyph + heading path (enqueueInput drives the registry live, no vi.mock)", () => {
		// Confirms the real-registry hybrid decision: renderLaneList reads the registry
		// live (listLanes/listLanesForDisplay), so a needs-input lane surfaces the ⚑
		// glyph + the ● "N runs need input" heading without any module mock.
		recordRun("run-1", "ship");
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: (() => ({})) as never,
			options: undefined as never,
			resolve: () => {},
		});
		const lines = renderLaneList(identityTheme, W, { active: false, selection: 0, frame: 0, laneCap: LANE_CAP });
		const out = lines.join("\n");
		expect(out).toContain("●"); // static urgency dot in the heading
		expect(out).toMatch(/1 run needs input · \d+s/); // aging count heading
		expect(out).toContain("⚑"); // the needs-input row glyph
		expect(out).toContain("needs input"); // the needs-input row trailing label
	});
});

describe("computeViewport", () => {
	it("no-fold: when rows.length ≤ laneCap, returns the whole list with no fold flags", () => {
		const rows = mk("lane", "lane", "lane");
		expect(computeViewport(rows, 1, 5)).toEqual({ start: 0, window: 3, above: 0, below: 0 });
		// Selection is irrelevant under no-fold (the whole list is shown).
		expect(computeViewport(rows, 0, 5)).toEqual({ start: 0, window: 3, above: 0, below: 0 });
		expect(computeViewport(rows, 2, 5)).toEqual({ start: 0, window: 3, above: 0, below: 0 });
	});

	it("selection-in-window: for overflow, start ≤ selection and selection < start + window (cursor never stranded)", () => {
		// 12 lanes (> a laneCap of 5 → window 3) — the cursor must stay inside the window
		// at every selection, including the extreme ends.
		const rows = mk("lane", "lane", "lane", "lane", "lane", "lane", "lane", "lane", "lane", "lane", "lane", "lane");
		const laneCap = 5;
		for (const sel of [0, 1, 3, 6, 9, 11]) {
			const vp = computeViewport(rows, sel, laneCap);
			expect(vp.start).toBeLessThanOrEqual(sel);
			expect(sel).toBeLessThan(vp.start + vp.window);
		}
	});

	it("atomic group fold: the window starts on a LANE boundary, never a bare unit (unless pinned by the selection)", () => {
		// Groups of 3 (lane + 2 units), 4 groups = 12 rows. laneCap 5 → window 3.
		const rows = mk("lane", "unit", "unit", "lane", "unit", "unit", "lane", "unit", "unit", "lane", "unit", "unit");
		// selection 5 is a unit (group 2's 2nd unit). Naive centering lands start on 4 (a
		// unit); the fold walks it back to 3 (the parent lane). selection stays in view.
		const vp = computeViewport(rows, 5, 5);
		expect(vp.start).toBe(3);
		expect(rows[vp.start].kind).toBe("lane"); // never starts on a bare unit
		expect(vp.start).toBeLessThanOrEqual(5);
		expect(5).toBeLessThan(vp.start + vp.window);
		// The whole group [3,6) renders together: the lane + both its units.
		expect(rows[vp.start + 1].kind).toBe("unit");
		expect(rows[vp.start + 2].kind).toBe("unit");
	});

	it("atomic group fold: a partial group cut at the bottom edge BELOW the selection folds to +N below, not split mid-group", () => {
		// Groups of 4 (lane + 3 units), 5 groups = 20 rows. laneCap 7 → window 5.
		const rows = mk(
			"lane",
			"unit",
			"unit",
			"unit",
			"lane",
			"unit",
			"unit",
			"unit",
			"lane",
			"unit",
			"unit",
			"unit",
			"lane",
			"unit",
			"unit",
			"unit",
			"lane",
			"unit",
			"unit",
			"unit",
		);
		// selection 2 is group 1's 3rd unit. Naive end = 5 (a unit in group 2); the cut
		// group 2 is entirely below the selection, so end folds back to 4 (group 2's lane
		// boundary) and group 2+ collapses into "+N below". The window shows full group 1.
		const vp = computeViewport(rows, 2, 7);
		expect(vp.start).toBe(0);
		expect(vp.window).toBe(4); // folded down from 5 → 4
		expect(rows[vp.start + vp.window].kind).toBe("lane"); // the fold point is a lane boundary
		expect(vp.below).toBe(1); // group 2+ folded below
		expect(vp.above).toBe(0);
		// selection (group 1's unit) stays in the window.
		expect(vp.start).toBeLessThanOrEqual(2);
		expect(2).toBeLessThan(vp.start + vp.window);
	});

	it("fold flags: above === 1 iff start > 0; below === 1 iff start + window < rows.length; both 0 in no-fold", () => {
		const groups3 = mk(
			"lane",
			"unit",
			"unit",
			"lane",
			"unit",
			"unit",
			"lane",
			"unit",
			"unit",
			"lane",
			"unit",
			"unit",
		);
		const lanes = mk("lane", "lane", "lane", "lane", "lane", "lane", "lane", "lane", "lane", "lane");
		const cases: Array<[DisplayRow[], number, number]> = [
			[lanes.slice(0, 3), 1, 5], // no-fold → both 0
			[lanes, 0, 5], // overflow from the top
			[lanes, 9, 5], // overflow at the bottom edge
			[lanes, 4, 5], // overflow mid-list
			[groups3, 5, 5], // group-aware top fold
		];
		for (const [rows, sel, cap] of cases) {
			const vp = computeViewport(rows, sel, cap);
			expect(vp.above).toBe(vp.start > 0 ? 1 : 0);
			expect(vp.below).toBe(vp.start + vp.window < rows.length ? 1 : 0);
		}
	});
});

describe("computeLaneLayout", () => {
	it("laneCap is capped at MAX_WIDGET_LINES - 1 however tall the terminal", () => {
		expect(computeLaneLayout(100).laneCap).toBe(MAX_WIDGET_LINES - 1); // 11
		expect(computeLaneLayout(1000).laneCap).toBe(MAX_WIDGET_LINES - 1); // never grows unbounded
	});

	it("totalRows is capped at MAX_DOCK_ROWS", () => {
		expect(computeLaneLayout(100).totalRows).toBe(MAX_DOCK_ROWS); // 40
	});

	it("clamps DOWN on a tiny terminal (total ≤ terminal.rows, never overflows)", () => {
		expect(computeLaneLayout(8)).toEqual({ totalRows: 8, laneCap: 2 });
	});

	it("laneCap is floored at 1, never 0, even when termRows ≤ overhead", () => {
		expect(computeLaneLayout(3).laneCap).toBe(1);
		expect(computeLaneLayout(1).laneCap).toBe(1);
	});
});
