/**
 * lane-progress tests — the root-gated lifecycle→registry bridge (Phase 8).
 *
 * Mirrors the execution-host provider-hook tests: registration is gated to the
 * ROOT launcher's session_start (a branded relay ui / a non-UI session skip it),
 * is idempotent across a re-fired session_start, maps lifecycle events onto
 * setLaneProgress, and degrades silently when the rpiv-workflow sibling is absent.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the rpiv-workflow /startup seam so the listener bundle is observable
// without the real lifecycle registry — registerLaneProgress() imports it lazily.
const lifecycleDispose = vi.fn();
const registerLifecycle = vi.fn((_listeners: unknown) => lifecycleDispose);
vi.mock("@juicesharp/rpiv-workflow/startup", () => ({ registerLifecycle }));

import { __resetLaneProgress, registerLaneProgressHook } from "./lane-progress.js";
import { createLaneRelayUiContext } from "./lane-relay-ui.js";
import { __resetRunLaneRegistry, getLane, getUnit, recordRun, SINGLE_UNIT_KEY } from "./run-lane-registry.js";
import { __resetSessionCaptureState, registerSessionCapture } from "./session-capture.js";

/** Loose projection of the listener bundle — enough to drive the events under test. */
interface Bundle {
	onStageStart?: (stage: { stageNumber: number; name: string }, ctx: { runId: string; totalStages: number }) => void;
	onStageRetry?: (
		stage: { stageNumber: number; name: string },
		attempt: number,
		ctx: { runId: string; totalStages: number },
	) => void;
	onStageError?: (
		stage: { stageNumber: number; name: string },
		error: string,
		ctx: { runId: string; totalStages: number },
	) => void;
	onLoopStart?: (
		stage: { stageNumber: number; name: string },
		info: { kind?: string; units?: unknown[] },
		ctx: { runId: string; totalStages: number },
	) => void;
	onUnitStart?: (
		stage: { stageNumber: number; name: string },
		unit: { index: number; label: string },
		ctx: { runId: string; totalStages: number },
	) => void;
	onUnitEnd?: (
		stage: { stageNumber: number; name: string },
		unit: { index: number; label?: string },
		output: unknown,
		ctx: { runId: string; totalStages: number },
	) => void;
	onWorkflowEnd?: (
		result: { termination?: { status: string; error?: string } },
		ctx: { runId: string; workflow: string; totalStages: number },
	) => void;
}

type SessionStartHandler = (ev: unknown, ctx: unknown) => unknown | Promise<unknown>;

function makePi(): { pi: ExtensionAPI; sessionStart: () => SessionStartHandler | undefined } {
	let handler: SessionStartHandler | undefined;
	const pi = {
		on: vi.fn((event: string, h: SessionStartHandler) => {
			if (event === "session_start") handler = h;
		}),
	} as unknown as ExtensionAPI;
	return { pi, sessionStart: () => handler };
}

const REAL_UI = { notify: vi.fn(), setStatus: vi.fn() } as unknown as ExtensionUIContext;

/** The captured listener bundle from the most recent registerLifecycle call. */
function bundle(): Bundle {
	return registerLifecycle.mock.calls.at(-1)?.[0] as unknown as Bundle;
}

/** Populate the session_start capture so getCapturedUiContext() returns REAL_UI —
 *  the onWorkflowEnd toast (Phase A) fires on the captured launcher UI. */
async function captureUi(ui: ExtensionUIContext): Promise<void> {
	let handler: SessionStartHandler | undefined;
	const pi = {
		on: vi.fn((event: string, h: SessionStartHandler) => {
			if (event === "session_start") handler = h;
		}),
	} as unknown as ExtensionAPI;
	registerSessionCapture(pi);
	await handler?.({}, { ui });
}

beforeEach(() => {
	registerLifecycle.mockClear();
	lifecycleDispose.mockClear();
	(REAL_UI.notify as ReturnType<typeof vi.fn>).mockClear();
	__resetRunLaneRegistry();
	__resetLaneProgress();
	__resetSessionCaptureState();
});
afterEach(() => {
	__resetLaneProgress();
	vi.restoreAllMocks();
});

describe("registerLaneProgressHook (Phase 8)", () => {
	it("registers the lifecycle bridge on the ROOT launcher's session_start", async () => {
		const { pi, sessionStart } = makePi();
		registerLaneProgressHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		expect(registerLifecycle).toHaveBeenCalledTimes(1);
	});

	it("does NOT register for a detached foreground child (branded relay ui)", async () => {
		const { pi, sessionStart } = makePi();
		registerLaneProgressHook(pi);
		const relay = createLaneRelayUiContext(REAL_UI, "child-run", SINGLE_UNIT_KEY);
		await sessionStart()!({}, { hasUI: true, ui: relay });
		expect(registerLifecycle).not.toHaveBeenCalled();
	});

	it("does NOT register for a non-UI session (background fanout child / headless)", async () => {
		const { pi, sessionStart } = makePi();
		registerLaneProgressHook(pi);
		await sessionStart()!({}, { hasUI: false, ui: undefined });
		expect(registerLifecycle).not.toHaveBeenCalled();
	});

	it("is idempotent — a second session_start does not stack a duplicate listener", async () => {
		const { pi, sessionStart } = makePi();
		registerLaneProgressHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		expect(registerLifecycle).toHaveBeenCalledTimes(1);
	});
});

describe("lane-progress event mapping", () => {
	async function register(): Promise<Bundle> {
		const { pi, sessionStart } = makePi();
		registerLaneProgressHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		return bundle();
	}

	it("onStageStart → setLaneProgress with stageNumber / totalStages / stageName", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		b.onStageStart?.({ stageNumber: 3, name: "plan-layers" }, { runId: "run-1", totalStages: 7 });
		expect(getLane("run-1")?.progress).toMatchObject({
			stageNumber: 3,
			totalStages: 7,
			visited: 1, // first distinct stage entered on this run
			stageName: "plan-layers",
			phase: "running",
		});
	});

	it("onStageRetry sets phase 'retry' + attempt", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		b.onStageRetry?.({ stageNumber: 2, name: "vet" }, 2, { runId: "run-1", totalStages: 7 });
		expect(getLane("run-1")?.progress).toMatchObject({ phase: "retry", attempt: 2, stageName: "vet" });
	});

	it("onStageError sets phase 'error'", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		b.onStageError?.({ stageNumber: 4, name: "synthesize" }, "boom", { runId: "run-1", totalStages: 7 });
		expect(getLane("run-1")?.progress?.phase).toBe("error");
	});

	it("onStageError carries the failure reason onto progress (Problem 1)", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		b.onStageError?.({ stageNumber: 2, name: "blueprint" }, "blueprint finished without producing a path", {
			runId: "run-1",
			totalStages: 4,
		});
		expect(getLane("run-1")?.progress).toMatchObject({
			phase: "error",
			reason: "blueprint finished without producing a path",
		});
	});

	it("visited counts DISTINCT stages — a loop-back re-enters a stage without inflating the fraction numerator", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		const ctx = { runId: "run-1", totalStages: 4 };
		// A→B→C then loop back to B: 4 activations, 3 distinct nodes.
		b.onStageStart?.({ stageNumber: 1, name: "research" }, ctx);
		b.onStageStart?.({ stageNumber: 2, name: "implement" }, ctx);
		b.onStageStart?.({ stageNumber: 3, name: "review" }, ctx);
		b.onStageStart?.({ stageNumber: 4, name: "implement" }, ctx); // re-entry — already visited
		expect(getLane("run-1")?.progress).toMatchObject({
			stageNumber: 4, // path ordinal keeps climbing
			visited: 3, // distinct nodes — does NOT double-count "implement"
			totalStages: 4,
			stageName: "implement",
		});
	});

	it("setLaneProgress no-ops on a non-recorded run (non-detached runs cost nothing)", async () => {
		const b = await register();
		// No recordRun for "ghost".
		expect(() => b.onStageStart?.({ stageNumber: 1, name: "x" }, { runId: "ghost", totalStages: 3 })).not.toThrow();
		expect(getLane("ghost")).toBeUndefined();
	});

	it("onLoopStart seeds units {done:0,total}; onUnitEnd advances monotonically under out-of-order completion", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		const ctx = { runId: "run-1", totalStages: 4 };
		const stage = { stageNumber: 2, name: "fanout" };

		b.onLoopStart?.(stage, { units: [{}, {}, {}] }, ctx);
		expect(getLane("run-1")?.progress?.units).toEqual({ done: 0, total: 3 });

		// Units complete OUT of declared order: 2, then 0, then 1. done must climb
		// 1→2→3 monotonically; total is preserved. The old `unit.index + 1` would
		// have shown 3/3 → 1/3 → 2/3 (jumps, regresses, wrong terminal value).
		b.onUnitEnd?.(stage, { index: 2 }, {}, ctx);
		expect(getLane("run-1")?.progress?.units).toEqual({ done: 1, total: 3 });
		b.onUnitEnd?.(stage, { index: 0 }, {}, ctx);
		expect(getLane("run-1")?.progress?.units).toEqual({ done: 2, total: 3 });
		b.onUnitEnd?.(stage, { index: 1 }, {}, ctx);
		expect(getLane("run-1")?.progress?.units).toEqual({ done: 3, total: 3 }); // terminal value correct
	});
});

describe("per-unit sub-rows (Phase 4 — onUnitStart/onUnitEnd lifecycle)", () => {
	async function register(): Promise<Bundle> {
		const { pi, sessionStart } = makePi();
		registerLaneProgressHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		return bundle();
	}

	it("onUnitStart materializes a per-unit sub-row (label + running) for fan-out units", async () => {
		const b = await register();
		recordRun("run-1", "carve");
		const ctx = { runId: "run-1", totalStages: 4 };
		const stage = { stageNumber: 2, name: "design" };
		b.onLoopStart?.(stage, { kind: "fanout", units: [{}, {}, {}] }, ctx);
		b.onUnitStart?.(stage, { index: 0, label: "phase 1/3" }, ctx);
		b.onUnitStart?.(stage, { index: 1, label: "phase 2/3" }, ctx);
		expect(getUnit("run-1", 0)).toMatchObject({ index: 0, label: "phase 1/3", status: "running" });
		expect(getUnit("run-1", 1)).toMatchObject({ index: 1, label: "phase 2/3", status: "running" });
	});

	it("out-of-order start/end (indices 2,0,1) resolves each unit row independently + climbs done monotonically", async () => {
		const b = await register();
		recordRun("run-1", "carve");
		const ctx = { runId: "run-1", totalStages: 4 };
		const stage = { stageNumber: 2, name: "design" };
		b.onLoopStart?.(stage, { kind: "fanout", units: [{}, {}, {}] }, ctx);

		// Units start + complete OUT of declared order: 2, then 0, then 1.
		b.onUnitStart?.(stage, { index: 2, label: "phase 3/3" }, ctx);
		b.onUnitStart?.(stage, { index: 0, label: "phase 1/3" }, ctx);
		b.onUnitStart?.(stage, { index: 1, label: "phase 2/3" }, ctx);

		b.onUnitEnd?.(stage, { index: 2 }, {}, ctx);
		expect(getUnit("run-1", 2)?.status).toBe("done");
		expect(getUnit("run-1", 0)?.status).toBe("running"); // sibling unaffected
		expect(getUnit("run-1", 1)?.status).toBe("running");
		expect(getLane("run-1")?.progress?.units).toEqual({ done: 1, total: 3 });

		b.onUnitEnd?.(stage, { index: 0 }, {}, ctx);
		expect(getUnit("run-1", 0)?.status).toBe("done");
		expect(getLane("run-1")?.progress?.units).toEqual({ done: 2, total: 3 });

		b.onUnitEnd?.(stage, { index: 1 }, {}, ctx);
		// Each row resolved to its OWN terminal status; aggregate climbed 1→2→3.
		expect([0, 1, 2].map((i) => getUnit("run-1", i)?.status)).toEqual(["done", "done", "done"]);
		expect(getLane("run-1")?.progress?.units).toEqual({ done: 3, total: 3 });
	});

	it("a second fanout onLoopStart clears the prior generation's unit rows then repopulates 0..N", async () => {
		const b = await register();
		recordRun("run-1", "carve");
		const ctx = { runId: "run-1", totalStages: 6 };
		const stageA = { stageNumber: 2, name: "design" };
		b.onLoopStart?.(stageA, { kind: "fanout", units: [{}, {}, {}] }, ctx);
		b.onUnitStart?.(stageA, { index: 0, label: "a0" }, ctx);
		b.onUnitStart?.(stageA, { index: 1, label: "a1" }, ctx);
		b.onUnitStart?.(stageA, { index: 2, label: "a2" }, ctx);
		expect(getUnit("run-1", 2)?.label).toBe("a2");

		// Second fanout generation — fewer units. The prior generation's rows are dropped.
		const stageB = { stageNumber: 5, name: "refine" };
		b.onLoopStart?.(stageB, { kind: "fanout", units: [{}, {}] }, ctx);
		expect(getUnit("run-1", 2)).toBeUndefined(); // cleared
		b.onUnitStart?.(stageB, { index: 0, label: "b0" }, ctx);
		b.onUnitStart?.(stageB, { index: 1, label: "b1" }, ctx);
		expect(getUnit("run-1", 0)?.label).toBe("b0");
		expect(getUnit("run-1", 1)?.label).toBe("b1");
	});

	it("a sequential iterate/assess loop never materializes unit sub-rows (the fanoutRuns gate drops it)", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		const ctx = { runId: "run-1", totalStages: 4 };
		const stage = { stageNumber: 2, name: "iterate" };
		b.onLoopStart?.(stage, { kind: "iterate" }, ctx); // non-fanout — gate stays off
		b.onUnitStart?.(stage, { index: 0, label: "round 1" }, ctx);
		b.onUnitStart?.(stage, { index: 1, label: "round 2" }, ctx);
		// No sub-rows for a sequential loop — they collapse onto the lane's single slot.
		expect(getUnit("run-1", 0)).toBeUndefined();
		expect(getUnit("run-1", 1)).toBeUndefined();
	});

	it("a fanout generation → non-fanout loop stage: the loop stage's onStageStart clears the prior generation; onLoopStart then drops the gate (c2)", async () => {
		const b = await register();
		recordRun("run-1", "carve");
		const ctx = { runId: "run-1", totalStages: 6 };
		b.onLoopStart?.({ stageNumber: 2, name: "design" }, { kind: "fanout", units: [{}] }, ctx);
		b.onUnitStart?.({ stageNumber: 2, name: "design" }, { index: 0, label: "d0" }, ctx);
		expect(getUnit("run-1", 0)?.label).toBe("d0");

		// Mirrors announceLoopStart (loop.ts:75→78): onStageStart fires BEFORE onLoopStart.
		const seq = { stageNumber: 4, name: "assess" };
		b.onStageStart?.(seq, ctx);
		// The loop stage's onStageStart retires the prior fan-out generation (c2) — the prior
		// "clears nothing" assertion is reversed to "clears the prior generation."
		expect(getUnit("run-1", 0)).toBeUndefined();
		b.onLoopStart?.(seq, { kind: "assess" }, ctx); // gate dropped, no new sub-rows
		b.onUnitStart?.(seq, { index: 5, label: "round" }, ctx);
		expect(getUnit("run-1", 5)).toBeUndefined();
	});

	it("a fanout generation → plain sequential (non-loop) stage: the sequential stage's onStageStart clears the prior generation (no onLoopStart needed) (c1)", async () => {
		const b = await register();
		recordRun("run-1", "carve");
		const ctx = { runId: "run-1", totalStages: 6 };
		b.onLoopStart?.({ stageNumber: 2, name: "design" }, { kind: "fanout", units: [{}, {}] }, ctx);
		b.onUnitStart?.({ stageNumber: 2, name: "design" }, { index: 0, label: "p0" }, ctx);
		b.onUnitStart?.({ stageNumber: 2, name: "design" }, { index: 1, label: "p1" }, ctx);
		expect(getUnit("run-1", 0)?.label).toBe("p0");
		expect(getUnit("run-1", 1)?.label).toBe("p1");

		// A plain sequential (non-loop) stage fires ONLY onStageStart (the single-stage entry
		// announcement, run-stage.ts:221) — no onLoopStart. Its onStageStart retires the prior
		// fan-out generation, closing the c1 gap (the sequential stage had no clearer before).
		const seq = { stageNumber: 4, name: "commit" };
		b.onStageStart?.(seq, ctx);
		expect(getUnit("run-1", 0)).toBeUndefined();
		expect(getUnit("run-1", 1)).toBeUndefined();
	});

	it("a fanout stage's onStageStart clears the prior generation but NOT its own units — they materialize via onUnitStart after the clear (c3)", async () => {
		const b = await register();
		recordRun("run-1", "carve");
		const ctx = { runId: "run-1", totalStages: 6 };
		// Prior fan-out generation.
		b.onLoopStart?.({ stageNumber: 1, name: "slice" }, { kind: "fanout", units: [{}] }, ctx);
		b.onUnitStart?.({ stageNumber: 1, name: "slice" }, { index: 0, label: "prior-0" }, ctx);
		expect(getUnit("run-1", 0)?.label).toBe("prior-0");

		// A NEW fan-out stage: announceLoopStart order is onStageStart → onLoopStart → onUnitStart.
		const stage = { stageNumber: 3, name: "design" };
		b.onStageStart?.(stage, ctx); // retires the PRIOR generation…
		expect(getUnit("run-1", 0)).toBeUndefined(); // …prior-0 cleared
		b.onLoopStart?.(stage, { kind: "fanout", units: [{}, {}] }, ctx);
		b.onUnitStart?.(stage, { index: 0, label: "phase 1/2" }, ctx); // …but THIS stage's unit 0 materializes
		b.onUnitStart?.(stage, { index: 1, label: "phase 2/2" }, ctx);
		// The fanout stage's own units survive — onStageStart did NOT reach forward and drop them.
		expect(getUnit("run-1", 0)?.label).toBe("phase 1/2");
		expect(getUnit("run-1", 1)?.label).toBe("phase 2/2");
	});

	it("orphan sweep — a unit that fires onUnitStart with NO onUnitEnd reads terminal after onStageError", async () => {
		const b = await register();
		recordRun("run-1", "carve");
		const ctx = { runId: "run-1", totalStages: 4 };
		const stage = { stageNumber: 2, name: "design" };
		b.onLoopStart?.(stage, { kind: "fanout", units: [{}, {}, {}] }, ctx);
		b.onUnitStart?.(stage, { index: 0, label: "p0" }, ctx);
		b.onUnitStart?.(stage, { index: 1, label: "p1" }, ctx);
		b.onUnitStart?.(stage, { index: 2, label: "p2" }, ctx);
		// A fail-fast halt: unit 1 completed, units 0 + 2 never fire onUnitEnd.
		b.onUnitEnd?.(stage, { index: 1 }, {}, ctx);

		b.onStageError?.(stage, "boom", ctx);
		// The still-running siblings are swept to ✗; the completed one keeps its status.
		expect(getUnit("run-1", 0)?.status).toBe("failed");
		expect(getUnit("run-1", 2)?.status).toBe("failed");
		expect(getUnit("run-1", 1)?.status).toBe("done");
	});

	it("orphan sweep — onWorkflowEnd (abort) flips every still-running sub-row terminal before retiring", async () => {
		const b = await register();
		recordRun("run-1", "carve");
		const ctx = { runId: "run-1", workflow: "carve", totalStages: 4 };
		const stage = { stageNumber: 2, name: "design" };
		b.onLoopStart?.(stage, { kind: "fanout", units: [{}, {}] }, ctx);
		b.onUnitStart?.(stage, { index: 0, label: "p0" }, ctx);
		b.onUnitStart?.(stage, { index: 1, label: "p1" }, ctx);

		b.onWorkflowEnd?.({ termination: { status: "aborted" } }, ctx);
		// Both stuck sub-rows read ✗ on an aborted run; the run itself is retired.
		expect(getUnit("run-1", 0)?.status).toBe("failed");
		expect(getUnit("run-1", 1)?.status).toBe("failed");
		expect(getLane("run-1")?.status).toBe("aborted");
	});
});

describe("onWorkflowEnd — terminal retention + completion toast (Phase A)", () => {
	async function register(): Promise<Bundle> {
		const { pi, sessionStart } = makePi();
		registerLaneProgressHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		return bundle();
	}

	it("completed → retains the lane with terminal status and toasts the launcher", async () => {
		await captureUi(REAL_UI);
		const b = await register();
		recordRun("run-1", "ship");
		b.onWorkflowEnd?.({ termination: { status: "completed" } }, { runId: "run-1", workflow: "ship", totalStages: 7 });
		expect(getLane("run-1")?.status).toBe("completed"); // retained, not deleted
		expect(REAL_UI.notify).toHaveBeenCalledWith(expect.stringContaining("finished"), "info");
	});

	it("completed → paints the bar full (visited = totalStages) so a finished run isn't frozen below 100%", async () => {
		const b = await register();
		recordRun("run-1", "carve");
		const ctx = { runId: "run-1", totalStages: 4 };
		// A successful path that skips a branch-exclusive stage: 3 distinct of 4
		// visited (the carve 13/14 shape). The last live snapshot caps below 100%.
		b.onStageStart?.({ stageNumber: 1, name: "slice" }, ctx);
		b.onStageStart?.({ stageNumber: 2, name: "elaborate" }, ctx);
		b.onStageStart?.({ stageNumber: 3, name: "commit" }, ctx);
		expect(getLane("run-1")?.progress?.visited).toBe(3); // frozen below total pre-end

		b.onWorkflowEnd?.(
			{ termination: { status: "completed" } },
			{ runId: "run-1", workflow: "carve", totalStages: 4 },
		);

		// Bar painted full on completion; the terminal stage name is preserved.
		expect(getLane("run-1")?.progress).toMatchObject({ visited: 4, totalStages: 4, stageName: "commit" });
		expect(getLane("run-1")?.status).toBe("completed");
	});

	it("failed → leaves the last real snapshot frozen (does NOT paint the bar full)", async () => {
		const b = await register();
		recordRun("run-1", "carve");
		const ctx = { runId: "run-1", totalStages: 4 };
		b.onStageStart?.({ stageNumber: 1, name: "slice" }, ctx);
		b.onStageError?.({ stageNumber: 2, name: "elaborate" }, "boom", ctx); // visited 2, phase error

		b.onWorkflowEnd?.({ termination: { status: "failed" } }, { runId: "run-1", workflow: "carve", totalStages: 4 });

		// A failed row stays frozen at the stage that died — NOT bumped to 4/4.
		expect(getLane("run-1")?.progress).toMatchObject({ visited: 2, phase: "error", stageName: "elaborate" });
		expect(getLane("run-1")?.status).toBe("failed");
	});

	it("failed → status failed + an error toast", async () => {
		await captureUi(REAL_UI);
		const b = await register();
		recordRun("run-1", "ship");
		b.onWorkflowEnd?.({ termination: { status: "failed" } }, { runId: "run-1", workflow: "ship", totalStages: 7 });
		expect(getLane("run-1")?.status).toBe("failed");
		expect(REAL_UI.notify).toHaveBeenCalledWith(expect.stringContaining("failed"), "error");
	});

	it("failed → retains termination.error on the lane + injects the short reason into the toast (Problem 1)", async () => {
		await captureUi(REAL_UI);
		const b = await register();
		recordRun("run-1", "ship");
		b.onWorkflowEnd?.(
			{ termination: { status: "failed", error: "blueprint produced no plan artifact — stopping workflow" } },
			{ runId: "run-1", workflow: "ship", totalStages: 7 },
		);
		// The full cause is retained on the lane (dock chip + viewer header read it).
		expect(getLane("run-1")?.error).toBe("blueprint produced no plan artifact — stopping workflow");
		// The toast carries the trimmed leading clause so the user learns WHY without opening the lane.
		expect(REAL_UI.notify).toHaveBeenCalledWith(
			expect.stringContaining("failed: blueprint produced no plan artifact"),
			"error",
		);
	});

	it("aborted → status aborted + a warning toast", async () => {
		await captureUi(REAL_UI);
		const b = await register();
		recordRun("run-1", "ship");
		b.onWorkflowEnd?.({ termination: { status: "aborted" } }, { runId: "run-1", workflow: "ship", totalStages: 7 });
		expect(getLane("run-1")?.status).toBe("aborted");
		expect(REAL_UI.notify).toHaveBeenCalledWith(expect.stringContaining("aborted"), "warning");
	});

	it("still-running / missing termination → no retirement, no toast", async () => {
		await captureUi(REAL_UI);
		const b = await register();
		recordRun("run-1", "ship");
		b.onWorkflowEnd?.({ termination: { status: "running" } }, { runId: "run-1", workflow: "ship", totalStages: 7 });
		b.onWorkflowEnd?.({}, { runId: "run-1", workflow: "ship", totalStages: 7 });
		expect(getLane("run-1")?.status).toBe("running");
		expect(REAL_UI.notify).not.toHaveBeenCalled();
	});
});

describe("clean-install degradation", () => {
	afterEach(() => {
		vi.doUnmock("@juicesharp/rpiv-workflow/startup");
		vi.resetModules();
	});

	it("no-ops without throwing when the rpiv-workflow sibling is absent", async () => {
		vi.resetModules();
		vi.doMock("@juicesharp/rpiv-workflow/startup", () => {
			throw Object.assign(new Error("Cannot find package '@juicesharp/rpiv-workflow/startup'"), {
				code: "ERR_MODULE_NOT_FOUND",
			});
		});
		// Re-import the bridge so its internal dynamic import resolves the throwing mock.
		const fresh = await import("./lane-progress.js");
		fresh.__resetLaneProgress(); // ensure the process-global guard is clear
		await expect(fresh.registerLaneProgress()).resolves.toBeUndefined();
	});
});
