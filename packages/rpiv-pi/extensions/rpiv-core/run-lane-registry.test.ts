import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetRunLaneRegistry,
	dequeueInput,
	enqueueInput,
	evictRun,
	getDockState,
	getFocusedRun,
	getLane,
	type LaneSession,
	laneCount,
	laneNeedsInput,
	listLanes,
	listLanesForDisplay,
	moveDockSelection,
	noteVisitedStage,
	type PendingInput,
	recordRun,
	retireRun,
	setCurrentSession,
	setDockActive,
	setDockSelection,
	setFocusedRun,
	setLaneAbort,
	setLaneProgress,
	setLaneStatus,
	subscribeLanes,
} from "./run-lane-registry.js";

/** Minimal LaneSession stub — structural, so the registry needs no real AgentSession. */
function makeSession(sessionId: string): LaneSession {
	return {
		sessionId,
		isStreaming: false,
		sessionManager: { getBranch: () => [], getCwd: () => "/tmp" },
		getToolDefinition: () => undefined,
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

		it("updates the name without spawning a duplicate lane", () => {
			recordRun("run-1", "ship");
			recordRun("run-1", "renamed");
			expect(laneCount()).toBe(1);
			expect(getLane("run-1")?.name).toBe("renamed");
		});

		it("REACTIVATES a retained terminal lane on re-record (resume reuses the run id)", () => {
			// A run fails and is retained (Phase A): terminal status + a transcript snapshot.
			recordRun("run-1", "ship");
			setLaneProgress("run-1", {
				stageNumber: 2,
				totalStages: 3,
				stageName: "build",
				phase: "running",
			});
			setCurrentSession("run-1", {
				...makeSession("s1"),
				sessionManager: { getBranch: () => [{ type: "x" }], getCwd: () => "/tmp" },
			});
			retireRun("run-1", "failed"); // → status "failed", finalBranch captured
			expect(getLane("run-1")?.status).toBe("failed");
			expect(getLane("run-1")?.finalBranch).toBeDefined();

			// Resuming re-records the SAME id — the lane must come back to life, not stay failed.
			recordRun("run-1", "ship");
			const lane = getLane("run-1");
			expect(laneCount()).toBe(1);
			expect(lane?.status).toBe("running"); // reactivated, no longer "failed"
			expect(lane?.finalBranch).toBeUndefined(); // stale snapshot dropped
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
			setCurrentSession("run-1", {
				...makeSession("s1"),
				sessionManager: { getBranch: () => branch, getCwd: () => "/tmp" },
			});
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

		it("snapshots cwd + per-tool definitions for the toolCall names in the branch (Phase 4)", () => {
			recordRun("run-1", "ship");
			const branch = [
				{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } },
				{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "edit" }] } },
			];
			const getToolDefinition = vi.fn((name: string) => ({ name, label: `def:${name}` }));
			setCurrentSession("run-1", {
				...makeSession("s1"),
				sessionManager: { getBranch: () => branch, getCwd: () => "/work/dir" },
				getToolDefinition,
			});
			retireRun("run-1", "completed");
			const lane = getLane("run-1");
			expect(lane?.finalCwd).toBe("/work/dir");
			expect(lane?.finalToolDefs?.get("bash")).toEqual({ name: "bash", label: "def:bash" });
			expect(lane?.finalToolDefs?.get("edit")).toEqual({ name: "edit", label: "def:edit" });
			// Each distinct tool name resolved exactly once.
			expect(getToolDefinition).toHaveBeenCalledTimes(2);
		});

		it("fail-soft when getBranch throws — leaves finalBranch undefined, still retires", () => {
			recordRun("run-1", "ship");
			setCurrentSession("run-1", {
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
			expect(getLane("run-1")?.finalBranch).toBeUndefined();
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
			setCurrentSession("run-1", {
				...makeSession("s1"),
				sessionManager: { getBranch: () => branch, getCwd: () => "/tmp" },
			});
			// First retire (e.g. the manager's optimistic `x` cancel) snapshots the live
			// session and drops it.
			retireRun("run-1", "aborted");
			expect(getLane("run-1")?.finalBranch).toBe(branch);

			// Second retire (e.g. the runner's later onWorkflowEnd for the same run) must
			// NOT re-snapshot off the now-absent session — that would wipe finalBranch.
			const listener = vi.fn();
			subscribeLanes(listener);
			retireRun("run-1", "completed");
			expect(getLane("run-1")?.status).toBe("aborted"); // first status held
			expect(getLane("run-1")?.finalBranch).toBe(branch); // transcript preserved
			expect(listener).not.toHaveBeenCalled(); // no spurious notify on the no-op
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

	describe("dock state", () => {
		it("getDockState defaults to inactive at the top", () => {
			expect(getDockState()).toEqual({ active: false, selection: 0 });
		});

		it("setDockActive toggles and notifies only on a real change", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			setDockActive(false); // already inactive — no notify
			expect(listener).not.toHaveBeenCalled();
			setDockActive(true);
			expect(getDockState().active).toBe(true);
			expect(listener).toHaveBeenCalledTimes(1);
			setDockActive(true); // unchanged — no second notify
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it("deactivating resets the selection to the top", () => {
			recordRun("run-1", "a");
			recordRun("run-2", "b");
			recordRun("run-3", "c");
			setDockActive(true);
			setDockSelection(2);
			expect(getDockState().selection).toBe(2);
			setDockActive(false);
			expect(getDockState().selection).toBe(0);
		});

		it("setDockSelection clamps to [0, lanes-1] and notifies only on change", () => {
			recordRun("run-1", "a");
			recordRun("run-2", "b");
			const listener = vi.fn();
			subscribeLanes(listener);
			setDockSelection(5); // clamps to last index (1)
			expect(getDockState().selection).toBe(1);
			expect(listener).toHaveBeenCalledTimes(1);
			setDockSelection(5); // already clamped to 1 — no notify
			expect(listener).toHaveBeenCalledTimes(1);
			setDockSelection(-3); // clamps to 0
			expect(getDockState().selection).toBe(0);
		});

		it("moveDockSelection steps and clamps at both ends", () => {
			recordRun("run-1", "a");
			recordRun("run-2", "b");
			moveDockSelection(1);
			expect(getDockState().selection).toBe(1);
			moveDockSelection(1); // clamp at last
			expect(getDockState().selection).toBe(1);
			moveDockSelection(-5); // clamp at first
			expect(getDockState().selection).toBe(0);
		});

		it("getDockState clamps a stale selection after a lane is evicted", () => {
			recordRun("run-1", "a");
			recordRun("run-2", "b");
			recordRun("run-3", "c");
			setDockSelection(2);
			evictRun("run-3");
			evictRun("run-2");
			// Selection was 2; only run-1 remains → read clamps to 0 (never dangles).
			expect(getDockState().selection).toBe(0);
		});

		it("selection is 0 when there are no lanes", () => {
			setDockSelection(3);
			expect(getDockState().selection).toBe(0);
		});
	});

	describe("__resetRunLaneRegistry", () => {
		it("clears lanes, listeners, focus, and dock state", () => {
			const listener = vi.fn();
			subscribeLanes(listener);
			recordRun("run-1", "ship");
			setFocusedRun("run-1");
			setDockActive(true);
			setDockSelection(0);
			const callsBeforeReset = listener.mock.calls.length;
			__resetRunLaneRegistry();
			expect(laneCount()).toBe(0);
			expect(listLanes()).toEqual([]);
			expect(getFocusedRun()).toBeUndefined();
			expect(getDockState()).toEqual({ active: false, selection: 0 });
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
});
