import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetQuestionLifecycle,
	emitQuestionAsked,
	emitQuestionResolved,
	type QuestionLifecycleEvent,
	subscribeQuestionLifecycle,
} from "./question-lifecycle.js";
import {
	__resetRunLaneRegistry,
	clearUnitLanes,
	dequeueInput,
	enqueueInput,
	evictRun,
	laneNeedsInput,
	type PendingInput,
	peekInput,
	recordRun,
	retireRun,
	SINGLE_UNIT_KEY,
	setUnitStarted,
} from "./run-lane-registry.js";

/** A PendingInput whose resolver is observable. */
function makePending(): PendingInput & { resolve: ReturnType<typeof vi.fn> } {
	const resolve = vi.fn();
	return {
		factory: (() => ({})) as unknown as PendingInput["factory"],
		options: undefined as unknown as PendingInput["options"],
		resolve,
	};
}

/** Subscribe and collect every event into an array. */
function capture(): { events: QuestionLifecycleEvent[]; unsub: () => void } {
	const events: QuestionLifecycleEvent[] = [];
	const unsub = subscribeQuestionLifecycle((e) => events.push(e));
	return { events, unsub };
}

beforeEach(() => {
	__resetRunLaneRegistry();
	__resetQuestionLifecycle();
});

describe("question-lifecycle stream", () => {
	describe("asked — enqueueInput (entry-exists path)", () => {
		it("publishes exactly one `asked` carrying name/workflow/input + (runId, unitIndex)", () => {
			recordRun("run-1", "ship", { workflow: "ship", input: "refactor auth" });
			const { events } = capture();
			enqueueInput("run-1", 2, makePending());
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				kind: "asked",
				runId: "run-1",
				unitIndex: 2,
				name: "ship",
				workflow: "ship",
				input: "refactor auth",
			});
			expect(typeof (events[0] as { at: number }).at).toBe("number");
		});

		it("publishes NOTHING on a missing run (the if (!entry) early-return)", () => {
			const { events } = capture();
			enqueueInput("nope", SINGLE_UNIT_KEY, makePending());
			expect(events).toHaveLength(0);
		});
	});

	describe("answered — dequeueInput", () => {
		it("publishes exactly one resolved(answered) when an item is popped", () => {
			recordRun("run-1", "ship");
			enqueueInput("run-1", SINGLE_UNIT_KEY, makePending());
			const { events } = capture();
			dequeueInput("run-1", SINGLE_UNIT_KEY);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				kind: "resolved",
				runId: "run-1",
				unitIndex: SINGLE_UNIT_KEY,
				reason: "answered",
			});
		});

		it("peekInput publishes NOTHING (a read never emits)", () => {
			recordRun("run-1", "ship");
			enqueueInput("run-1", SINGLE_UNIT_KEY, makePending());
			const { events } = capture();
			peekInput("run-1", SINGLE_UNIT_KEY);
			expect(events).toHaveLength(0);
		});

		it("dequeueInput on an empty queue publishes NOTHING", () => {
			recordRun("run-1", "ship");
			const { events } = capture();
			dequeueInput("run-1", SINGLE_UNIT_KEY);
			expect(events).toHaveLength(0);
		});
	});

	describe("sibling-drain non-clearance", () => {
		it("dequeue A resolves A only; B stays outstanding and receives nothing", () => {
			recordRun("run-1", "ship");
			enqueueInput("run-1", 0, makePending()); // unit A
			enqueueInput("run-1", 1, makePending()); // unit B
			const { events } = capture();
			dequeueInput("run-1", 0); // answer A
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ kind: "resolved", unitIndex: 0, reason: "answered" });
			// B received NO resolved/cleared — its `asked` stays outstanding.
		});
	});

	describe("cleared — teardown paths", () => {
		it("retireRun publishes one cleared per unit that had pending input", () => {
			recordRun("run-1", "ship");
			enqueueInput("run-1", 0, makePending());
			enqueueInput("run-1", 1, makePending());
			const { events } = capture();
			retireRun("run-1", "aborted");
			const cleared = events.filter((e) => e.kind === "resolved");
			expect(cleared).toHaveLength(2);
			expect(cleared.map((e) => (e.kind === "resolved" ? e.unitIndex : -9)).sort((a, b) => a - b)).toEqual([0, 1]);
			expect(cleared.every((e) => e.kind === "resolved" && e.reason === "cleared")).toBe(true);
		});

		it("retireRun publishes NOTHING for units with an empty queue", () => {
			recordRun("run-1", "ship");
			setUnitStarted("run-1", 1, "phase 2/2"); // unit 1 exists, empty queue
			enqueueInput("run-1", 0, makePending()); // unit 0 has a parked question
			const { events } = capture();
			retireRun("run-1", "completed");
			const cleared = events.filter((e) => e.kind === "resolved");
			expect(cleared).toHaveLength(1);
			expect(cleared[0]).toMatchObject({ unitIndex: 0, reason: "cleared" });
		});

		it("evictRun publishes one cleared per unit that had pending input", () => {
			recordRun("run-1", "ship");
			enqueueInput("run-1", 0, makePending());
			const { events } = capture();
			evictRun("run-1");
			const cleared = events.filter((e) => e.kind === "resolved");
			expect(cleared).toHaveLength(1);
			expect(cleared[0]).toMatchObject({ unitIndex: 0, reason: "cleared" });
		});

		it("clearUnitLanes publishes one cleared per unit that had pending input", () => {
			recordRun("run-1", "ship");
			enqueueInput("run-1", 0, makePending());
			enqueueInput("run-1", 1, makePending());
			const { events } = capture();
			clearUnitLanes("run-1");
			const cleared = events.filter((e) => e.kind === "resolved");
			expect(cleared).toHaveLength(2);
		});

		it("recordRun reactivation publishes cleared for a parked question; a brand-new run publishes nothing", () => {
			recordRun("run-1", "ship");
			enqueueInput("run-1", 0, makePending());
			const { events } = capture();
			recordRun("run-1", "ship"); // reactivate (resume reuses the run id)
			const cleared = events.filter((e) => e.kind === "resolved");
			expect(cleared).toHaveLength(1);
			expect(cleared[0]).toMatchObject({ unitIndex: 0, reason: "cleared" });

			// A brand-new run publishes nothing.
			const fresh = capture();
			recordRun("run-2", "build");
			expect(fresh.events).toHaveLength(0);
		});
	});

	describe("subscribe / reset / fail-soft", () => {
		it("a throwing lifecycle listener does not block other listeners (fail-soft publish)", () => {
			const sibling = vi.fn();
			subscribeQuestionLifecycle(() => {
				throw new Error("boom");
			});
			subscribeQuestionLifecycle(sibling);
			expect(() => emitQuestionAsked("run-1", 0, "ship", undefined, undefined)).not.toThrow();
			expect(sibling).toHaveBeenCalledTimes(1);
		});

		it("subscribeQuestionLifecycle's unsubscribe fn stops further events", () => {
			const listener = vi.fn();
			const unsub = subscribeQuestionLifecycle(listener);
			emitQuestionAsked("run-1", 0, "ship", undefined, undefined);
			expect(listener).toHaveBeenCalledTimes(1);
			unsub();
			emitQuestionResolved("run-1", 0, "answered");
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it("__resetQuestionLifecycle clears the listener Set in place; pre-reset listeners receive nothing after", () => {
			const listener = vi.fn();
			subscribeQuestionLifecycle(listener);
			__resetQuestionLifecycle();
			emitQuestionAsked("run-1", 0, "ship", undefined, undefined);
			expect(listener).not.toHaveBeenCalled();
			// Still subscribable after reset (slot identity preserved in place).
			const after = vi.fn();
			subscribeQuestionLifecycle(after);
			emitQuestionResolved("run-1", 0, "cleared");
			expect(after).toHaveBeenCalledTimes(1);
		});
	});

	describe("emit ordering", () => {
		it("emits fire AFTER notify() — a handler observes committed post-mutation state", () => {
			recordRun("run-1", "ship");
			let observedNeedsInput = false;
			let observedPeek: PendingInput | undefined;
			subscribeQuestionLifecycle((event) => {
				if (event.kind === "asked") {
					observedNeedsInput = laneNeedsInput(event.runId);
					observedPeek = peekInput(event.runId, event.unitIndex);
				}
			});
			const pending = makePending();
			enqueueInput("run-1", SINGLE_UNIT_KEY, pending);
			expect(observedNeedsInput).toBe(true); // park already committed
			expect(observedPeek).toBe(pending); // head visible post-mutation
		});
	});
});
