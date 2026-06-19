import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetRunLaneRegistry,
	dequeueInput,
	enqueueInput,
	evictRun,
	getFocusedRun,
	getLane,
	type LaneSession,
	laneCount,
	laneNeedsInput,
	listLanes,
	listLanesForDisplay,
	type PendingInput,
	recordRun,
	retireRun,
	setCurrentSession,
	setFocusedRun,
	setLaneAbort,
	setLaneProgress,
	setLaneStatus,
	shortRunId,
	subscribeLanes,
} from "./run-lane-registry.js";

/** Minimal LaneSession stub — structural, so the registry needs no real AgentSession. */
function makeSession(sessionId: string): LaneSession {
	return {
		sessionId,
		isStreaming: false,
		sessionManager: { getBranch: () => [] },
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
			expect(lane?.currentSession).toBeUndefined();
			expect(lane?.pendingInput).toEqual([]);
			expect(lane?.progress).toBeUndefined();
			expect(listLanes()).toHaveLength(1);
			expect(laneCount()).toBe(1);
		});

		it("is idempotent on the same id and only updates the name", () => {
			recordRun("run-1", "ship");
			setLaneStatus("run-1", "completed");
			const session = makeSession("s1");
			setCurrentSession("run-1", session);
			recordRun("run-1", "renamed");
			const lane = getLane("run-1");
			expect(laneCount()).toBe(1);
			expect(lane?.name).toBe("renamed");
			// status + currentSession preserved (not reset by the second record).
			expect(lane?.status).toBe("completed");
			expect(lane?.currentSession).toBe(session);
		});
	});

	describe("evictRun", () => {
		it("removes the lane and resolves every queued pendingInput with undefined", () => {
			recordRun("run-1", "ship");
			const a = makePending();
			const b = makePending();
			enqueueInput("run-1", a);
			enqueueInput("run-1", b);
			evictRun("run-1");
			expect(getLane("run-1")).toBeUndefined();
			expect(laneCount()).toBe(0);
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

	describe("retireRun (Phase A)", () => {
		it("retains the lane with terminal status, snapshots the branch, clears the session, settles pending", () => {
			recordRun("run-1", "ship");
			const branch = [{ type: "message" }];
			setCurrentSession("run-1", { ...makeSession("s1"), sessionManager: { getBranch: () => branch } });
			const p = makePending();
			enqueueInput("run-1", p);
			retireRun("run-1", "completed");
			const lane = getLane("run-1");
			expect(lane).toBeDefined(); // RETAINED, not deleted
			expect(lane?.status).toBe("completed");
			expect(lane?.finalBranch).toBe(branch); // snapshot captured before dropping the session
			expect(lane?.currentSession).toBeUndefined();
			expect(lane?.pendingInput).toHaveLength(0);
			expect(p.resolve).toHaveBeenCalledWith(undefined); // stalled child never hangs
		});

		it("fail-soft when getBranch throws — leaves finalBranch undefined, still retires", () => {
			recordRun("run-1", "ship");
			setCurrentSession("run-1", {
				...makeSession("s1"),
				sessionManager: {
					getBranch: () => {
						throw new Error("disposed");
					},
				},
			});
			expect(() => retireRun("run-1", "failed")).not.toThrow();
			expect(getLane("run-1")?.status).toBe("failed");
			expect(getLane("run-1")?.finalBranch).toBeUndefined();
		});

		it("is a no-op for an unknown id", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			retireRun("nope", "completed");
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("listLanesForDisplay (Phase B)", () => {
		it("stable priority sort: needs-input → running → terminal, insertion order within a bucket", () => {
			recordRun("done-1", "a");
			retireRun("done-1", "completed");
			recordRun("run-1", "b"); // running
			recordRun("run-2", "c"); // running, will need input
			enqueueInput("run-2", makePending());
			const order = listLanesForDisplay().map((l) => l.runId);
			expect(order).toEqual(["run-2", "run-1", "done-1"]);
			// listLanes() keeps launch (insertion) order — display sort must not mutate it.
			expect(listLanes().map((l) => l.runId)).toEqual(["done-1", "run-1", "run-2"]);
		});
	});

	describe("setLaneAbort (Phase D)", () => {
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

	describe("needsInputSince (Phase C)", () => {
		it("stamps on the 0→1 transition, preserves across a second enqueue, clears when drained", () => {
			recordRun("run-1", "ship");
			expect(getLane("run-1")?.needsInputSince).toBeUndefined();
			enqueueInput("run-1", makePending());
			const stamped = getLane("run-1")?.needsInputSince;
			expect(typeof stamped).toBe("number");
			enqueueInput("run-1", makePending()); // second enqueue must not re-stamp
			expect(getLane("run-1")?.needsInputSince).toBe(stamped);
			dequeueInput("run-1"); // still one queued → clock holds
			expect(getLane("run-1")?.needsInputSince).toBe(stamped);
			dequeueInput("run-1"); // queue drained → clock clears
			expect(getLane("run-1")?.needsInputSince).toBeUndefined();
		});

		it("retireRun clears the needs-input clock", () => {
			recordRun("run-1", "ship");
			enqueueInput("run-1", makePending());
			retireRun("run-1", "aborted");
			expect(getLane("run-1")?.needsInputSince).toBeUndefined();
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
		it("sets, replaces, and clears currentSession", () => {
			recordRun("run-1", "ship");
			const a = makeSession("a");
			const b = makeSession("b");
			setCurrentSession("run-1", a);
			expect(getLane("run-1")?.currentSession).toBe(a);
			setCurrentSession("run-1", b);
			expect(getLane("run-1")?.currentSession).toBe(b);
			setCurrentSession("run-1", undefined);
			expect(getLane("run-1")?.currentSession).toBeUndefined();
		});

		it("is a no-op when the run isn't recorded", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			expect(() => setCurrentSession("nope", makeSession("a"))).not.toThrow();
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("setLaneProgress (Phase 8)", () => {
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

	describe("enqueueInput / dequeueInput", () => {
		it("queues FIFO on a recorded run and flips laneNeedsInput true", () => {
			recordRun("run-1", "ship");
			expect(laneNeedsInput("run-1")).toBe(false);
			const a = makePending();
			const b = makePending();
			enqueueInput("run-1", a);
			enqueueInput("run-1", b);
			expect(laneNeedsInput("run-1")).toBe(true);
			expect(dequeueInput("run-1")).toBe(a);
			expect(dequeueInput("run-1")).toBe(b);
		});

		it("resolves immediately with undefined on an unrecorded run (never strands the child)", () => {
			const p = makePending();
			enqueueInput("nope", p);
			expect(p.resolve).toHaveBeenCalledWith(undefined);
			expect(getLane("nope")).toBeUndefined();
		});

		it("dequeueInput returns undefined when empty", () => {
			recordRun("run-1", "ship");
			expect(dequeueInput("run-1")).toBeUndefined();
			expect(dequeueInput("nope")).toBeUndefined();
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
		it("clears lanes, listeners, and focus", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			recordRun("run-1", "ship");
			setFocusedRun("run-1");
			const callsBeforeReset = listener.mock.calls.length;
			__resetRunLaneRegistry();
			expect(laneCount()).toBe(0);
			expect(listLanes()).toEqual([]);
			expect(getFocusedRun()).toBeUndefined();
			// listeners cleared: a post-reset mutation must not call the old listener.
			recordRun("run-2", "build");
			expect(listener.mock.calls.length).toBe(callsBeforeReset);
		});
	});

	// -------------------------------------------------------------------------
	// Phase 7.3: process-global slot. A detached child re-loads rpiv-core and may
	// get a SEPARATE module instance; the registry must still be ONE shared store
	// (anchored on globalThis[Symbol.for(...)]) so the launcher and a child see the
	// same lanes.
	// -------------------------------------------------------------------------
	describe("process-global registry (Phase 7.3)", () => {
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

	describe("shortRunId (Phase 7.4)", () => {
		it("returns the random hex suffix after the last dash (not the shared date prefix)", () => {
			// generateRunId() shape: <date>_<time>-<hex>; slice(0,6) would yield "2026-0".
			expect(shortRunId("2026-06-19_08-14-17-a1b2")).toBe("a1b2");
		});

		it("distinguishes two runs launched in the same second", () => {
			expect(shortRunId("2026-06-19_08-14-17-a1b2")).not.toBe(shortRunId("2026-06-19_08-14-17-c3d4"));
		});

		it("falls back to the whole id when there is no dash", () => {
			expect(shortRunId("plainid")).toBe("plainid");
		});
	});
});
