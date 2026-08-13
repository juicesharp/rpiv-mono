/**
 * lane-progress tests — the root-gated lifecycle→registry bridge.
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
const summarizeRun = vi.fn();
vi.mock("@juicesharp/rpiv-workflow/startup", () => ({ registerLifecycle, summarizeRun }));

import { __resetLaneProgress, registerLaneProgressHook } from "./lane-progress.js";
import { createLaneRelayUiContext } from "./lane-relay-ui.js";
import {
	__resetRunLaneRegistry,
	getLane,
	getUnit,
	recordRun,
	retireRun,
	SINGLE_UNIT_KEY,
} from "./run-lane-registry.js";
import { __resetSessionCaptureState, registerSessionCapture } from "./session-capture.js";

/** Loose projection of the listener bundle — enough to drive the events under test. */
interface Bundle {
	onWorkflowStart?: (ctx: { runId: string; state?: object; totalStages: number }) => void;
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
	onUnitHalt?: (
		stage: { stageNumber: number; name: string },
		unit: { index: number; label?: string },
		reason: string,
		ctx: { runId: string; totalStages: number },
	) => void;
	onWorkflowEnd?: (
		result: { termination?: { status: string; error?: string } },
		ctx: { runId: string; workflow: string; cwd?: string; state?: object; totalStages: number },
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
 *  the onWorkflowEnd toast fires on the captured launcher UI. */
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
	summarizeRun.mockClear();
	summarizeRun.mockReturnValue(undefined); // reset to no-recap default each test
	(REAL_UI.notify as ReturnType<typeof vi.fn>).mockClear();
	__resetRunLaneRegistry();
	__resetLaneProgress();
	__resetSessionCaptureState();
});
afterEach(() => {
	__resetLaneProgress();
	vi.restoreAllMocks();
});

describe("registerLaneProgressHook", () => {
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

	it("is idempotent under CONCURRENT session_start fires — an overlap inside the import window does not stack a duplicate listener", async () => {
		const { pi, sessionStart } = makePi();
		registerLaneProgressHook(pi);
		// Fire both WITHOUT awaiting between them: the first suspends at the bridge's
		// dynamic import with the guard sentinel already claimed; the second must
		// short-circuit on it. Before the synchronous claim this was a TOCTOU window —
		// the second fire passed the stale guard read and stacked a second listener.
		await Promise.all([
			sessionStart()!({}, { hasUI: true, ui: REAL_UI }),
			sessionStart()!({}, { hasUI: true, ui: REAL_UI }),
		]);
		// Count BOTH seams: two imports racing through vitest's mock layer can
		// resolve one mocked and one REAL rpiv-workflow/startup module, so a
		// stacked registration may land in the real Symbol.for lifecycle registry
		// instead of the `registerLifecycle` mock. Total registrations must be 1.
		const realRegistry = (globalThis as Record<symbol, unknown>)[Symbol.for("@juicesharp/rpiv-workflow:lifecycle")] as
			| unknown[]
			| undefined;
		expect(registerLifecycle.mock.calls.length + (realRegistry?.length ?? 0)).toBe(1);
	});
});

describe("lane-progress event mapping", () => {
	async function register(): Promise<Bundle> {
		const { pi, sessionStart } = makePi();
		registerLaneProgressHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		return bundle();
	}

	it("onStageStart → setLaneProgress with stageName", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		b.onStageStart?.({ stageNumber: 3, name: "plan-layers" }, { runId: "run-1", totalStages: 7 });
		expect(getLane("run-1")?.progress).toMatchObject({
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

	it("onStageError carries the failure reason onto progress", async () => {
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

		b.onLoopStart?.(stage, { kind: "fanout", units: [{}, {}, {}] }, ctx);
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

describe("pull-loop units.total contract (units field is fanout-only)", () => {
	async function register(): Promise<Bundle> {
		const { pi, sessionStart } = makePi();
		registerLaneProgressHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		return bundle();
	}

	it("iterate loop: units stays undefined across onUnitEnd (the 1/1 → 2/1 → 3/1 inversion is gone)", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		const ctx = { runId: "run-1", totalStages: 4 };
		const stage = { stageNumber: 2, name: "iterate" };
		// A pull loop carries no precomputed unit list → onLoopStart seeds units: undefined.
		b.onLoopStart?.(stage, { kind: "iterate" }, ctx);
		expect(getLane("run-1")?.progress?.units).toBeUndefined();

		// Pre-fix: onUnitEnd keyed total off `unit.index + 1` (0+1=1), then froze total
		// at 1 while done climbed 1→2→3 — rendering "1/1" → "2/1" → "3/1". Now the
		// fanoutRuns gate drops units entirely for a pull loop → the dock omits the segment.
		b.onUnitStart?.(stage, { index: 0, label: "round 1" }, ctx);
		b.onUnitEnd?.(stage, { index: 0 }, {}, ctx);
		expect(getLane("run-1")?.progress?.units).toBeUndefined();

		b.onUnitStart?.(stage, { index: 1, label: "round 2" }, ctx);
		b.onUnitEnd?.(stage, { index: 1 }, {}, ctx);
		expect(getLane("run-1")?.progress?.units).toBeUndefined();

		b.onUnitEnd?.(stage, { index: 2 }, {}, ctx);
		expect(getLane("run-1")?.progress?.units).toBeUndefined();
	});

	it("assess loop: units stays undefined across onUnitEnd", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		const ctx = { runId: "run-1", totalStages: 4 };
		const stage = { stageNumber: 2, name: "assess" };
		b.onLoopStart?.(stage, { kind: "assess" }, ctx);
		b.onUnitEnd?.(stage, { index: 0 }, {}, ctx);
		b.onUnitEnd?.(stage, { index: 1 }, {}, ctx);
		expect(getLane("run-1")?.progress?.units).toBeUndefined();
	});

	it("verify loop: units stays undefined across onUnitEnd (all pull-loop kinds omit identically)", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		const ctx = { runId: "run-1", totalStages: 4 };
		const stage = { stageNumber: 2, name: "verify" };
		b.onLoopStart?.(stage, { kind: "verify" }, ctx);
		b.onUnitEnd?.(stage, { index: 0 }, {}, ctx);
		b.onUnitEnd?.(stage, { index: 1 }, {}, ctx);
		expect(getLane("run-1")?.progress?.units).toBeUndefined();
	});

	it("fanout (contrast): seeds {done:0,total:N} and advances done monotonically while total stays N", async () => {
		const b = await register();
		recordRun("run-1", "build");
		const ctx = { runId: "run-1", totalStages: 4 };
		const stage = { stageNumber: 2, name: "design" };
		b.onLoopStart?.(stage, { kind: "fanout", units: [{}, {}, {}] }, ctx);
		expect(getLane("run-1")?.progress?.units).toEqual({ done: 0, total: 3 });

		// Out-of-order completion (2, then 0, then 1): done climbs 1→2→3; total frozen at
		// 3. The inverted "2/1" never appears on the fanout path (prev.total is seeded).
		b.onUnitEnd?.(stage, { index: 2 }, {}, ctx);
		expect(getLane("run-1")?.progress?.units).toEqual({ done: 1, total: 3 });
		b.onUnitEnd?.(stage, { index: 0 }, {}, ctx);
		expect(getLane("run-1")?.progress?.units).toEqual({ done: 2, total: 3 });
		b.onUnitEnd?.(stage, { index: 1 }, {}, ctx);
		expect(getLane("run-1")?.progress?.units).toEqual({ done: 3, total: 3 });
	});
});

describe("per-unit sub-rows — onUnitStart/onUnitEnd lifecycle", () => {
	async function register(): Promise<Bundle> {
		const { pi, sessionStart } = makePi();
		registerLaneProgressHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		return bundle();
	}

	it("onUnitStart materializes a per-unit sub-row (label + running) for fan-out units", async () => {
		const b = await register();
		recordRun("run-1", "build");
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
		recordRun("run-1", "build");
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
		recordRun("run-1", "build");
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
		recordRun("run-1", "build");
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
		recordRun("run-1", "build");
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
		recordRun("run-1", "build");
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
		recordRun("run-1", "build");
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

	it("onUnitHalt — a collect-all soft-halted unit reads ✗ and SURVIVES a completed run's onWorkflowEnd sweep (not painted ✓)", async () => {
		const b = await register();
		recordRun("run-1", "build");
		const ctx = { runId: "run-1", workflow: "build", totalStages: 4 };
		const stage = { stageNumber: 2, name: "design" };
		b.onLoopStart?.(stage, { kind: "fanout", units: [{}, {}] }, ctx);
		b.onUnitStart?.(stage, { index: 0, label: "p0" }, ctx);
		b.onUnitStart?.(stage, { index: 1, label: "p1" }, ctx);

		// Unit 1 soft-halts (collect-all): the run survives, so it fires onUnitHalt — NOT onUnitEnd
		// (success) and NOT onStageError (terminal). Its sub-row flips ✗ immediately.
		b.onUnitHalt?.(stage, { index: 1 }, "slice blew up", ctx);
		expect(getUnit("run-1", 1)?.status).toBe("failed");
		expect(getUnit("run-1", 0)?.status).toBe("running"); // sibling unaffected

		// The run completes overall. Pre-fix the unit stayed "running" through here and the
		// `status === "completed" ? "done"` sweep painted it ✓ — a failed unit shown as success.
		// Now it is already terminal, so the sweep (which touches only still-"running" rows) leaves it ✗.
		b.onWorkflowEnd?.({ termination: { status: "completed" } }, ctx);
		expect(getUnit("run-1", 1)?.status).toBe("failed"); // stays ✗ — NOT swept to ✓
		expect(getUnit("run-1", 0)?.status).toBe("done"); // the genuinely-running sibling resolves ✓
	});

	it("onUnitHalt — the fanoutRuns gate drops it for a non-fanout loop (no stray sub-row)", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		const ctx = { runId: "run-1", totalStages: 4 };
		const stage = { stageNumber: 2, name: "iterate" };
		b.onLoopStart?.(stage, { kind: "iterate" }, ctx); // non-fanout — gate stays off
		b.onUnitHalt?.(stage, { index: 0 }, "halted", ctx);
		expect(getUnit("run-1", 0)).toBeUndefined();
	});

	it("orphan sweep — onWorkflowEnd (abort) flips every still-running sub-row terminal before retiring", async () => {
		const b = await register();
		recordRun("run-1", "build");
		const ctx = { runId: "run-1", workflow: "build", totalStages: 4 };
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

describe("onLoopStart pending seed (fanout vs pull loops)", () => {
	async function register(): Promise<Bundle> {
		const { pi, sessionStart } = makePi();
		registerLaneProgressHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		return bundle();
	}

	it("a fanout onLoopStart with info.units seeds a PENDING sub-row per unit", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		const ctx = { runId: "run-1", totalStages: 4 };
		b.onLoopStart?.({ stageNumber: 2, name: "design" }, { kind: "fanout", units: [{}, {}, {}] }, ctx);
		expect([0, 1, 2].map((i) => getUnit("run-1", i)?.status)).toEqual(["pending", "pending", "pending"]);
	});

	it("a pull loop (iterate/assess) with no info.units seeds ZERO pending rows", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		const ctx = { runId: "run-1", totalStages: 4 };
		b.onLoopStart?.({ stageNumber: 2, name: "iterate" }, { kind: "iterate" }, ctx);
		b.onLoopStart?.({ stageNumber: 3, name: "assess" }, { kind: "assess" }, ctx);
		expect(getUnit("run-1", 0)).toBeUndefined();
		expect(getUnit("run-1", 1)).toBeUndefined();
	});

	it("seed key matches onUnitStart's index under out-of-order dispatch (no stranded pending row)", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		const ctx = { runId: "run-1", totalStages: 4 };
		const stage = { stageNumber: 2, name: "design" };
		b.onLoopStart?.(stage, { kind: "fanout", units: [{}, {}, {}] }, ctx);
		// Units dispatch OUT of declared order under maxConcurrency > 1 (2, then 0).
		// Each flips the row seeded from ITS OWN index — no pending row is stranded.
		b.onUnitStart?.(stage, { index: 2, label: "phase 3/3" }, ctx);
		b.onUnitStart?.(stage, { index: 0, label: "phase 1/3" }, ctx);
		expect(getUnit("run-1", 2)?.status).toBe("running");
		expect(getUnit("run-1", 0)?.status).toBe("running");
		expect(getUnit("run-1", 1)?.status).toBe("pending"); // not yet dispatched
		b.onUnitStart?.(stage, { index: 1, label: "phase 2/3" }, ctx);
		expect(getUnit("run-1", 1)?.status).toBe("running");
	});

	it("a new fanout generation clears the prior pending seed and reseeds (clear → seed)", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		const ctx = { runId: "run-1", totalStages: 6 };
		b.onLoopStart?.({ stageNumber: 2, name: "design" }, { kind: "fanout", units: [{}, {}, {}] }, ctx);
		expect(getUnit("run-1", 2)?.status).toBe("pending");
		// Second generation — fewer units; the prior seed is cleared and a new one laid down.
		b.onLoopStart?.({ stageNumber: 5, name: "refine" }, { kind: "fanout", units: [{}, {}] }, ctx);
		expect(getUnit("run-1", 2)).toBeUndefined(); // prior generation's index 2 gone
		expect(getUnit("run-1", 0)?.status).toBe("pending");
		expect(getUnit("run-1", 1)?.status).toBe("pending");
	});
});

describe("onWorkflowEnd — terminal retention + completion toast", () => {
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

	it("completed termination whose recap reads 'stopped' → warning toast with the stop reason, not the ✓ success line", async () => {
		// A stop-on-fail gate routes to "stop": the runner terminates "completed",
		// but the recap refines it to "stopped" — the toast must carry the reason
		// instead of misreporting success.
		await captureUi(REAL_UI);
		const b = await register();
		recordRun("run-1", "ship");
		summarizeRun.mockReturnValue({
			outcome: "stopped",
			artifacts: [],
			failureReason: "stopped at grade: completeness failed (medium)",
		});
		b.onWorkflowEnd?.({ termination: { status: "completed" } }, { runId: "run-1", workflow: "ship", totalStages: 7 });
		expect(REAL_UI.notify).toHaveBeenCalledWith(
			expect.stringContaining("stopped at grade: completeness failed (medium)"),
			"warning",
		);
		expect(REAL_UI.notify).not.toHaveBeenCalledWith(expect.stringContaining("finished"), "info");
		expect(getLane("run-1")?.status).toBe("completed"); // lane status untouched — only the toast + recap refine
	});

	it("completed → preserves the terminal stage's last snapshot", async () => {
		const b = await register();
		recordRun("run-1", "build");
		const ctx = { runId: "run-1", totalStages: 4 };
		b.onStageStart?.({ stageNumber: 1, name: "slice" }, ctx);
		b.onStageStart?.({ stageNumber: 2, name: "code" }, ctx);
		b.onStageStart?.({ stageNumber: 3, name: "commit" }, ctx);

		b.onWorkflowEnd?.(
			{ termination: { status: "completed" } },
			{ runId: "run-1", workflow: "build", totalStages: 4 },
		);

		expect(getLane("run-1")?.progress).toMatchObject({ stageName: "commit" });
		expect(getLane("run-1")?.status).toBe("completed");
	});

	it("failed → leaves the last real snapshot frozen at the stage that died", async () => {
		const b = await register();
		recordRun("run-1", "build");
		const ctx = { runId: "run-1", totalStages: 4 };
		b.onStageStart?.({ stageNumber: 1, name: "slice" }, ctx);
		b.onStageError?.({ stageNumber: 2, name: "code" }, "boom", ctx);

		b.onWorkflowEnd?.({ termination: { status: "failed" } }, { runId: "run-1", workflow: "build", totalStages: 4 });

		expect(getLane("run-1")?.progress).toMatchObject({ phase: "error", stageName: "code" });
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

	it("failed → retains termination.error on the lane + injects the short reason into the toast", async () => {
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

describe("onWorkflowEnd — recap threading (summarizeRun → single-source setRecap)", () => {
	async function register(): Promise<Bundle> {
		const { pi, sessionStart } = makePi();
		registerLaneProgressHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		return bundle();
	}

	it("computes summarizeRun(ctx.cwd, ctx.runId) and threads the recap onto the lane", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		const recap = { outcome: "completed", artifacts: [".rpiv/artifacts/builds/ship.md"] };
		summarizeRun.mockReturnValue(recap);
		b.onWorkflowEnd?.(
			{ termination: { status: "completed" } },
			{
				runId: "run-1",
				workflow: "ship",
				cwd: "/work",
				totalStages: 7,
			},
		);
		expect(summarizeRun).toHaveBeenCalledWith("/work", "run-1");
		expect(getLane("run-1")?.recap).toBe(recap); // stored via setRecap (the sole writer)
	});

	it("retireRun is called UNCONDITIONALLY — a run whose recap resolved to undefined still retires", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		summarizeRun.mockReturnValue(undefined); // fail-soft: missing/empty trail
		b.onWorkflowEnd?.(
			{ termination: { status: "completed" } },
			{
				runId: "run-1",
				workflow: "ship",
				cwd: "/work",
				totalStages: 7,
			},
		);
		expect(getLane("run-1")?.status).toBe("completed"); // retired despite no recap
		expect(getLane("run-1")?.recap).toBeUndefined(); // no recap stored (setRecap gated on recap !== undefined)
	});

	it("abort-first: a lane already retired to 'aborted' still lands its recap via the sole setRecap", async () => {
		// The x-key stopSelected path (lane-console.ts) retires the lane to "aborted" while
		// the run is still in-flight; when onWorkflowEnd later fires, retireRun is a
		// first-retire-wins no-op on the already-terminal lane — so the recap lands solely
		// via the trailing setRecap, the single recap writer.
		const b = await register();
		recordRun("run-1", "ship");
		retireRun("run-1", "aborted"); // the x-key path retires first
		expect(getLane("run-1")?.status).toBe("aborted");

		const recap = { outcome: "aborted", artifacts: [] };
		summarizeRun.mockReturnValue(recap);
		b.onWorkflowEnd?.(
			{ termination: { status: "aborted" } },
			{
				runId: "run-1",
				workflow: "ship",
				cwd: "/work",
				totalStages: 7,
			},
		);
		// retireRun no-ops on the already-terminal lane (and never touches recap), so the
		// recap landing proves setRecap wrote it.
		expect(getLane("run-1")?.status).toBe("aborted"); // first status held
		expect(getLane("run-1")?.recap).toBe(recap); // setRecap wrote it regardless of terminal status
	});
});

describe("onWorkflowEnd — run-instance guard (resume race)", () => {
	async function register(): Promise<Bundle> {
		const { pi, sessionStart } = makePi();
		registerLaneProgressHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		return bundle();
	}

	it("a stale predecessor onWorkflowEnd does NOT re-retire or re-cap the resumed lane", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		const ctx = { runId: "run-1", workflow: "ship", totalStages: 4 };
		// Predecessor run starts: its ctx.state (statePred) is captured as the active instance.
		const statePred = {};
		b.onWorkflowStart?.({ ...ctx, state: statePred });
		// Predecessor is aborted via the x-key stopSelected path — retireRun stamps the lane
		// "aborted" while the run is still in-flight, so its terminal onWorkflowEnd is still
		// queued on the event loop (it has NOT fired yet).
		retireRun("run-1", "aborted");
		expect(getLane("run-1")?.status).toBe("aborted");

		// Resume: recordRun reactivation flips the lane back to "running" and clears its recap,
		// which RE-ARMS retireRun's first-retire-wins gate (entry.status === "running" again).
		recordRun("run-1", "ship");
		expect(getLane("run-1")?.status).toBe("running");

		// Resumed run starts: reconstructState handed it a FRESH ctx.state (stateResumed),
		// which overwrites the captured instance for this (reused) runId.
		const stateResumed = {};
		b.onWorkflowStart?.({ ...ctx, state: stateResumed });

		// The predecessor's LATE terminal onWorkflowEnd finally fires, still carrying its OWN
		// stale ctx.state (statePred). Pre-guard this passed both the status check and retireRun's
		// re-armed gate and re-stamped the resumed lane "aborted" + re-capped it. Now the instance
		// guard sees the recorded instance (stateResumed) differ from the event's ctx.state
		// (statePred) and drops it.
		summarizeRun.mockReturnValue({ outcome: "aborted", artifacts: [] });
		b.onWorkflowEnd?.({ termination: { status: "aborted" } }, { ...ctx, state: statePred });
		expect(getLane("run-1")?.status).toBe("running"); // NOT re-retired to the predecessor's "aborted"
		expect(getLane("run-1")?.recap).toBeUndefined(); // NOT re-capped by the stale end
		// The stale end never reached the recap-write region: summarizeRun was not called.
		expect(summarizeRun).not.toHaveBeenCalled();
	});

	it("the resumed run's OWN onWorkflowEnd proceeds (its ctx.state matches the captured instance)", async () => {
		const b = await register();
		recordRun("run-1", "ship");
		const ctx = { runId: "run-1", workflow: "ship", cwd: "/work", totalStages: 4 };
		const statePred = {};
		b.onWorkflowStart?.({ ...ctx, state: statePred });
		retireRun("run-1", "aborted");
		recordRun("run-1", "ship"); // resume reactivation
		const stateResumed = {};
		b.onWorkflowStart?.({ ...ctx, state: stateResumed });

		// The resumed run completes and fires its OWN onWorkflowEnd carrying the SAME ctx.state
		// its onWorkflowStart captured (stateResumed) — the guard matches and proceeds.
		const recap = { outcome: "completed", artifacts: [".rpiv/artifacts/builds/ship.md"] };
		summarizeRun.mockReturnValue(recap);
		b.onWorkflowEnd?.({ termination: { status: "completed" } }, { ...ctx, state: stateResumed });
		expect(getLane("run-1")?.status).toBe("completed"); // retired normally
		expect(getLane("run-1")?.recap).toBe(recap); // recap landed
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
