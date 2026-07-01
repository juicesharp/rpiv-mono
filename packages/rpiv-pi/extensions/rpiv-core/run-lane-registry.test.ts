import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetRunLaneRegistry,
	captureFinalSnapshot,
	dequeueInput,
	enqueueInput,
	evictRun,
	getFocusedRun,
	getLane,
	getUnit,
	type LaneSession,
	laneCount,
	laneNeedsInput,
	listLanes,
	listLanesForDisplay,
	markUnitDone,
	noteVisitedStage,
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
				stageNumber: 2,
				totalStages: 3,
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
			setLaneProgress("run-1", { stageNumber: 1, totalStages: 7, stageName: "plan", phase: "running" });
			expect(getLane("run-1")?.progress).toMatchObject({ stageNumber: 1, totalStages: 7, stageName: "plan" });
			expect(listener).toHaveBeenCalledTimes(1);
			setLaneProgress("run-1", { stageNumber: 2, totalStages: 7, stageName: "build", phase: "running" });
			expect(getLane("run-1")?.progress?.stageNumber).toBe(2);
			expect(listener).toHaveBeenCalledTimes(2);
			setLaneProgress("run-1", undefined);
			expect(getLane("run-1")?.progress).toBeUndefined();
			expect(listener).toHaveBeenCalledTimes(3);
		});

		it("is a no-op (no notify) on an unrecorded run", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			expect(() =>
				setLaneProgress("nope", { stageNumber: 1, totalStages: 3, stageName: "x", phase: "running" }),
			).not.toThrow();
			expect(listener).not.toHaveBeenCalled();
			expect(getLane("nope")).toBeUndefined();
		});
	});

	describe("noteVisitedStage", () => {
		it("returns the running count of DISTINCT stage names (a repeat does not inflate it)", () => {
			recordRun("run-1", "ship");
			expect(noteVisitedStage("run-1", "research")).toBe(1);
			expect(noteVisitedStage("run-1", "implement")).toBe(2);
			expect(noteVisitedStage("run-1", "review")).toBe(3);
			expect(noteVisitedStage("run-1", "implement")).toBe(3); // loop-back — already counted
		});

		it("does not notify (the paired setLaneProgress owns the redraw)", () => {
			recordRun("run-1", "ship");
			const listener = vi.fn();
			subscribeLanes(listener);
			noteVisitedStage("run-1", "research");
			expect(listener).not.toHaveBeenCalled();
		});

		it("returns 0 for a missing/evicted run", () => {
			expect(noteVisitedStage("ghost", "x")).toBe(0);
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
});
