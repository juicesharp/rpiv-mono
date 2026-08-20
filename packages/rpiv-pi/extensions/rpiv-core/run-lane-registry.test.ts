import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetQuestionLifecycle, subscribeQuestionLifecycle } from "./question-lifecycle.js";
import {
	__resetRunLaneRegistry,
	addStageUsage,
	captureFinalSnapshot,
	clearUnitLanes,
	dequeueInput,
	enqueueInput,
	evictRun,
	foldStageUsage,
	getFocusedRun,
	getLane,
	getUnit,
	type LaneSession,
	laneCount,
	laneNeedsInput,
	listLanes,
	listLanesForDisplay,
	markUnitDone,
	type PendingInput,
	peekInput,
	recordRun,
	retireRun,
	SINGLE_UNIT_KEY,
	seedPendingUnits,
	setCurrentSession,
	setFocusedRun,
	setLaneAbort,
	setLaneProgress,
	setLaneSessionFile,
	setLaneStatus,
	setRecap,
	setUnitStarted,
	subscribeLanes,
	sweepRunningUnits,
	unitNeedsInput,
} from "./run-lane-registry.js";

/** Minimal LaneSession stub — structural, so the registry needs no real AgentSession. */
function makeSession(sessionId: string): LaneSession {
	return {
		sessionId,
		isStreaming: false,
		sessionManager: { getBranch: () => [], getCwd: () => "/tmp" },
		getToolDefinition: () => undefined,
		getStreamingMessage: () => undefined,
		getUsage: () => undefined,
		subscribe: () => () => {},
	};
}

/** A LaneSession whose getUsage returns a fixed token shape — seeds a unit's
 *  finalUsage via captureFinalSnapshot so unitUsage() reads it. Hoisted to module
 *  scope so both the `stageUsage` and `captureFinalSnapshot` describes can reuse it. */
function makeUsageSession(
	sessionId: string,
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
		cost?: number;
	},
): LaneSession {
	return {
		...makeSession(sessionId),
		getUsage: () => ({ tokens: usage, cost: usage.cost }),
	};
}

/** A PendingInput whose resolver is observable. */
function makePending(): PendingInput & { resolve: ReturnType<typeof vi.fn> } {
	const resolve = vi.fn();
	return {
		factory: (() => ({})) as unknown as PendingInput["factory"],
		options: undefined as unknown as PendingInput["options"],
		resolve,
	};
}

beforeEach(() => {
	__resetRunLaneRegistry();
});

describe("run-lane-registry", () => {
	describe("recordRun", () => {
		it("adds a lane reflected by getLane / listLanes / laneCount", () => {
			recordRun("run-1", "ship");
			const lane = getLane("run-1");
			expect(lane).toMatchObject({ runId: "run-1", name: "ship", status: "running" });
			expect(lane?.units.size).toBe(0); // no unit sub-lanes until a child publishes
			expect(getUnit("run-1", SINGLE_UNIT_KEY)).toBeUndefined();
			expect(laneNeedsInput("run-1")).toBe(false);
			expect(lane?.progress).toBeUndefined();
			expect(listLanes()).toHaveLength(1);
			expect(laneCount()).toBe(1);
		});

		it("updates the name without spawning a duplicate lane", () => {
			recordRun("run-1", "ship");
			recordRun("run-1", "renamed");
			expect(laneCount()).toBe(1);
			expect(getLane("run-1")?.name).toBe("renamed");
		});

		it("REACTIVATES a retained terminal lane on re-record (resume reuses the run id)", () => {
			// A run fails and is retained: terminal status + a transcript snapshot.
			recordRun("run-1", "ship");
			setLaneProgress("run-1", {
				stageName: "build",
				phase: "running",
			});
			setCurrentSession("run-1", SINGLE_UNIT_KEY, {
				...makeSession("s1"),
				sessionManager: { getBranch: () => [{ type: "x" }], getCwd: () => "/tmp" },
			});
			retireRun("run-1", "failed"); // → status "failed", per-unit finalBranch captured
			expect(getLane("run-1")?.status).toBe("failed");
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalBranch).toBeDefined();

			// Resuming re-records the SAME id — the lane must come back to life, not stay failed.
			recordRun("run-1", "ship");
			const lane = getLane("run-1");
			expect(laneCount()).toBe(1);
			expect(lane?.status).toBe("running"); // reactivated, no longer "failed"
			expect(lane?.units.size).toBe(0); // stale per-unit snapshots dropped
			expect(getUnit("run-1", SINGLE_UNIT_KEY)).toBeUndefined();
			expect(lane?.progress).toBeUndefined(); // stale progress cleared
			expect(lane?.needsInputSince).toBeUndefined();
		});

		it("stores workflow + input (lane label inputs)", () => {
			recordRun("run-1", "ship", { workflow: "ship", input: "refactor auth" });
			const lane = getLane("run-1");
			expect(lane?.workflow).toBe("ship");
			expect(lane?.input).toBe("refactor auth");
		});

		it("re-record (resume reactivate) preserves workflow/input when meta is absent", () => {
			recordRun("run-1", "ship", { workflow: "ship", input: "refactor auth" });
			recordRun("run-1", "ship"); // reactivate without meta
			const lane = getLane("run-1");
			expect(lane?.workflow).toBe("ship");
			expect(lane?.input).toBe("refactor auth");
		});

		it("REACTIVATION settles a queued pendingInput with undefined (never strands the child)", () => {
			// Regression: a lane with a queued pending input reactivates via recordRun,
			// and the queued resolver MUST be settled before the units map is cleared,
			// else the child hangs on a dangling resolver across resume. FAILS without the fix.
			recordRun("run-1", "ship");
			const pending = makePending();
			enqueueInput("run-1", SINGLE_UNIT_KEY, pending);
			expect(unitNeedsInput("run-1", SINGLE_UNIT_KEY)).toBe(true);

			recordRun("run-1", "ship"); // reactivate — resume reuses the run id

			expect(pending.resolve).toHaveBeenCalledTimes(1);
			expect(pending.resolve).toHaveBeenCalledWith(undefined);
			// The holding unit is gone after reactivation (units cleared, not rebuilt lazily here).
			expect(getUnit("run-1", SINGLE_UNIT_KEY)).toBeUndefined();
		});

		it("the safe path — retireRun settles the queued input, then recordRun reactivation strands nothing", () => {
			// Guard: pins the terminal-settles-first invariant. In normal operation
			// retireRun always settles before reactivation, so recordRun finds an empty
			// queue and the resolver is never double-resolved. Passes both before and
			// after the defensive fix (documents the real safe path).
			recordRun("run-1", "ship");
			const pending = makePending();
			enqueueInput("run-1", SINGLE_UNIT_KEY, pending);
			retireRun("run-1", "aborted"); // settles the queued resolver first (queue drained)
			expect(pending.resolve).toHaveBeenCalledTimes(1);

			recordRun("run-1", "ship"); // reactivate — nothing left to strand

			// Still settled exactly once — no double-resolve from the reactivation loop.
			expect(pending.resolve).toHaveBeenCalledTimes(1);
			expect(getUnit("run-1", SINGLE_UNIT_KEY)).toBeUndefined();
		});

		it("a LATE park on a retired lane settles immediately instead of stranding (abort races the relay)", () => {
			// The x-key retires a lane while its run is in-flight; abort propagates
			// asynchronously, so the child's relay park can land AFTER retireRun's one
			// settle pass. First-retire-wins means no later settle runs — an accepted
			// park would strand: needs-input clock stamped, `asked` emitted with no
			// paired resolution, warp Blocked badge pinned. FAILS without the status gate.
			const events: string[] = [];
			const offLifecycle = subscribeQuestionLifecycle((e) => events.push(e.kind));
			recordRun("run-1", "ship");
			retireRun("run-1", "aborted"); // x-key optimistic retire, run still in-flight

			const pending = makePending();
			enqueueInput("run-1", SINGLE_UNIT_KEY, pending); // the child's late relay park
			offLifecycle();

			expect(pending.resolve).toHaveBeenCalledTimes(1);
			expect(pending.resolve).toHaveBeenCalledWith(undefined);
			expect(getLane("run-1")?.needsInputSince).toBeUndefined(); // clock not stamped
			expect(unitNeedsInput("run-1", SINGLE_UNIT_KEY)).toBe(false); // nothing queued
			expect(events).toEqual([]); // no `asked` without a park — the badge never pins
		});
	});

	describe("evictRun", () => {
		it("removes the lane and resolves every queued pendingInput with undefined", () => {
			recordRun("run-1", "ship");
			const a = makePending();
			const b = makePending();
			enqueueInput("run-1", SINGLE_UNIT_KEY, a);
			enqueueInput("run-1", SINGLE_UNIT_KEY, b);
			evictRun("run-1");
			expect(getLane("run-1")).toBeUndefined();
			expect(laneCount()).toBe(0);
			expect(a.resolve).toHaveBeenCalledWith(undefined);
			expect(b.resolve).toHaveBeenCalledWith(undefined);
		});

		it("settles EVERY unit's queue across a fan-out lane", () => {
			recordRun("run-1", "ship");
			const a = makePending();
			const b = makePending();
			enqueueInput("run-1", 0, a);
			enqueueInput("run-1", 1, b);
			evictRun("run-1");
			expect(a.resolve).toHaveBeenCalledWith(undefined);
			expect(b.resolve).toHaveBeenCalledWith(undefined);
		});

		it("is a no-op for an unknown id", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			evictRun("nope");
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("retireRun — retain terminal lanes", () => {
		it("retains the lane with terminal status, snapshots the branch, clears the session, settles pending", () => {
			recordRun("run-1", "ship");
			const branch = [{ type: "message" }];
			setCurrentSession("run-1", SINGLE_UNIT_KEY, {
				...makeSession("s1"),
				sessionManager: { getBranch: () => branch, getCwd: () => "/tmp" },
			});
			const p = makePending();
			enqueueInput("run-1", SINGLE_UNIT_KEY, p);
			retireRun("run-1", "completed");
			const lane = getLane("run-1");
			const unit = getUnit("run-1", SINGLE_UNIT_KEY);
			expect(lane).toBeDefined(); // RETAINED, not deleted
			expect(lane?.status).toBe("completed");
			expect(unit?.finalBranch).toBe(branch); // snapshot captured before dropping the session
			expect(unit?.currentSession).toBeUndefined();
			expect(unit?.pendingInput).toHaveLength(0);
			expect(p.resolve).toHaveBeenCalledWith(undefined); // stalled child never hangs
		});

		it("snapshots cwd + per-tool definitions for the toolCall names in the branch", () => {
			recordRun("run-1", "ship");
			const branch = [
				{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } },
				{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "edit" }] } },
			];
			const getToolDefinition = vi.fn((name: string) => ({ name, label: `def:${name}` }));
			setCurrentSession("run-1", SINGLE_UNIT_KEY, {
				...makeSession("s1"),
				sessionManager: { getBranch: () => branch, getCwd: () => "/work/dir" },
				getToolDefinition,
			});
			retireRun("run-1", "completed");
			const unit = getUnit("run-1", SINGLE_UNIT_KEY);
			expect(unit?.finalCwd).toBe("/work/dir");
			expect(unit?.finalToolDefs?.get("bash")).toEqual({ name: "bash", label: "def:bash" });
			expect(unit?.finalToolDefs?.get("edit")).toEqual({ name: "edit", label: "def:edit" });
			// Each distinct tool name resolved exactly once.
			expect(getToolDefinition).toHaveBeenCalledTimes(2);
		});

		it("fail-soft when getBranch throws — leaves finalBranch undefined, still retires", () => {
			recordRun("run-1", "ship");
			setCurrentSession("run-1", SINGLE_UNIT_KEY, {
				...makeSession("s1"),
				sessionManager: {
					getBranch: () => {
						throw new Error("disposed");
					},
					getCwd: () => "/tmp",
				},
			});
			expect(() => retireRun("run-1", "failed")).not.toThrow();
			expect(getLane("run-1")?.status).toBe("failed");
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalBranch).toBeUndefined();
		});

		it("flips a never-ended unit's status terminal (running → done)", () => {
			recordRun("run-1", "ship");
			setUnitStarted("run-1", 0, "phase 1/1"); // running, no onUnitEnd
			retireRun("run-1", "completed");
			expect(getUnit("run-1", 0)?.status).toBe("done");
		});

		it("is a no-op for an unknown id", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			retireRun("nope", "completed");
			expect(listener).not.toHaveBeenCalled();
		});

		it("is idempotent — FIRST retire wins; a second retire preserves the snapshot and status", () => {
			recordRun("run-1", "ship");
			const branch = [{ type: "message" }];
			setCurrentSession("run-1", SINGLE_UNIT_KEY, {
				...makeSession("s1"),
				sessionManager: { getBranch: () => branch, getCwd: () => "/tmp" },
			});
			// First retire (e.g. the manager's optimistic `x` cancel) snapshots the live
			// session and drops it.
			retireRun("run-1", "aborted");
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalBranch).toBe(branch);

			// Second retire (e.g. the runner's later onWorkflowEnd for the same run) must
			// NOT re-snapshot off the now-absent session — that would wipe finalBranch.
			const listener = vi.fn();
			subscribeLanes(listener);
			retireRun("run-1", "completed");
			expect(getLane("run-1")?.status).toBe("aborted"); // first status held
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalBranch).toBe(branch); // transcript preserved
			expect(listener).not.toHaveBeenCalled(); // no spurious notify on the no-op
		});
	});

	describe("retireRun — lastArtifact capture", () => {
		it("captures lastArtifact on a completed retire (runId, status, error?, lastArtifact?)", () => {
			recordRun("run-1", "ship");
			retireRun("run-1", "completed", undefined, ".rpiv/artifacts/builds/ship.md");
			expect(getLane("run-1")?.lastArtifact).toBe(".rpiv/artifacts/builds/ship.md");
		});

		it("is idempotent — a second retire does NOT overwrite lastArtifact (first-retire-wins)", () => {
			// Mirrors the finalBranch preservation guard: the second retire is a no-op
			// (entry.status !== "running"), so a stale onWorkflowEnd can't wipe the path.
			recordRun("run-1", "ship");
			retireRun("run-1", "completed", undefined, ".rpiv/artifacts/builds/ship.md");
			expect(getLane("run-1")?.lastArtifact).toBe(".rpiv/artifacts/builds/ship.md");

			const listener = vi.fn();
			subscribeLanes(listener);
			retireRun("run-1", "completed", undefined, ".rpiv/artifacts/builds/OTHER.md");
			expect(getLane("run-1")?.lastArtifact).toBe(".rpiv/artifacts/builds/ship.md"); // held
			expect(listener).not.toHaveBeenCalled(); // no spurious notify on the no-op
		});

		it("leaves lastArtifact undefined when not supplied (side-effect-only / aborted-run callers)", () => {
			// The aborted-run callers (workflow-execution-host, lane-console) pass ≤3 args,
			// correctly leaving lastArtifact undefined — a side-effect-only completed run
			// has result.lastArtifact === undefined too. Either way no path is retained.
			recordRun("run-1", "ship");
			retireRun("run-1", "completed"); // no lastArtifact arg
			expect(getLane("run-1")?.lastArtifact).toBeUndefined();
		});

		it("recordRun reactivation clears a prior run's lastArtifact (resume never leaks the old path)", () => {
			recordRun("run-1", "ship");
			retireRun("run-1", "completed", undefined, ".rpiv/artifacts/builds/ship.md");
			expect(getLane("run-1")?.lastArtifact).toBe(".rpiv/artifacts/builds/ship.md");

			recordRun("run-1", "ship"); // re-record the SAME id — resume reuses it
			expect(getLane("run-1")?.status).toBe("running"); // reactivated
			expect(getLane("run-1")?.lastArtifact).toBeUndefined(); // stale path cleared
		});
	});

	describe("retireRun — recap NOT stored (single source of truth is setRecap)", () => {
		it("retireRun does NOT store recap — single source of truth is setRecap", () => {
			// retireRun never touches entry.recap — the lane's recap stays undefined
			// through retirement until setRecap, the sole writer, stores it.
			recordRun("run-1", "ship");
			retireRun("run-1", "completed", undefined, ".rpiv/artifacts/builds/ship.md");
			expect(getLane("run-1")?.lastArtifact).toBe(".rpiv/artifacts/builds/ship.md");
			expect(getLane("run-1")?.recap).toBeUndefined(); // retireRun wrote nothing

			const recap = { outcome: "completed" as const, artifacts: [".rpiv/artifacts/builds/ship.md"] };
			setRecap("run-1", recap);
			expect(getLane("run-1")?.recap).toBe(recap); // setRecap is the sole writer
		});

		it("recordRun reactivation clears a prior run's recap (resume never leaks the old recap)", () => {
			recordRun("run-1", "ship");
			retireRun("run-1", "completed"); // terminal lane (the resume scenario)
			const recap = { outcome: "completed" as const, artifacts: [".rpiv/artifacts/builds/ship.md"] };
			setRecap("run-1", recap); // the sole writer
			expect(getLane("run-1")?.recap).toBe(recap);

			recordRun("run-1", "ship"); // re-record the SAME id — resume reuses it
			expect(getLane("run-1")?.status).toBe("running"); // reactivated
			expect(getLane("run-1")?.recap).toBeUndefined(); // stale recap cleared
		});
	});

	describe("setRecap — sole recap writer (ungated by terminal status)", () => {
		it("stores the recap on a RUNNING lane and notifies", () => {
			recordRun("run-1", "ship");
			const listener = vi.fn();
			subscribeLanes(listener);
			const recap = { outcome: "completed" as const, artifacts: [] };
			setRecap("run-1", recap);
			expect(getLane("run-1")?.recap).toBe(recap);
			expect(listener).toHaveBeenCalledTimes(1); // notify → console re-renders
		});

		it("stores the recap on a lane ALREADY retired by an abort path", () => {
			// The x-key stopSelected path (lane-console.ts) retires the lane to "aborted"
			// while the run is still in-flight; when onWorkflowEnd later fires the recap must
			// still land. setRecap is the SOLE recap writer precisely because it writes
			// entry.recap regardless of terminal status — retireRun (which never touches
			// recap) is a first-retire-wins no-op on the already-retired lane.
			recordRun("run-1", "ship");
			retireRun("run-1", "aborted"); // the x-key path — lane flips to "aborted" first
			expect(getLane("run-1")?.status).toBe("aborted");
			expect(getLane("run-1")?.recap).toBeUndefined(); // retireRun never stored a recap

			// setRecap writes regardless of terminal status — the recap lands on the
			// already-retired lane.
			const recap = { outcome: "aborted" as const, artifacts: [] };
			setRecap("run-1", recap);
			expect(getLane("run-1")?.recap).toBe(recap); // stored despite the terminal status
			expect(getLane("run-1")?.status).toBe("aborted"); // status untouched
		});

		it("is a no-op on a missing lane (fail-soft)", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			expect(() => setRecap("nope", { outcome: "completed", artifacts: [] })).not.toThrow();
			expect(listener).not.toHaveBeenCalled();
			expect(getLane("nope")).toBeUndefined();
		});
	});

	describe("finalUsage capture (per-unit token usage)", () => {
		it("captures finalUsage from session.getUsage() via captureFinalSnapshot", () => {
			recordRun("run-1", "ship");
			const stats = {
				tokens: { input: 1500, output: 800, cacheRead: 500, cacheWrite: 200, total: 3000 },
				cost: 0.05,
				contextUsage: { percent: 45.2 },
			};
			const session: LaneSession = {
				...makeSession("s1"),
				getUsage: () => stats,
			};
			captureFinalSnapshot("run-1", SINGLE_UNIT_KEY, session);
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalUsage).toEqual({
				input: 1500,
				output: 800,
				cacheRead: 500,
				cacheWrite: 200,
				total: 3000,
				cost: 0.05,
				percent: 45.2,
			});
		});

		it("leaves finalUsage undefined when getUsage() returns undefined (no stats yet)", () => {
			recordRun("run-1", "ship");
			captureFinalSnapshot("run-1", SINGLE_UNIT_KEY, makeSession("s1"));
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalUsage).toBeUndefined();
		});

		it("fail-soft when getUsage() returns a malformed SessionStats — finalUsage undefined", () => {
			recordRun("run-1", "ship");
			const session: LaneSession = {
				...makeSession("s1"),
				getUsage: () => ({ tokens: "nope" }),
			};
			expect(() => captureFinalSnapshot("run-1", SINGLE_UNIT_KEY, session)).not.toThrow();
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalUsage).toBeUndefined();
		});

		it("isolated fail-soft: a THROWING getUsage leaves finalUsage undefined but finalBranch intact", () => {
			recordRun("run-1", "ship");
			const branch = [{ type: "message" }];
			const session: LaneSession = {
				...makeSession("s1"),
				sessionManager: { getBranch: () => branch, getCwd: () => "/tmp" },
				getUsage: () => {
					throw new Error("session disposed");
				},
			};
			captureFinalSnapshot("run-1", SINGLE_UNIT_KEY, session);
			const unit = getUnit("run-1", SINGLE_UNIT_KEY);
			expect(unit?.finalUsage).toBeUndefined(); // usage failed alone
			expect(unit?.finalBranch).toBe(branch); // transcript survived
			expect(unit?.finalCwd).toBe("/tmp");
		});

		it("retireRun preserves finalUsage — still readable post-retirement", () => {
			recordRun("run-1", "ship");
			const stats = {
				tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
				cost: 0.01,
			};
			setCurrentSession("run-1", SINGLE_UNIT_KEY, {
				...makeSession("s1"),
				sessionManager: { getBranch: () => [{ type: "message" }], getCwd: () => "/tmp" },
				getUsage: () => stats,
			});
			retireRun("run-1", "completed");
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalUsage).toEqual({
				input: 100,
				output: 50,
				cacheRead: 10,
				cacheWrite: 5,
				total: 165,
				cost: 0.01,
			});
		});

		it("the x-cancel fallback path captures partial usage off the still-live currentSession", () => {
			// retireRun's still-attached fallback calls captureSnapshotInto, so an
			// optimistically-cancelled lane captures usage off the live session.
			recordRun("run-1", "ship");
			const stats = {
				tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 },
			};
			setCurrentSession("run-1", SINGLE_UNIT_KEY, {
				...makeSession("s1"),
				sessionManager: { getBranch: () => [{ type: "message" }], getCwd: () => "/tmp" },
				getUsage: () => stats,
			});
			retireRun("run-1", "aborted"); // x-cancel path — session still attached
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalUsage).toEqual({
				input: 7,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				total: 10,
			});
		});
	});

	describe("listLanesForDisplay — priority sort + fan-out flatten", () => {
		it("stable priority sort: needs-input → running → terminal, insertion order within a bucket", () => {
			recordRun("done-1", "a");
			retireRun("done-1", "completed");
			recordRun("run-1", "b"); // running
			recordRun("run-2", "c"); // running, will need input
			enqueueInput("run-2", SINGLE_UNIT_KEY, makePending());
			const order = listLanesForDisplay().map((r) => r.lane.runId);
			expect(order).toEqual(["run-2", "run-1", "done-1"]);
			// listLanes() keeps launch (insertion) order — display sort must not mutate it.
			expect(listLanes().map((l) => l.runId)).toEqual(["done-1", "run-1", "run-2"]);
		});

		it("flattens fan-out unit sub-rows ascending by index directly beneath their lane", () => {
			recordRun("run-1", "ship");
			// Publish out of order — the flatten still sorts ascending by declared index.
			setUnitStarted("run-1", 2, "phase 3/3");
			setUnitStarted("run-1", 0, "phase 1/3");
			setUnitStarted("run-1", 1, "phase 2/3");
			const rows = listLanesForDisplay();
			expect(rows.map((r) => r.kind)).toEqual(["lane", "unit", "unit", "unit"]);
			expect(rows.filter((r) => r.kind === "unit").map((r) => (r.kind === "unit" ? r.unit.index : -9))).toEqual([
				0, 1, 2,
			]);
		});

		it("a single-stage run (sentinel-only) yields exactly one lane row — no sub-rows", () => {
			recordRun("run-1", "ship");
			setCurrentSession("run-1", SINGLE_UNIT_KEY, makeSession("s1")); // writes the sentinel slot
			const rows = listLanesForDisplay();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.kind).toBe("lane");
		});
	});

	describe("setLaneAbort", () => {
		it("stores an abort handle invoked via getLane().abort()", () => {
			recordRun("run-1", "ship");
			const abort = vi.fn();
			setLaneAbort("run-1", abort);
			getLane("run-1")?.abort?.();
			expect(abort).toHaveBeenCalledTimes(1);
		});

		it("is a no-op on a missing lane", () => {
			expect(() => setLaneAbort("nope", vi.fn())).not.toThrow();
		});
	});

	describe("needsInputSince", () => {
		it("stamps on first enqueue, holds across a second enqueue AND a full drain, clears only at retire", () => {
			recordRun("run-1", "ship");
			expect(getLane("run-1")?.needsInputSince).toBeUndefined();
			enqueueInput("run-1", SINGLE_UNIT_KEY, makePending());
			const stamped = getLane("run-1")?.needsInputSince;
			expect(typeof stamped).toBe("number");
			enqueueInput("run-1", SINGLE_UNIT_KEY, makePending()); // second enqueue must not re-stamp
			expect(getLane("run-1")?.needsInputSince).toBe(stamped);
			dequeueInput("run-1", SINGLE_UNIT_KEY); // still one queued → clock holds
			expect(getLane("run-1")?.needsInputSince).toBe(stamped);
			dequeueInput("run-1", SINGLE_UNIT_KEY); // queue FULLY drained → clock STILL holds (continuous-wait marker)
			expect(getLane("run-1")?.needsInputSince).toBe(stamped);
		});

		it("stamps once across DISTINCT units (lane-level clock), not per unit", () => {
			recordRun("run-1", "ship");
			enqueueInput("run-1", 0, makePending());
			const stamped = getLane("run-1")?.needsInputSince;
			enqueueInput("run-1", 1, makePending()); // a sibling unit must not re-stamp the lane clock
			expect(getLane("run-1")?.needsInputSince).toBe(stamped);
		});

		it("a drain→refill keeps the original wait start (no aging-clock reset)", () => {
			recordRun("run-1", "ship");
			enqueueInput("run-1", SINGLE_UNIT_KEY, makePending());
			const stamped = getLane("run-1")?.needsInputSince;
			dequeueInput("run-1", SINGLE_UNIT_KEY); // queue empties during a switch-in drain
			enqueueInput("run-1", SINGLE_UNIT_KEY, makePending()); // a background sibling refills it
			expect(getLane("run-1")?.needsInputSince).toBe(stamped); // age preserved, not reset to "now"
		});

		it("retireRun clears the needs-input clock", () => {
			recordRun("run-1", "ship");
			enqueueInput("run-1", SINGLE_UNIT_KEY, makePending());
			retireRun("run-1", "aborted");
			expect(getLane("run-1")?.needsInputSince).toBeUndefined();
		});
	});

	describe("setLaneSessionFile / lastSessionFile — durable disk-fallback path", () => {
		it("records the durable session-file pointer without notifying", () => {
			recordRun("run-1", "ship");
			const listener = vi.fn();
			subscribeLanes(listener);
			setLaneSessionFile("run-1", SINGLE_UNIT_KEY, "/sessions/run-1.jsonl");
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.lastSessionFile).toBe("/sessions/run-1.jsonl");
			expect(listener).not.toHaveBeenCalled(); // read lazily at disk-fallback time — no redraw
		});

		it("is a no-op when file is undefined (never clears) and on a missing lane", () => {
			recordRun("run-1", "ship");
			setLaneSessionFile("run-1", SINGLE_UNIT_KEY, "/sessions/run-1.jsonl");
			setLaneSessionFile("run-1", SINGLE_UNIT_KEY, undefined); // ignored — does not clear
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.lastSessionFile).toBe("/sessions/run-1.jsonl");
			expect(() => setLaneSessionFile("nope", SINGLE_UNIT_KEY, "/x.jsonl")).not.toThrow();
		});

		it("seeds the pointer on a PER-UNIT key (two units never collide)", () => {
			recordRun("run-1", "ship");
			setLaneSessionFile("run-1", 0, "/sessions/u0.jsonl");
			setLaneSessionFile("run-1", 1, "/sessions/u1.jsonl");
			expect(getUnit("run-1", 0)?.lastSessionFile).toBe("/sessions/u0.jsonl");
			expect(getUnit("run-1", 1)?.lastSessionFile).toBe("/sessions/u1.jsonl");
		});

		it("re-record (resume) drops the prior run's session-file pointer", () => {
			recordRun("run-1", "ship");
			setLaneSessionFile("run-1", SINGLE_UNIT_KEY, "/sessions/run-1.jsonl");
			recordRun("run-1", "ship"); // reactivate — resume reuses the run id
			expect(getUnit("run-1", SINGLE_UNIT_KEY)).toBeUndefined();
		});
	});

	describe("setLaneStatus", () => {
		it("updates the status", () => {
			recordRun("run-1", "ship");
			setLaneStatus("run-1", "failed");
			expect(getLane("run-1")?.status).toBe("failed");
		});

		it("is a no-op (no notify) on a missing lane", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			setLaneStatus("nope", "failed");
			expect(listener).not.toHaveBeenCalled();
		});

		it("is a no-op (no notify) when the status is unchanged", () => {
			recordRun("run-1", "ship");
			const listener = vi.fn();
			subscribeLanes(listener);
			setLaneStatus("run-1", "running");
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("setCurrentSession", () => {
		it("sets, replaces, and clears a unit's currentSession", () => {
			recordRun("run-1", "ship");
			const a = makeSession("a");
			const b = makeSession("b");
			setCurrentSession("run-1", SINGLE_UNIT_KEY, a);
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.currentSession).toBe(a);
			setCurrentSession("run-1", SINGLE_UNIT_KEY, b);
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.currentSession).toBe(b);
			setCurrentSession("run-1", SINGLE_UNIT_KEY, undefined);
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.currentSession).toBeUndefined();
		});

		it("each unit owns its own session slot — a sibling publish never clobbers another", () => {
			recordRun("run-1", "ship");
			const a = makeSession("a");
			const b = makeSession("b");
			setCurrentSession("run-1", 0, a);
			setCurrentSession("run-1", 1, b);
			expect(getUnit("run-1", 0)?.currentSession).toBe(a);
			expect(getUnit("run-1", 1)?.currentSession).toBe(b);
		});

		it("clearing a never-created unit is a no-op (does not resurrect it)", () => {
			recordRun("run-1", "ship");
			setCurrentSession("run-1", 5, undefined);
			expect(getUnit("run-1", 5)).toBeUndefined();
		});

		it("is a no-op when the run isn't recorded", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			expect(() => setCurrentSession("nope", SINGLE_UNIT_KEY, makeSession("a"))).not.toThrow();
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("setUnitStarted / markUnitDone", () => {
		it("upserts a unit with its label + running status, then flips it terminal", () => {
			recordRun("run-1", "ship");
			setUnitStarted("run-1", 0, "phase 1/2");
			const unit = getUnit("run-1", 0);
			expect(unit?.label).toBe("phase 1/2");
			expect(unit?.status).toBe("running");
			markUnitDone("run-1", 0, "done");
			expect(getUnit("run-1", 0)?.status).toBe("done");
		});

		it("markUnitDone is a no-op (no notify) on a missing/unchanged unit", () => {
			recordRun("run-1", "ship");
			setUnitStarted("run-1", 0, "phase 1/1");
			markUnitDone("run-1", 0, "done");
			const listener = vi.fn();
			subscribeLanes(listener);
			markUnitDone("run-1", 0, "done"); // unchanged
			markUnitDone("run-1", 9, "done"); // missing
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("seedPendingUnits — pending fan-out seed", () => {
		it("seeds N pending unit sub-rows keyed by declared array position", () => {
			recordRun("run-1", "ship");
			seedPendingUnits("run-1", [
				{ index: 0, label: "phase 1/3" },
				{ index: 1, label: "phase 2/3" },
				{ index: 2, label: "phase 3/3" },
			]);
			expect([0, 1, 2].map((i) => getUnit("run-1", i)?.status)).toEqual(["pending", "pending", "pending"]);
			expect(getUnit("run-1", 1)?.label).toBe("phase 2/3");
		});

		it("a pending unit flips running on setUnitStarted on the SAME key (the declared index)", () => {
			recordRun("run-1", "ship");
			seedPendingUnits("run-1", [
				{ index: 0, label: "phase 1/2" },
				{ index: 1, label: "phase 2/2" },
			]);
			// onUnitStart dispatches out of order (index 1 first) — each flips its OWN seeded row.
			setUnitStarted("run-1", 1, "phase 2/2");
			expect(getUnit("run-1", 1)?.status).toBe("running");
			expect(getUnit("run-1", 0)?.status).toBe("pending"); // sibling still queued
			setUnitStarted("run-1", 0, "phase 1/2");
			expect(getUnit("run-1", 0)?.status).toBe("running");
		});

		it("sweepRunningUnits flips a never-started pending unit terminal (fail/abort-before-start)", () => {
			recordRun("run-1", "ship");
			seedPendingUnits("run-1", [
				{ index: 0, label: "p0" },
				{ index: 1, label: "p1" },
			]);
			setUnitStarted("run-1", 0, "p0"); // unit 0 running; unit 1 never started
			sweepRunningUnits("run-1", "failed");
			expect(getUnit("run-1", 0)?.status).toBe("failed");
			expect(getUnit("run-1", 1)?.status).toBe("failed"); // pending swept too — no spin
		});

		it("retireRun flips a never-started pending unit terminal (→ done)", () => {
			recordRun("run-1", "ship");
			seedPendingUnits("run-1", [{ index: 0, label: "p0" }]);
			retireRun("run-1", "completed"); // successful run, unit 0 never fired onUnitStart
			expect(getUnit("run-1", 0)?.status).toBe("done"); // pending → done, not stuck spinning
		});

		it("is a no-op on a missing run", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			seedPendingUnits("nope", [{ index: 0, label: "x" }]);
			expect(getLane("nope")).toBeUndefined();
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("setLaneProgress", () => {
		it("sets, updates, and clears progress, notifying each time", () => {
			recordRun("run-1", "ship");
			const listener = vi.fn();
			subscribeLanes(listener);
			setLaneProgress("run-1", { stageName: "plan", phase: "running" });
			expect(getLane("run-1")?.progress).toMatchObject({ stageName: "plan" });
			expect(listener).toHaveBeenCalledTimes(1);
			setLaneProgress("run-1", { stageName: "build", phase: "running" });
			expect(getLane("run-1")?.progress?.stageName).toBe("build");
			expect(listener).toHaveBeenCalledTimes(2);
			setLaneProgress("run-1", undefined);
			expect(getLane("run-1")?.progress).toBeUndefined();
			expect(listener).toHaveBeenCalledTimes(3);
		});

		it("is a no-op (no notify) on an unrecorded run", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			expect(() => setLaneProgress("nope", { stageName: "x", phase: "running" })).not.toThrow();
			expect(listener).not.toHaveBeenCalled();
			expect(getLane("nope")).toBeUndefined();
		});
	});

	describe("enqueueInput / dequeueInput", () => {
		it("queues FIFO on a recorded run and flips laneNeedsInput / unitNeedsInput true", () => {
			recordRun("run-1", "ship");
			expect(laneNeedsInput("run-1")).toBe(false);
			expect(unitNeedsInput("run-1", SINGLE_UNIT_KEY)).toBe(false);
			const a = makePending();
			const b = makePending();
			enqueueInput("run-1", SINGLE_UNIT_KEY, a);
			enqueueInput("run-1", SINGLE_UNIT_KEY, b);
			expect(laneNeedsInput("run-1")).toBe(true);
			expect(unitNeedsInput("run-1", SINGLE_UNIT_KEY)).toBe(true);
			expect(dequeueInput("run-1", SINGLE_UNIT_KEY)).toBe(a);
			expect(dequeueInput("run-1", SINGLE_UNIT_KEY)).toBe(b);
		});

		it("drains only the addressed unit's queue (a sibling unit's queue is untouched)", () => {
			recordRun("run-1", "ship");
			const a = makePending();
			const b = makePending();
			enqueueInput("run-1", 0, a);
			enqueueInput("run-1", 1, b);
			expect(dequeueInput("run-1", 0)).toBe(a);
			expect(unitNeedsInput("run-1", 0)).toBe(false);
			expect(unitNeedsInput("run-1", 1)).toBe(true); // sibling still queued
			expect(laneNeedsInput("run-1")).toBe(true); // lane-level still flags
		});

		it("resolves immediately with undefined on an unrecorded run (never strands the child)", () => {
			const p = makePending();
			enqueueInput("nope", SINGLE_UNIT_KEY, p);
			expect(p.resolve).toHaveBeenCalledWith(undefined);
			expect(getLane("nope")).toBeUndefined();
		});

		it("dequeueInput returns undefined when empty", () => {
			recordRun("run-1", "ship");
			expect(dequeueInput("run-1", SINGLE_UNIT_KEY)).toBeUndefined();
			expect(dequeueInput("nope", SINGLE_UNIT_KEY)).toBeUndefined();
		});

		it("peekInput returns the head without removing it or clearing needs-input", () => {
			recordRun("run-1", "ship");
			const a = makePending();
			const b = makePending();
			enqueueInput("run-1", SINGLE_UNIT_KEY, a);
			enqueueInput("run-1", SINGLE_UNIT_KEY, b);
			expect(peekInput("run-1", SINGLE_UNIT_KEY)).toBe(a); // head
			expect(peekInput("run-1", SINGLE_UNIT_KEY)).toBe(a); // idempotent — not consumed
			expect(unitNeedsInput("run-1", SINGLE_UNIT_KEY)).toBe(true); // still queued
			expect(dequeueInput("run-1", SINGLE_UNIT_KEY)).toBe(a); // dequeue still yields a
			expect(peekInput("run-1", SINGLE_UNIT_KEY)).toBe(b); // head is now b
		});

		it("peekInput returns undefined when empty / missing run (no throw)", () => {
			recordRun("run-1", "ship");
			expect(peekInput("run-1", SINGLE_UNIT_KEY)).toBeUndefined();
			expect(peekInput("nope", SINGLE_UNIT_KEY)).toBeUndefined();
		});

		it("peekInput does not notify (a read never triggers a redraw)", () => {
			recordRun("run-1", "ship");
			enqueueInput("run-1", SINGLE_UNIT_KEY, makePending());
			const listener = vi.fn();
			subscribeLanes(listener);
			peekInput("run-1", SINGLE_UNIT_KEY);
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("subscribeLanes", () => {
		it("fires a listener on each mutation and stops after unsubscribe", () => {
			const listener = vi.fn();
			const unsub = subscribeLanes(listener);
			recordRun("run-1", "ship");
			expect(listener).toHaveBeenCalledTimes(1);
			setLaneStatus("run-1", "failed");
			expect(listener).toHaveBeenCalledTimes(2);
			unsub();
			setLaneStatus("run-1", "completed");
			expect(listener).toHaveBeenCalledTimes(2);
		});

		it("fail-soft notify: a throwing listener neither blocks siblings nor breaks the mutation", () => {
			const sibling = vi.fn();
			subscribeLanes(() => {
				throw new Error("boom");
			});
			subscribeLanes(sibling);
			expect(() => recordRun("run-1", "ship")).not.toThrow();
			expect(sibling).toHaveBeenCalledTimes(1);
			expect(getLane("run-1")).toBeDefined();
		});
	});

	describe("focus accessors", () => {
		it("setFocusedRun / getFocusedRun round-trip", () => {
			expect(getFocusedRun()).toBeUndefined();
			setFocusedRun("run-1");
			expect(getFocusedRun()).toBe("run-1");
			setFocusedRun(undefined);
			expect(getFocusedRun()).toBeUndefined();
		});

		it("focus changes do not trigger notify", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			setFocusedRun("run-1");
			setFocusedRun(undefined);
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("__resetRunLaneRegistry", () => {
		it("clears lanes (and their units map), listeners, and focus", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			recordRun("run-1", "ship");
			setUnitStarted("run-1", 0, "phase 1/1"); // populate the units map
			setFocusedRun("run-1");
			const callsBeforeReset = listener.mock.calls.length;
			__resetRunLaneRegistry();
			expect(laneCount()).toBe(0);
			expect(listLanes()).toEqual([]);
			expect(getUnit("run-1", 0)).toBeUndefined(); // units map gone with the lane
			expect(getFocusedRun()).toBeUndefined();
			// listeners cleared: a post-reset mutation must not call the old listener.
			recordRun("run-2", "build");
			expect(listener.mock.calls.length).toBe(callsBeforeReset);
		});
	});

	// -------------------------------------------------------------------------
	// Process-global slot. A detached child re-loads rpiv-core and may
	// get a SEPARATE module instance; the registry must still be ONE shared store
	// (anchored on globalThis[Symbol.for(...)]) so the launcher and a child see the
	// same lanes.
	// -------------------------------------------------------------------------
	describe("process-global registry", () => {
		it("a fresh module instance reads the SAME registry (shared global slot)", async () => {
			recordRun("g-1", "ship");
			// vi.resetModules() forces the next import to evaluate a FRESH module
			// instance (new module-local closures) — but the globalThis slot persists,
			// so the fresh instance must observe the run recorded via the first.
			vi.resetModules();
			const fresh = await import("./run-lane-registry.js");
			expect(fresh.getLane("g-1")).toBeDefined();
			expect(fresh.listLanes().map((l) => l.runId)).toContain("g-1");
		});
	});

	describe("stageUsage — per-stage token accumulation", () => {
		it("initializes stageUsage on a new lane (empty Map)", () => {
			recordRun("run-1", "ship");
			expect(getLane("run-1")?.stageUsage).toBeInstanceOf(Map);
			expect(getLane("run-1")?.stageUsage.size).toBe(0);
		});

		it("leaves stageUsage intact on resume reactivation (completed stages survive)", () => {
			recordRun("run-1", "ship");
			setLaneProgress("run-1", { stageName: "plan", phase: "running" });
			captureFinalSnapshot(
				"run-1",
				SINGLE_UNIT_KEY,
				makeUsageSession("s1", {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					total: 150,
				}),
			);
			foldStageUsage("run-1");
			expect(getLane("run-1")?.stageUsage.get("plan")?.input).toBe(100);

			// Resume re-records the SAME id — units are cleared but stageUsage survives.
			recordRun("run-1", "ship");
			expect(getLane("run-1")?.status).toBe("running"); // reactivated
			expect(getLane("run-1")?.units.size).toBe(0); // prior units dropped
			expect(getLane("run-1")?.stageUsage.get("plan")?.input).toBe(100); // survived
		});

		it("stageUsage survives retireRun (folded tokens retained after units are gone)", () => {
			recordRun("run-1", "ship");
			setLaneProgress("run-1", { stageName: "plan", phase: "running" });
			captureFinalSnapshot(
				"run-1",
				SINGLE_UNIT_KEY,
				makeUsageSession("s1", {
					input: 200,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 200,
				}),
			);
			foldStageUsage("run-1");
			expect(getLane("run-1")?.stageUsage.get("plan")?.input).toBe(200);

			// retireRun does NOT clear stageUsage — folded tokens persist.
			retireRun("run-1", "completed");
			expect(getLane("run-1")?.stageUsage.get("plan")?.input).toBe(200);
		});

		it("addStageUsage pairwise-accumulates into a stage bucket (re-fold sums, never overwrites)", () => {
			recordRun("run-1", "ship");
			addStageUsage("run-1", "plan", { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 });
			expect(getLane("run-1")?.stageUsage.get("plan")?.input).toBe(5);
			addStageUsage("run-1", "plan", { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, total: 3 });
			expect(getLane("run-1")?.stageUsage.get("plan")?.input).toBe(8); // summed, not overwritten
		});

		it("addStageUsage is a no-op on undefined usage / undefined stageName / missing lane", () => {
			recordRun("run-1", "ship");
			const listener = vi.fn();
			subscribeLanes(listener);
			addStageUsage("run-1", "plan", undefined); // undefined usage → no-op
			addStageUsage("run-1", undefined, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 }); // undefined stage
			addStageUsage("nope", "plan", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 }); // missing lane
			expect(getLane("run-1")?.stageUsage.size).toBe(0);
			expect(listener).not.toHaveBeenCalled(); // no notify
		});

		it("foldStageUsage folds each unit's effective unitUsage into the OUTGOING stage bucket", () => {
			recordRun("run-1", "ship");
			setLaneProgress("run-1", { stageName: "plan", phase: "running" });
			captureFinalSnapshot(
				"run-1",
				SINGLE_UNIT_KEY,
				makeUsageSession("s1", {
					input: 100,
					output: 40,
					cacheRead: 10,
					cacheWrite: 0,
					total: 150,
				}),
			);
			foldStageUsage("run-1");
			expect(getLane("run-1")?.stageUsage.get("plan")).toEqual({
				input: 100,
				output: 40,
				cacheRead: 10,
				cacheWrite: 0,
				total: 150,
			});
		});

		it("foldStageUsage is a no-op when stageName is unset or units is empty", () => {
			recordRun("run-1", "ship");
			// No stageName set (progress undefined) → no-op
			foldStageUsage("run-1");
			expect(getLane("run-1")?.stageUsage.size).toBe(0);

			setLaneProgress("run-1", { stageName: "plan", phase: "running" });
			// stageName set but no units → no-op
			foldStageUsage("run-1");
			expect(getLane("run-1")?.stageUsage.size).toBe(0);
		});

		it("foldStageUsage does NOT notify (the paired clearUnitLanes/setLaneProgress does)", () => {
			recordRun("run-1", "ship");
			setLaneProgress("run-1", { stageName: "plan", phase: "running" });
			captureFinalSnapshot(
				"run-1",
				SINGLE_UNIT_KEY,
				makeUsageSession("s1", {
					input: 10,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 10,
				}),
			);
			const listener = vi.fn();
			subscribeLanes(listener);
			foldStageUsage("run-1");
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("captureFinalSnapshot — sequential multi-child fold-at-overwrite", () => {
		it("folds ALL sequential children on SINGLE_UNIT_KEY into the stage bucket (c1/c6)", () => {
			// Pre-fix this fails: each child overwrites the prior's finalUsage on the shared
			// SINGLE_UNIT_KEY slot, so only the LAST child survives to be folded at stage-end.
			recordRun("run-1", "ship");
			setLaneProgress("run-1", { stageName: "plan", phase: "running" });
			captureFinalSnapshot(
				"run-1",
				SINGLE_UNIT_KEY,
				makeUsageSession("s1", { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 }),
			);
			captureFinalSnapshot(
				"run-1",
				SINGLE_UNIT_KEY,
				makeUsageSession("s2", { input: 200, output: 0, cacheRead: 0, cacheWrite: 0, total: 200 }),
			);
			captureFinalSnapshot(
				"run-1",
				SINGLE_UNIT_KEY,
				makeUsageSession("s3", { input: 300, output: 0, cacheRead: 0, cacheWrite: 0, total: 300 }),
			);
			foldStageUsage("run-1");
			// ALL three children counted: 100 + 200 + 300 = 600.
			expect(getLane("run-1")?.stageUsage.get("plan")).toEqual({
				input: 600,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 600,
			});
		});

		it("outgoing children fold at capture-time, surviving last child at stage-end — no double-count (c2)", () => {
			// Disjoint-set guarantee: each outgoing child folds once at its overwrite, then
			// is evicted from the slot so stage-end cannot re-count it; only the surviving
			// last child folds at stage-end.
			recordRun("run-1", "ship");
			setLaneProgress("run-1", { stageName: "plan", phase: "running" });
			captureFinalSnapshot(
				"run-1",
				SINGLE_UNIT_KEY,
				makeUsageSession("s1", { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 }),
			);
			captureFinalSnapshot(
				"run-1",
				SINGLE_UNIT_KEY,
				makeUsageSession("s2", { input: 200, output: 0, cacheRead: 0, cacheWrite: 0, total: 200 }),
			);
			captureFinalSnapshot(
				"run-1",
				SINGLE_UNIT_KEY,
				makeUsageSession("s3", { input: 300, output: 0, cacheRead: 0, cacheWrite: 0, total: 300 }),
			);
			// BEFORE stage-end: only OUTGOING children 1 and 2 folded (100 + 200 = 300).
			// The surviving last child (300) is NOT yet counted — it folds at stage-end.
			expect(getLane("run-1")?.stageUsage.get("plan")?.input).toBe(300);
			// stage-end folds ONLY the surviving last child.
			foldStageUsage("run-1");
			expect(getLane("run-1")?.stageUsage.get("plan")?.input).toBe(600); // 300 + 300
		});

		it("finalBranch is last-writer-wins across sequential captures on the same slot (c3)", () => {
			// The capture-time fold touches ONLY usage; the transcript snapshot stays
			// last-writer-wins, so the lane (parent) row still shows the last child.
			recordRun("run-1", "ship");
			setLaneProgress("run-1", { stageName: "plan", phase: "running" });
			const branch1 = [{ type: "message", text: "child-1" }];
			const branch2 = [{ type: "message", text: "child-2" }];
			captureFinalSnapshot("run-1", SINGLE_UNIT_KEY, {
				...makeUsageSession("s1", { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 }),
				sessionManager: { getBranch: () => branch1, getCwd: () => "/tmp" },
			});
			captureFinalSnapshot("run-1", SINGLE_UNIT_KEY, {
				...makeUsageSession("s2", { input: 200, output: 0, cacheRead: 0, cacheWrite: 0, total: 200 }),
				sessionManager: { getBranch: () => branch2, getCwd: () => "/tmp" },
			});
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalBranch).toBe(branch2); // last writer wins
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalUsage?.input).toBe(200); // last writer wins
		});

		it("a single capture on a fresh slot fires NO capture-time fold (bucket empty until stage-end) (c4)", () => {
			recordRun("run-1", "ship");
			setLaneProgress("run-1", { stageName: "plan", phase: "running" });
			captureFinalSnapshot(
				"run-1",
				SINGLE_UNIT_KEY,
				makeUsageSession("s1", { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 }),
			);
			// First capture parks finalUsage but has NO outgoing child to fold → bucket empty.
			expect(getLane("run-1")?.stageUsage.size).toBe(0);
			foldStageUsage("run-1");
			expect(getLane("run-1")?.stageUsage.get("plan")?.input).toBe(100); // folded at stage-end only
		});

		it("a fanout pair on DISTINCT keys fires NO capture-time fold (each child its own slot) (c5)", () => {
			recordRun("run-1", "ship");
			setLaneProgress("run-1", { stageName: "plan", phase: "running" });
			captureFinalSnapshot(
				"run-1",
				0,
				makeUsageSession("s1", { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 }),
			);
			captureFinalSnapshot(
				"run-1",
				1,
				makeUsageSession("s2", { input: 200, output: 0, cacheRead: 0, cacheWrite: 0, total: 200 }),
			);
			// Distinct slots — each first capture has no outgoing child to fold → bucket empty.
			expect(getLane("run-1")?.stageUsage.size).toBe(0);
			foldStageUsage("run-1");
			expect(getLane("run-1")?.stageUsage.get("plan")?.input).toBe(300); // both folded at stage-end
		});

		it("a teardown capture trailing an optimistic retire does NOT fold (same-child re-capture) (c7)", () => {
			// The dock's `x` cancel path: retireRun fires BEFORE the host's teardown
			// `finally`, and retire's own snapshot parks the SAME still-live child's usage
			// onto the slot. The trailing captureFinalSnapshot must treat that parked value
			// as a same-child re-capture (overwrite-only), NOT an outgoing sibling — folding
			// it would show the child's tokens twice (bucket + retained unit) at render.
			recordRun("run-1", "ship");
			setLaneProgress("run-1", { stageName: "plan", phase: "running" });
			const session = makeUsageSession("s1", {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 100,
			});
			setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
			retireRun("run-1", "aborted"); // parks finalUsage off the live session, drops it
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalUsage?.input).toBe(100);
			// The host's teardown capture fires AFTER retire on the `x` path.
			captureFinalSnapshot("run-1", SINGLE_UNIT_KEY, session);
			// No capture-time fold on a terminal lane — the bucket stays empty; the unit's
			// retained finalUsage is the single source the render sums for this stage.
			expect(getLane("run-1")?.stageUsage.size).toBe(0);
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalUsage?.input).toBe(100);
		});
	});

	describe("teardown settle ordering — notify precedes `cleared`; subscribers observe committed state", () => {
		beforeEach(() => {
			// The file-level hook resets the registry; lifecycle listeners are this describe's own.
			__resetQuestionLifecycle();
		});

		/** Wire both streams into ONE shared sequence — `notify` for lane subscribers,
		 *  `<reason>:<unitIndex>[<state>]` for lifecycle events. `[<state>]` renders what a
		 *  lifecycle subscriber observes about the lane AT EMIT TIME (post-mutation): the
		 *  surviving unit keys, `empty` for a cleared units map, `lane-gone` for an evicted
		 *  lane. `stop` unwires both so a test's listeners never leak past it. */
		function trace(): { seq: string[]; stop: () => void } {
			const seq: string[] = [];
			const offLanes = subscribeLanes(() => seq.push("notify"));
			const offLifecycle = subscribeQuestionLifecycle((e) => {
				if (e.kind === "asked") {
					seq.push(`asked:${e.unitIndex}`);
					return;
				}
				const lane = getLane(e.runId);
				const state = lane === undefined ? "lane-gone" : [...lane.units.keys()].join("|") || "empty";
				seq.push(`${e.reason}:${e.unitIndex}[${state}]`);
			});
			return {
				seq,
				stop: () => {
					offLanes();
					offLifecycle();
				},
			};
		}

		it("recordRun reactivation: notify precedes `cleared` per parked unit in Map insertion order", () => {
			recordRun("run-1", "ship");
			const a = makePending();
			const b = makePending();
			enqueueInput("run-1", 1, a); // park unit 1 BEFORE unit 0 — emission follows insertion order, not index order
			enqueueInput("run-1", 0, b);
			const { seq, stop } = trace();
			recordRun("run-1", "ship"); // reactivate (a resume reuses the run id)
			stop();
			// units map already empty at emit time; emits follow Map insertion order (1, then 0)
			expect(seq).toEqual(["notify", "cleared:1[empty]", "cleared:0[empty]"]);
			expect(a.resolve).toHaveBeenCalledTimes(1);
			expect(a.resolve).toHaveBeenCalledWith(undefined);
			expect(b.resolve).toHaveBeenCalledTimes(1);
			expect(b.resolve).toHaveBeenCalledWith(undefined);
		});

		it("a FRESH recordRun notifies without emitting (nothing was ever parked)", () => {
			const { seq, stop } = trace();
			recordRun("run-1", "ship");
			stop();
			expect(seq).toEqual(["notify"]); // no `cleared` — no unit had parked input
		});

		it("retireRun: notify precedes `cleared`; resolvers settle with undefined; unit rows survive", () => {
			recordRun("run-1", "ship");
			const pending = makePending();
			enqueueInput("run-1", 0, pending);
			const { seq, stop } = trace();
			retireRun("run-1", "completed");
			stop();
			expect(seq).toEqual(["notify", "cleared:0[0]"]); // the unit row is retained post-retirement
			expect(pending.resolve).toHaveBeenCalledTimes(1);
			expect(pending.resolve).toHaveBeenCalledWith(undefined);
			// Idempotent second retire: neither notifies nor emits, and never re-settles.
			const second: string[] = [];
			const offLanes = subscribeLanes(() => second.push("notify"));
			const offLifecycle = subscribeQuestionLifecycle((e) => second.push(e.kind));
			retireRun("run-1", "failed");
			offLanes();
			offLifecycle();
			expect(second).toEqual([]);
			expect(pending.resolve).toHaveBeenCalledTimes(1);
		});

		it("evictRun: notify precedes `cleared`; the lane is already gone when `cleared` fires", () => {
			recordRun("run-1", "ship");
			const pending = makePending();
			enqueueInput("run-1", 0, pending);
			const { seq, stop } = trace();
			evictRun("run-1");
			stop();
			expect(seq).toEqual(["notify", "cleared:0[lane-gone]"]);
			expect(pending.resolve).toHaveBeenCalledTimes(1);
			expect(pending.resolve).toHaveBeenCalledWith(undefined);
		});

		it("clearUnitLanes: notify precedes `cleared`; the units map is already empty when `cleared` fires", () => {
			recordRun("run-1", "ship");
			const pending = makePending();
			enqueueInput("run-1", 0, pending);
			const { seq, stop } = trace();
			clearUnitLanes("run-1");
			stop();
			expect(seq).toEqual(["notify", "cleared:0[empty]"]);
			expect(pending.resolve).toHaveBeenCalledTimes(1);
			expect(pending.resolve).toHaveBeenCalledWith(undefined);
			expect(getLane("run-1")?.needsInputSince).toBeUndefined(); // lane clock reset with the generation
		});

		it("clearUnitLanes on an EMPTY map neither notifies nor emits", () => {
			recordRun("run-1", "ship");
			const { seq, stop } = trace();
			clearUnitLanes("run-1"); // nothing to clear — the guard no-ops
			stop();
			expect(seq).toEqual([]);
		});
	});
});
