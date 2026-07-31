import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AuditContext,
	decorateStage,
	failAuditWrite,
	recordCancellation,
	recordFatalFailure,
	recordUnitHalt,
	unitRowFields,
} from "./audit.js";
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
// recordFatalFailure — the failure row's append is checked: a dropped
// failure row makes the trail's tail read "completed", so a later resume would
// route onward past the stage that actually failed.
// ---------------------------------------------------------------------------

describe("recordFatalFailure", () => {
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
		failureMemos: [],
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

	const auditFor = (cwd: string, state: RunState): AuditContext => ({
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

		await recordFatalFailure(ctx, auditFor(tmpDir, state), {
			status: "failed",
			notifyMsg: "boom",
			notifyLevel: "error",
			errMsg: "build failed",
		});

		expect(readAllStages(tmpDir, "run-1").map((r) => r.status)).toEqual(["failed"]);
		expect(state.telemetry.droppedFailureRows).toEqual([]);
		expect(notifications.map((n) => n.msg)).toEqual(["boom"]);
		// the discriminated outcome lands whole — status + error together.
		expect(state.termination).toEqual({ status: "failed", error: "build failed" });
	});

	it("records user cancellation as a first-class outcome — no error-string sniffing", () => {
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

	it("records an aborted outcome as its own termination status", async () => {
		const { ctx } = makeCtx();
		const state = freshState();

		await recordFatalFailure(ctx, auditFor(tmpDir, state), {
			status: "aborted",
			notifyMsg: "stopped",
			notifyLevel: "warning",
			errMsg: "workflow aborted at build",
		});

		expect(state.termination).toEqual({ status: "aborted", error: "workflow aborted at build" });
	});

	it("surfaces a dropped failure-row append: warning notify + telemetry entry", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { ctx, notifications } = makeCtx();
			const state = freshState();

			await recordFatalFailure(ctx, auditFor("/dev/null/impossible", state), {
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

	it("recordCancellation surfaces a dropped row — the guard now fires before terminate", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { ctx, notifications } = makeCtx();
			const state = freshState();

			recordCancellation(ctx, auditFor("/dev/null/impossible", state));

			// The dropped-row guard now fires for recordCancellation too (it was
			// the only one of the three writers that skipped it).
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

// ---------------------------------------------------------------------------
// Failure-memo propagation — the two terminal writers hook
// `appendFailureMemo`; cancellation + audit-write halts do NOT.
// ---------------------------------------------------------------------------

describe("failure-memo propagation", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-workflow-audit-memo-"));
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
		failureMemos: [],
		termination: { status: "running" },
	});

	const makeCtx = () => {
		const notifications: Array<{ msg: string; level: string }> = [];
		const ctx = {
			cwd: tmpDir,
			ui: { notify: (msg: string, level: string) => notifications.push({ msg, level }) },
		} as unknown as WorkflowHostContext;
		return { ctx, notifications };
	};

	const auditFor = (state: RunState, unit?: UnitRef): AuditContext => ({
		session: null,
		cwd: tmpDir,
		runId: "run-1",
		state,
		stageName: unit ? `${unit.parent} (${unit.label})` : "build",
		skill: "build",
		lifecycle: new LifecycleDispatcher(undefined),
		runIdentity: { workflow: "wf", totalStages: 2, trigger: { kind: "programmatic" } },
		...(unit ? { unit } : {}),
	});

	it("recordFatalFailure appends exactly ONE memo whose errMsg matches the row", async () => {
		const { ctx } = makeCtx();
		const state = freshState();

		await recordFatalFailure(ctx, auditFor(state), {
			status: "failed",
			notifyMsg: "boom",
			notifyLevel: "error",
			errMsg: "build failed",
		});

		expect(state.failureMemos).toHaveLength(1);
		expect(state.failureMemos[0]).toMatchObject({ stage: "build", errMsg: "build failed" });
	});

	it("the first-failure-wins guard prevents a duplicate memo under parallel failFast", async () => {
		const { ctx } = makeCtx();
		const state = freshState();
		const audit = auditFor(state);

		await recordFatalFailure(ctx, audit, {
			status: "failed",
			notifyMsg: "first",
			notifyLevel: "error",
			errMsg: "first failure",
		});
		// A second sibling reaches the writer near-simultaneously — termination is
		// no longer "running", so the first-failure-wins guard returns early BEFORE
		// recordFailureRow + appendFailureMemo. The memo list stays at one entry.
		await recordFatalFailure(ctx, audit, {
			status: "failed",
			notifyMsg: "second",
			notifyLevel: "error",
			errMsg: "second failure",
		});

		expect(state.failureMemos).toHaveLength(1);
		expect(state.failureMemos[0]!.errMsg).toBe("first failure");
	});

	it("recordUnitHalt (collect-all soft-halt) appends a memo with stage = parent + unitId", () => {
		const { ctx } = makeCtx();
		const state = freshState();
		const unit: UnitRef = { parent: "implement", role: "produce", index: 1, id: "phase-2", label: "phase 2/5" };

		recordUnitHalt(ctx, auditFor(state, unit), "compile error");

		expect(state.failureMemos).toHaveLength(1);
		expect(state.failureMemos[0]).toMatchObject({
			stage: "implement", // parent (machine identity), not the decorated stageName
			unitId: "phase-2",
			errMsg: "compile error",
		});
	});

	it("recordCancellation does NOT append a memo", () => {
		const { ctx } = makeCtx();
		const state = freshState();

		recordCancellation(ctx, auditFor(state));

		expect(state.failureMemos).toEqual([]); // cancellation is not a repeatable stage/unit failure
	});

	it("failAuditWrite does NOT append a memo", () => {
		const { ctx } = makeCtx();
		const state = freshState();

		failAuditWrite(ctx, state, "build");

		expect(state.failureMemos).toEqual([]); // a dropped success row is not a stage/unit failure either
	});
});
