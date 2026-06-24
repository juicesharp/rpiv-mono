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
import { __resetRunLaneRegistry, getLane, recordRun } from "./run-lane-registry.js";
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
		const relay = createLaneRelayUiContext(REAL_UI, "child-run");
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
