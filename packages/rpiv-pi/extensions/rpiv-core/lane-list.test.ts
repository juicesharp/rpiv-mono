import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	computeLaneLayout,
	computeViewport,
	MAX_DOCK_ROWS,
	MAX_WIDGET_LINES,
	renderLaneList,
	renderRecap,
	renderStageBreakdown,
} from "./lane-list.js";
import { formatTokens } from "./lane-usage.js";
import {
	__resetRunLaneRegistry,
	captureFinalSnapshot,
	clearUnitLanes,
	type DisplayRow,
	enqueueInput,
	foldStageUsage,
	recordRun,
	retireRun,
	SINGLE_UNIT_KEY,
	setLaneProgress,
	setLaneStatus,
	setRecap,
	setUnitStarted,
} from "./run-lane-registry.js";
import { __resetSubagentUsage, recordSubagentCompletion } from "./subagent-usage.js";

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
	__resetSubagentUsage();
});
afterEach(() => {
	__resetRunLaneRegistry();
	__resetSubagentUsage();
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
		setLaneProgress("run-1", { stageName: "plan", phase: "running" });
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

describe("renderLaneList — completed-lane lastArtifact segment", () => {
	const LANE_CAP = computeLaneLayout(40).laneCap; // 11
	// Wide enough that the full artifact path renders untruncated — truncation on a
	// narrow terminal (criterion #3) is a separate concern exercised manually.
	const W = 200;

	it("renders `→ <bucket>/<file>` as a trailing segment AFTER the usage tally on a completed lane", () => {
		// A completed lane with live stage progress + usage + lastArtifact renders:
		//   …commit · ↑134k ↓26k R2.1M → builds/ship.md
		// (displayArtifact strips the canonical `.rpiv/artifacts/` root — display only,
		// the stored lastArtifact keeps the full path.) The artifact segment is the LAST
		// tail segment (after the usage tally).
		recordRun("run-1", "ship", { workflow: "ship" });
		setLaneProgress("run-1", { stageName: "commit", phase: "running" });
		// Seed usage on the lane's single-stage unit via captureFinalSnapshot, then retire
		// so the lane reads completed + retains the snapshot's finalUsage.
		captureFinalSnapshot("run-1", SINGLE_UNIT_KEY, {
			sessionId: "s1",
			isStreaming: false,
			sessionManager: { getBranch: () => [{ type: "message" }], getCwd: () => "/tmp" },
			getToolDefinition: () => undefined,
			getStreamingMessage: () => undefined,
			getUsage: () => ({
				tokens: { input: 134000, output: 26000, cacheRead: 2_100_000, cacheWrite: 0, total: 2260000 },
			}),
			subscribe: () => () => {},
		});
		retireRun("run-1", "completed", undefined, ".rpiv/artifacts/builds/ship.md");
		const lines = renderLaneList(identityTheme, W, { active: false, selection: 0, frame: 0, laneCap: LANE_CAP });
		const row = lines.find((l) => l.includes("commit")) ?? "";
		expect(row).toContain("↑134k");
		expect(row).toContain("R2.1M");
		// The artifact segment is present, canonical root stripped …
		expect(row).toContain("→ builds/ship.md");
		expect(row).not.toContain(".rpiv/artifacts"); // display form only
		// … and trails the usage tally (the `→` comes after the last usage segment).
		expect(row.lastIndexOf("↑134k")).toBeLessThan(row.indexOf("→ builds/ship.md"));
	});

	it("renders NO `→` segment when lastArtifact is undefined (byte-identical to a side-effect-only run)", () => {
		// r2: a completed lane with no lastArtifact must append nothing — no `→` segment,
		// no column shift. A side-effect-only run (no produces stage) hits exactly this path.
		recordRun("run-1", "ship", { workflow: "ship" });
		setLaneProgress("run-1", { stageName: "commit", phase: "running" });
		captureFinalSnapshot("run-1", SINGLE_UNIT_KEY, {
			sessionId: "s1",
			isStreaming: false,
			sessionManager: { getBranch: () => [{ type: "message" }], getCwd: () => "/tmp" },
			getToolDefinition: () => undefined,
			getStreamingMessage: () => undefined,
			getUsage: () => ({ tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 } }),
			subscribe: () => () => {},
		});
		retireRun("run-1", "completed"); // no lastArtifact arg → stays undefined
		const lines = renderLaneList(identityTheme, W, { active: false, selection: 0, frame: 0, laneCap: LANE_CAP });
		const row = lines.find((l) => l.includes("commit")) ?? "";
		expect(row).not.toContain("→"); // no trailing artifact segment at all
		expect(row).toContain("↑100"); // usage tally still renders
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

describe("renderLaneList — subagent token roll-in", () => {
	const LANE_CAP = computeLaneLayout(40).laneCap; // 11
	const W = 120;

	/** Seed orchestrator usage onto a run's single-unit lane via the same
	 *  `captureFinalSnapshot` + `getUsage` mock pattern the lastArtifact tests use. */
	function seedOrchestratorUsage(runId: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): void {
		captureFinalSnapshot(runId, SINGLE_UNIT_KEY, {
			sessionId: "s1",
			isStreaming: false,
			sessionManager: { getBranch: () => [{ type: "message" }], getCwd: () => "/tmp" },
			getToolDefinition: () => undefined,
			getStreamingMessage: () => undefined,
			getUsage: () => ({
				tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
			}),
			subscribe: () => () => {},
		});
	}

	it("a row with BOTH orchestrator units and recorded subagent usage renders the two summed", () => {
		recordRun("run-1", "ship", { workflow: "ship" });
		setLaneProgress("run-1", { stageName: "research", phase: "running" });
		seedOrchestratorUsage("run-1", 100, 50); // → ↑100 ↓50
		// Subagent adds input 30 (cacheRead forced 0 by the accumulator): the row's
		// tally must show the SUM — ↑130 ↓50 — proving the roll-in merged the two stores.
		recordSubagentCompletion("run-1", "research", { tokens: { input: 30, output: 0, total: 30 } });
		const lines = renderLaneList(identityTheme, W, { active: false, selection: 0, frame: 0, laneCap: LANE_CAP });
		const row = lines.find((l) => l.includes("research")) ?? "";
		expect(row).toContain(`↑${formatTokens(130)}`); // 100 (orch) + 30 (subagent)
		expect(row).toContain(`↓${formatTokens(50)}`); // 50 (orch) + 0 (subagent)
	});

	it("a run with NO subagent completions renders byte-identical to before (roll-up is undefined → no-op)", () => {
		// addLaneUsage(x, undefined) === x, so a subagent-free lane renders exactly the
		// orchestrator tally — no phantom tokens, no column shift.
		recordRun("run-1", "ship", { workflow: "ship" });
		setLaneProgress("run-1", { stageName: "plan", phase: "running" });
		seedOrchestratorUsage("run-1", 1000, 500, 200, 0);
		const lines = renderLaneList(identityTheme, W, { active: false, selection: 0, frame: 0, laneCap: LANE_CAP });
		const row = lines.find((l) => l.includes("plan")) ?? "";
		// Orchestrator-only tally: ↑1.0k ↓500 R200 — nothing added by the subagent store.
		expect(row).toContain(`↑${formatTokens(1000)}`);
		expect(row).toContain(`↓${formatTokens(500)}`);
		expect(row).toContain(`R${formatTokens(200)}`);
	});
});

describe("renderStageBreakdown — per-stage token breakdown", () => {
	const W = 120;

	/** Seed orchestrator usage onto a run's single-unit lane via captureFinalSnapshot. */
	function seedOrchestratorUsage(runId: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): void {
		captureFinalSnapshot(runId, SINGLE_UNIT_KEY, {
			sessionId: "s1",
			isStreaming: false,
			sessionManager: { getBranch: () => [{ type: "message" }], getCwd: () => "/tmp" },
			getToolDefinition: () => undefined,
			getStreamingMessage: () => undefined,
			getUsage: () => ({
				tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
			}),
			subscribe: () => () => {},
		});
	}

	it("returns [] for a missing/evicted lane", () => {
		expect(renderStageBreakdown(identityTheme, W, "nope")).toEqual([]);
	});

	it("returns [] when no stage carries usage", () => {
		recordRun("run-1", "ship");
		setLaneProgress("run-1", { stageName: "plan", phase: "running" });
		// No units with usage, no stageUsage, no subagent → empty.
		expect(renderStageBreakdown(identityTheme, W, "run-1")).toEqual([]);
	});

	it("renders a prior stage from folded stageUsage (units already cleared)", () => {
		recordRun("run-1", "ship");
		// Stage A: fold its tokens, then clear units (simulating a transition).
		setLaneProgress("run-1", { stageName: "plan", phase: "running" });
		seedOrchestratorUsage("run-1", 1000, 0);
		foldStageUsage("run-1"); // → stageUsage["plan"] = {input:1000,...}
		// clearUnitLanes empties units (the transition always pairs fold+clear); stageUsage survives.
		clearUnitLanes("run-1");
		const lines = renderStageBreakdown(identityTheme, W, "run-1");
		const planLine = lines.find((l) => l.includes("plan")) ?? "";
		expect(planLine).toContain("plan");
		expect(planLine).toContain(`↑${formatTokens(1000)}`);
	});

	it("renders the current stage from LIVE units (final-stage read-model — no fold fired)", () => {
		// The LAST/current stage has no fold yet — its orchestrator portion reads the
		// live lane.units via sumLaneUsage at render time.
		recordRun("run-1", "ship");
		setLaneProgress("run-1", { stageName: "implement", phase: "running" });
		seedOrchestratorUsage("run-1", 500, 200);
		const lines = renderStageBreakdown(identityTheme, W, "run-1");
		const implLine = lines.find((l) => l.includes("implement")) ?? "";
		expect(implLine).toContain("implement");
		expect(implLine).toContain(`↑${formatTokens(500)}`);
		expect(implLine).toContain(`↓${formatTokens(200)}`);
	});

	it("folds subagent tokens into a stage's tally", () => {
		recordRun("run-1", "ship");
		setLaneProgress("run-1", { stageName: "research", phase: "running" });
		seedOrchestratorUsage("run-1", 100, 0); // orchestrator ↑100
		recordSubagentCompletion("run-1", "research", { tokens: { input: 30, output: 0, total: 30 } });
		const lines = renderStageBreakdown(identityTheme, W, "run-1");
		const researchLine = lines.find((l) => l.includes("research")) ?? "";
		// Orchestrator (100) + subagent (30) = 130
		expect(researchLine).toContain(`↑${formatTokens(130)}`);
	});

	it("renders multiple stages in execution order (prior folded, then current)", () => {
		recordRun("run-1", "ship");
		// Stage A: plan — fold and clear
		setLaneProgress("run-1", { stageName: "plan", phase: "running" });
		seedOrchestratorUsage("run-1", 100, 0);
		foldStageUsage("run-1");
		// Transition to stage B: build (current, live units)
		retireRun("run-1", "completed");
		setLaneProgress("run-1", { stageName: "build", phase: "running" });
		seedOrchestratorUsage("run-1", 200, 0);
		const lines = renderStageBreakdown(identityTheme, W, "run-1");
		// Both stages present: plan (folded) then build (current).
		expect(lines.some((l) => l.includes("plan"))).toBe(true);
		expect(lines.some((l) => l.includes("build"))).toBe(true);
		// Execution order: plan (insertion-ordered in stageUsage) before build (appended as current).
		const planIdx = lines.findIndex((l) => l.includes("plan"));
		const buildIdx = lines.findIndex((l) => l.includes("build"));
		expect(planIdx).toBeLessThan(buildIdx);
	});
});

describe("renderRecap — end-of-run summary", () => {
	const W = 120;

	it("returns [] for a missing/evicted lane", () => {
		expect(renderRecap(identityTheme, W, "nope")).toEqual([]);
	});

	it("returns [] when the lane has no recap (running / reactivated lane — byte-identical render)", () => {
		recordRun("run-1", "ship");
		retireRun("run-1", "completed"); // retired but no recap stored
		expect(renderRecap(identityTheme, W, "run-1")).toEqual([]);
	});

	it("emits NO header (no status glyph, no outcome word, no ` · workflow` segment)", () => {
		recordRun("run-1", "ship");
		setRecap("run-1", { outcome: "completed", workflow: "ship", artifacts: ["a.md"] });
		const lines = renderRecap(identityTheme, W, "run-1");
		const out = lines.join("\n");
		// No status glyph (▶✓✗⊘), no outcome word, no `· workflow` segment — the header was a
		// duplicate of the lane chip's status and is dropped.
		expect(out).not.toMatch(/[▶✓✗⊘]/);
		expect(out).not.toContain("completed");
		expect(out).not.toContain("· ship");
	});

	it("renders ONE line: the NEWEST artifact (trail-order last) + a `+N more` count", () => {
		recordRun("run-1", "ship");
		setRecap("run-1", {
			outcome: "completed",
			artifacts: [".rpiv/artifacts/plans/a.md", ".rpiv/artifacts/builds/b.md"],
		});
		const lines = renderRecap(identityTheme, W, "run-1");
		// Single summary line — never a per-artifact report. displayArtifact strips the
		// canonical `.rpiv/artifacts/` root (display only — the stored path is full).
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("→ builds/b.md"); // newest, not the first
		expect(lines[0]).not.toContain(".rpiv/artifacts"); // root stripped for display
		expect(lines[0]).not.toContain("plans/a.md"); // older artifacts fold into the count
		expect(lines[0]).toContain("+1 more");
	});

	it("omits the `+N more` count for a single-artifact recap", () => {
		recordRun("run-1", "ship");
		setRecap("run-1", { outcome: "completed", artifacts: [".rpiv/artifacts/builds/b.md"] });
		const lines = renderRecap(identityTheme, W, "run-1");
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("→ builds/b.md");
		expect(lines[0]).not.toContain("more");
	});

	it("passes a non-canonical artifact path through untouched (url/opaque/out-of-tree handles)", () => {
		recordRun("run-1", "ship");
		setRecap("run-1", { outcome: "completed", artifacts: ["https://example.com/report"] });
		const lines = renderRecap(identityTheme, W, "run-1");
		expect(lines[0]).toContain("→ https://example.com/report");
	});

	it("stays ONE line regardless of artifact count (the summary never grows with data size)", () => {
		recordRun("run-1", "ship");
		setRecap("run-1", {
			outcome: "failed",
			failureReason: "build exploded",
			artifacts: Array.from({ length: 20 }, (_v, i) => `a${i}.md`),
		});
		const lines = renderRecap(identityTheme, W, "run-1");
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("→ a19.md"); // newest
		expect(lines[0]).toContain("+19 more");
		expect(lines[0]).toContain("⚠ build exploded"); // reason shares the same line
	});

	it("returns [] for a completed recap with no artifacts (nothing to add beyond the lane chip)", () => {
		recordRun("run-1", "ship");
		setRecap("run-1", { outcome: "completed", artifacts: [] });
		expect(renderRecap(identityTheme, W, "run-1")).toEqual([]);
	});

	it("renders the `⚠ reason` segment only for a NON-completed outcome that carries a failureReason", () => {
		recordRun("run-1", "ship");
		setRecap("run-1", { outcome: "failed", failureReason: "blueprint produced no plan", artifacts: [] });
		const lines = renderRecap(identityTheme, W, "run-1");
		expect(lines.length).toBe(1); // reason alone still summarizes (untruncated by the chip's short form)
		expect(lines[0]).toContain("⚠ blueprint produced no plan");
	});

	it("renders NO `⚠` segment for a completed outcome (even if a failureReason were present)", () => {
		recordRun("run-1", "ship");
		setRecap("run-1", { outcome: "completed", failureReason: "should not show", artifacts: ["a.md"] });
		const lines = renderRecap(identityTheme, W, "run-1");
		expect(lines.every((l) => !l.includes("⚠"))).toBe(true);
	});

	it("returns [] for a non-completed recap with no failureReason and no artifacts", () => {
		recordRun("run-1", "ship");
		setRecap("run-1", { outcome: "aborted", artifacts: [] });
		expect(renderRecap(identityTheme, W, "run-1")).toEqual([]);
	});
});

describe("renderLaneList — run grand total", () => {
	const LANE_CAP = computeLaneLayout(40).laneCap; // 11
	// Wide enough that the heading tally never truncates — the dock heading is short
	// (< 60 cols even with a tally), so this is headroom, not a width-stress case.
	const W = 200;

	/** Seed orchestrator usage on a lane's single-stage unit via captureFinalSnapshot (the
	 *  existing lastArtifact-test idiom: upsertUnit + finalUsage, read by unitUsage). */
	function seedOrchestratorUsage(runId: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): void {
		captureFinalSnapshot(runId, SINGLE_UNIT_KEY, {
			sessionId: `${runId}-s`,
			isStreaming: false,
			sessionManager: { getBranch: () => [{ type: "message" }], getCwd: () => "/tmp" },
			getToolDefinition: () => undefined,
			getStreamingMessage: () => undefined,
			getUsage: () => ({
				tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
			}),
			subscribe: () => () => {},
		});
	}

	it("heading shows the summed grand total across ≥2 lanes (orchestrator tokens summed)", () => {
		// Two lanes, each carrying orchestrator usage. The heading tally is the pairwise
		// sum of BOTH lanes' laneUsageTotal (= sumLaneUsage(units) when no subagents):
		//   run-1 {input:1000, output:500} + run-2 {input:2000, output:1000}
		//   → {input:3000, output:1500} → ↑3.0k ↓1.5k (cacheRead 0 omitted).
		recordRun("run-1", "ship", { workflow: "ship" });
		seedOrchestratorUsage("run-1", 1000, 500);
		retireRun("run-1", "completed");
		recordRun("run-2", "build", { workflow: "build" });
		seedOrchestratorUsage("run-2", 2000, 1000);
		retireRun("run-2", "completed");
		const lines = renderLaneList(identityTheme, W, { active: false, selection: 0, frame: 0, laneCap: LANE_CAP });
		const heading = lines[1]; // ['', heading, '', ...rows]
		expect(heading).toContain(`↑${formatTokens(3000)}`); // 1000 + 2000
		expect(heading).toContain(`↓${formatTokens(1500)}`); // 500 + 1000
	});

	it("grand total includes subagent tokens (a zero-orchestrator lane reflects its subagent contribution)", () => {
		// A lane with NO orchestrator usage (no units) but recorded subagent completions:
		// laneUsageTotal = addLaneUsage(undefined, getSubagentUsageForRun(runId)) — the whole
		// tally comes from the subagent store, so the heading reflects exactly the subagent
		// contribution. recordSubagentCompletion forces cacheRead=0; cacheWrite = total-input-output.
		recordRun("run-1", "ship");
		recordSubagentCompletion("run-1", "research", { tokens: { input: 800, output: 400, total: 1200 } });
		const lines = renderLaneList(identityTheme, W, { active: false, selection: 0, frame: 0, laneCap: LANE_CAP });
		const heading = lines[1];
		// Subagent-only grand total: ↑800 ↓400 (cacheRead forced 0 → no R segment).
		expect(heading).toContain(`↑${formatTokens(800)}`);
		expect(heading).toContain(`↓${formatTokens(400)}`);
	});

	it("heading renders byte-identical (no tally segment) when no lane carries usage", () => {
		// Two lanes, neither with units nor recorded subagents → sumRunUsage returns
		// undefined → formatUsageTally("") → tallyStr is "" → heading unchanged (no ↑↓R).
		// This is the byte-identical-to-pre-Phase-3 path: the tally adds NOTHING when usage
		// is absent. (The degenerate empty-registry case returns [] before renderHeading
		// runs, so it is covered by the existing "returns []" test + this no-usage lane case.)
		recordRun("run-1", "ship", { workflow: "ship" });
		recordRun("run-2", "build", { workflow: "build" });
		const lines = renderLaneList(identityTheme, W, { active: false, selection: 0, frame: 0, laneCap: LANE_CAP });
		const heading = lines[1];
		// Both lanes are still running (no retireRun) → chip reads "Runs (2 active)"; the
		// point of this test is the ABSENCE of a tally segment, not the chip verb.
		expect(heading).toContain("Runs (2 active)");
		expect(heading).not.toContain("↑");
		expect(heading).not.toContain("↓");
	});

	it("the renderLaneRow roll-in through laneUsageTotal matches the former inline expression on a single-stage run", () => {
		// For a SINGLE-stage run (stageUsage empty), laneUsageTotal reduces to the former
		// inline expression addLaneUsage(sumLaneUsage(units), getSubagentUsageForRun(runId)),
		// so routing the per-row tally through it changes nothing observable here. (Multi-stage
		// runs intentionally upgrade the row from "current stage" to "run so far" — covered by
		// the folded-stage test below.) A row with BOTH orchestrator units and recorded subagent
		// usage renders the summed tally (input 1000+300=1300, output 500+0=500).
		recordRun("run-1", "ship", { workflow: "ship" });
		setLaneProgress("run-1", { stageName: "plan", phase: "running" });
		seedOrchestratorUsage("run-1", 1000, 500); // orchestrator: ↑1.0k ↓500
		recordSubagentCompletion("run-1", "plan", { tokens: { input: 300, output: 0, total: 300 } }); // subagent: +↑300
		const lines = renderLaneList(identityTheme, W, { active: false, selection: 0, frame: 0, laneCap: LANE_CAP });
		const row = lines.find((l) => l.includes("plan")) ?? "";
		expect(row).toContain(`↑${formatTokens(1300)}`); // 1000 (orch) + 300 (subagent)
		expect(row).toContain(`↓${formatTokens(500)}`); // 500 (orch) + 0 (subagent)
	});

	it("row tally and grand total include FOLDED prior-stage orchestrator tokens (stageUsage)", () => {
		// The run-so-far semantics: after a stage transition folds stage A's tokens into
		// lane.stageUsage and clears units, BOTH the heading grand total and the per-row
		// tally must still count them — laneUsageTotal reads stageUsage + live units +
		// subagents, so the heading always equals the sum of renderStageBreakdown's lines.
		recordRun("run-1", "ship", { workflow: "ship" });
		setLaneProgress("run-1", { stageName: "plan", phase: "running" });
		seedOrchestratorUsage("run-1", 1000, 500); // stage A: ↑1.0k ↓500
		foldStageUsage("run-1"); // the bridge's transition pairing: fold …
		clearUnitLanes("run-1"); // … then clear
		setLaneProgress("run-1", { stageName: "build", phase: "running" });
		seedOrchestratorUsage("run-1", 200, 100); // stage B (current, live units): ↑200 ↓100
		const lines = renderLaneList(identityTheme, W, { active: false, selection: 0, frame: 0, laneCap: LANE_CAP });
		const heading = lines[1];
		expect(heading).toContain(`↑${formatTokens(1200)}`); // 1000 (folded plan) + 200 (live build)
		expect(heading).toContain(`↓${formatTokens(600)}`); // 500 + 100
		const row = lines.find((l) => l.includes("build")) ?? "";
		expect(row).toContain(`↑${formatTokens(1200)}`); // the row is run-so-far, not current-stage-only
		expect(row).toContain(`↓${formatTokens(600)}`);
	});
});
