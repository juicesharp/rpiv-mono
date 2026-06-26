import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuditCtx, decorateStage, recordCancellation, recordTerminalFailure, unitRowFields } from "./audit.js";
import { LifecycleDispatcher } from "./events.js";
import { MSG_FAILURE_ROW_DROPPED, MSG_WORKFLOW_CANCELLED } from "./messages.js";
import { readAllStages } from "./state/index.js";
import type { RunState, UnitRef, WorkflowHostContext } from "./types.js";

describe("decorateStage", () => {
	it("renders a fanout/iterate unit tag as `parent (tag)`", () => {
		expect(decorateStage("implement", "phase-2")).toBe("implement (phase-2)");
	});

	it("renders an assess round/phase tag verbatim", () => {
		expect(decorateStage("breakdown", "r0·judge")).toBe("breakdown (r0·judge)");
	});
});

describe("unitRowFields", () => {
	it("returns {} for a single (non-loop) stage so the spread adds nothing", () => {
		expect(unitRowFields(undefined)).toEqual({});
		// Spreading the empty object into a row leaves the JSON byte-identical.
		expect(JSON.stringify({ stage: "x", ...unitRowFields(undefined) })).toBe(JSON.stringify({ stage: "x" }));
	});

	it("projects a UnitRef into the four structured row fields", () => {
		const unit: UnitRef = { parent: "implement", role: "produce", index: 1, id: "phase-2", label: "phase 2/5" };
		expect(unitRowFields(unit)).toEqual({
			parent: "implement",
			role: "produce",
			unitId: "phase-2",
			unitIndex: 1,
		});
	});

	it("carries an undefined id through (assess units have no stable id)", () => {
		const unit: UnitRef = { parent: "breakdown", role: "judge", index: 0, label: "r0·judge" };
		expect(unitRowFields(unit)).toEqual({
			parent: "breakdown",
			role: "judge",
			unitId: undefined,
			unitIndex: 0,
		});
	});
});

// ---------------------------------------------------------------------------
// recordTerminalFailure — the failure row's append is checked (C6): a dropped
// failure row makes the trail's tail read "completed", so a later resume would
// route onward past the stage that actually failed.
// ---------------------------------------------------------------------------

describe("recordTerminalFailure", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-workflow-audit-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const freshState = (): RunState => ({
		originalInput: "x",
		primaryArtifact: undefined,
		output: undefined,
		named: {},
		stagesCompleted: 0,
		lastAllocatedStageNumber: 0,
		telemetry: { backwardJumps: 0, droppedRoutingRows: [], droppedFailureRows: [] },
		termination: { status: "running" },
	});

	const makeCtx = () => {
		const notifications: Array<{ msg: string; level: string }> = [];
		const ctx = {
			cwd: tmpDir,
			ui: {
				notify: (msg: string, level: string) => notifications.push({ msg, level }),
			},
		} as unknown as WorkflowHostContext;
		return { ctx, notifications };
	};

	const auditFor = (cwd: string, state: RunState): AuditCtx => ({
		session: null,
		cwd,
		runId: "run-1",
		state,
		stageName: "build",
		skill: "build",
		lifecycle: new LifecycleDispatcher(undefined),
		runIdentity: { workflow: "wf", totalStages: 2, trigger: { kind: "programmatic" } },
	});

	it("appends the failure row and leaves droppedFailureRows empty on success", async () => {
		const { ctx, notifications } = makeCtx();
		const state = freshState();

		await recordTerminalFailure(ctx, auditFor(tmpDir, state), {
			status: "failed",
			notifyMsg: "boom",
			notifyLevel: "error",
			errMsg: "build failed",
		});

		expect(readAllStages(tmpDir, "run-1").map((r) => r.status)).toEqual(["failed"]);
		expect(state.telemetry.droppedFailureRows).toEqual([]);
		expect(notifications.map((n) => n.msg)).toEqual(["boom"]);
		// T4: the discriminated outcome lands whole — status + error together.
		expect(state.termination).toEqual({ status: "failed", error: "build failed" });
	});

	it("records user cancellation as a first-class outcome — no error-string sniffing (T4)", () => {
		const { ctx } = makeCtx();
		const state = freshState();

		recordCancellation(ctx, auditFor(tmpDir, state));

		// PIN: the three-way cross-reference for a user-cancellation —
		//   canonical in-memory termination   RunTermination.status: "cancelled"  (types.ts)
		//   frozen on-disk row value           StageStatus: "skipped"              (state/state.ts)
		//   sole writer of a "skipped" row     recordCancellation                  (audit.ts)
		// The canonical name ("cancelled") and the frozen row value ("skipped")
		// differ by design — the row value is a versioned on-disk contract that
		// resume + past-run readers depend on, so it stays "skipped" even though
		// the in-memory outcome is "cancelled". The assertion value below is
		// FROZEN; do not "fix" it to "cancelled".
		expect(state.termination.status).toBe("cancelled");
		expect(state.termination.error).toContain("cancelled by user");
		expect(readAllStages(tmpDir, "run-1").map((r) => r.status)).toEqual(["skipped"]);
	});

	it("records an aborted outcome as its own termination status (T4)", async () => {
		const { ctx } = makeCtx();
		const state = freshState();

		await recordTerminalFailure(ctx, auditFor(tmpDir, state), {
			status: "aborted",
			notifyMsg: "stopped",
			notifyLevel: "warning",
			errMsg: "workflow aborted at build",
		});

		expect(state.termination).toEqual({ status: "aborted", error: "workflow aborted at build" });
	});

	it("surfaces a dropped failure-row append: warning notify + telemetry entry (C6)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { ctx, notifications } = makeCtx();
			const state = freshState();

			await recordTerminalFailure(ctx, auditFor("/dev/null/impossible", state), {
				status: "failed",
				notifyMsg: "boom",
				notifyLevel: "error",
				errMsg: "build failed",
			});

			expect(state.telemetry.droppedFailureRows).toEqual(["build"]);
			expect(notifications).toContainEqual({ msg: MSG_FAILURE_ROW_DROPPED("build"), level: "warning" });
			// The terminal bookkeeping still completes — error recorded, toast shown.
			expect(state.termination.error).toBe("build failed");
			expect(notifications).toContainEqual({ msg: "boom", level: "error" });
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("recordCancellation surfaces a dropped row (A3) — the guard now fires before terminate", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { ctx, notifications } = makeCtx();
			const state = freshState();

			recordCancellation(ctx, auditFor("/dev/null/impossible", state));

			// A3: the dropped-row guard now fires for recordCancellation too (it
			// was the only one of the three writers that skipped it).
			expect(state.telemetry.droppedFailureRows).toEqual(["build"]);
			expect(notifications).toContainEqual({ msg: MSG_FAILURE_ROW_DROPPED("build"), level: "warning" });
			// The cancellation outcome still lands — the guard runs BEFORE terminate().
			expect(state.termination.status).toBe("cancelled");
			expect(notifications).toContainEqual({ msg: MSG_WORKFLOW_CANCELLED, level: "info" });
		} finally {
			warnSpy.mockRestore();
		}
	});
});
