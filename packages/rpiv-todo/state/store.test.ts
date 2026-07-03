import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";
import {
	__resetState,
	clearActiveRenderSession,
	commitState,
	evictSession,
	getActiveRenderSession,
	getNextId,
	getRenderState,
	getState,
	getTodos,
	replaceState,
	setActiveRenderSession,
	sid,
} from "./store.js";

const SID = "s1";

function makeTask(id: number, subject = `t${id}`): Task {
	return { id, subject, status: "pending" };
}

describe("rpiv-todo/state/store — accessors and seams (per-session)", () => {
	it("__resetState() restores EMPTY_STATE shape (independent of EMPTY_STATE.tasks identity)", () => {
		__resetState();
		expect(getTodos(SID)).toEqual(EMPTY_STATE.tasks);
		expect(getNextId(SID)).toBe(EMPTY_STATE.nextId);
		// Reset clones — must NOT alias EMPTY_STATE.tasks (else mutations leak).
		expect(getTodos(SID)).not.toBe(EMPTY_STATE.tasks);
	});

	it("getTodos(sid) returns the live tasks reference (read-only typed)", () => {
		__resetState();
		const next: TaskState = { tasks: [makeTask(1)], nextId: 2 };
		commitState(SID, next);
		expect(getTodos(SID)).toBe(next.tasks);
		expect(getTodos(SID)).toEqual([makeTask(1)]);
	});

	it("getNextId(sid) reflects the current slot value", () => {
		__resetState();
		commitState(SID, { tasks: [], nextId: 42 });
		expect(getNextId(SID)).toBe(42);
	});

	it("getState(sid) returns the same slot that getTodos/getNextId read from", () => {
		__resetState();
		const next: TaskState = { tasks: [makeTask(7, "lucky")], nextId: 8 };
		commitState(SID, next);
		const snap = getState(SID);
		expect(snap).toBe(next);
		expect(snap.tasks).toBe(getTodos(SID));
		expect(snap.nextId).toBe(getNextId(SID));
	});

	it("replaceState(sid, next) publishes a new slot wholesale (replay seam)", () => {
		__resetState();
		const replayed: TaskState = {
			tasks: [makeTask(10, "from-branch"), makeTask(11, "from-branch-2")],
			nextId: 12,
		};
		replaceState(SID, replayed);
		expect(getState(SID)).toBe(replayed);
		expect(getTodos(SID)).toEqual(replayed.tasks);
		expect(getNextId(SID)).toBe(12);
	});

	it("commitState() and replaceState() are interchangeable seams over the same slot", () => {
		__resetState();
		commitState(SID, { tasks: [makeTask(1)], nextId: 2 });
		expect(getNextId(SID)).toBe(2);
		replaceState(SID, { tasks: [], nextId: 99 });
		expect(getTodos(SID)).toEqual([]);
		expect(getNextId(SID)).toBe(99);
	});

	it("__resetState() after a commit clears the slot (test-isolation contract)", () => {
		commitState(SID, { tasks: [makeTask(1)], nextId: 2 });
		__resetState();
		expect(getTodos(SID)).toEqual([]);
		expect(getNextId(SID)).toBe(1);
	});
});

describe("rpiv-todo/state/store — per-session isolation", () => {
	it("commitState/replaceState to one session never affects another session's slot", () => {
		__resetState();
		const s1: TaskState = { tasks: [makeTask(1, "s1-task")], nextId: 2 };
		const s2: TaskState = { tasks: [makeTask(1, "s2-task")], nextId: 5 };
		commitState("s1", s1);
		commitState("s2", s2);

		// Each reads only its own slot, by identity.
		expect(getState("s1")).toBe(s1);
		expect(getState("s2")).toBe(s2);
		expect(getTodos("s1")).toEqual([makeTask(1, "s1-task")]);
		expect(getTodos("s2")).toEqual([makeTask(1, "s2-task")]);

		// A write to s1 leaves s2 untouched, and vice-versa.
		replaceState("s1", { tasks: [makeTask(9, "new-s1")], nextId: 10 });
		expect(getState("s2")).toBe(s2);
		expect(getNextId("s2")).toBe(5);
		commitState("s2", { tasks: [], nextId: 77 });
		expect(getTodos("s1")).toEqual([makeTask(9, "new-s1")]);
		expect(getNextId("s1")).toBe(10);
	});

	it("a missing slot returns a fresh EMPTY_STATE copy, never aliasing EMPTY_STATE.tasks", () => {
		__resetState();
		const slot = getState("never-seen");
		expect(slot.tasks).toEqual(EMPTY_STATE.tasks);
		expect(slot.nextId).toBe(EMPTY_STATE.nextId);
		expect(slot.tasks).not.toBe(EMPTY_STATE.tasks);
		expect(slot).not.toBe(EMPTY_STATE);

		// Accessors on a missing slot read a fresh copy too.
		expect(getTodos("absent")).toEqual([]);
		expect(getNextId("absent")).toBe(1);
		expect(getTodos("absent")).not.toBe(EMPTY_STATE.tasks);
	});
});

describe("rpiv-todo/state/store — evictSession", () => {
	it("evictSession(sid) frees the slot; a later read returns a fresh EMPTY_STATE copy", () => {
		__resetState();
		commitState(SID, { tasks: [makeTask(1)], nextId: 2 });
		expect(getState(SID).tasks).toHaveLength(1);
		evictSession(SID);
		const after = getState(SID);
		expect(after.tasks).toEqual([]);
		expect(after.nextId).toBe(1);
		expect(after.tasks).not.toBe(EMPTY_STATE.tasks);
	});

	it("evictSession on an absent slot is a no-op", () => {
		__resetState();
		expect(() => evictSession("absent")).not.toThrow();
		expect(getTodos("absent")).toEqual([]);
	});
});

describe("rpiv-todo/state/store — ctx-less render pointer", () => {
	it("getRenderState() returns a fresh EMPTY_STATE copy before any pointer is set", () => {
		__resetState();
		const rendered = getRenderState();
		expect(rendered.tasks).toEqual([]);
		expect(rendered.nextId).toBe(1);
		expect(rendered.tasks).not.toBe(EMPTY_STATE.tasks);
	});

	it("setActiveRenderSession(sid) makes getRenderState() read that session's slot", () => {
		__resetState();
		commitState("rendered", { tasks: [makeTask(3, "shown")], nextId: 4 });
		setActiveRenderSession("rendered");
		const rendered = getRenderState();
		expect(rendered.tasks).toEqual([makeTask(3, "shown")]);
		expect(rendered.nextId).toBe(4);
	});

	it("setActiveRenderSession re-points the render slot to a different session", () => {
		__resetState();
		commitState("a", { tasks: [makeTask(1, "a")], nextId: 2 });
		commitState("b", { tasks: [makeTask(1, "b")], nextId: 2 });
		setActiveRenderSession("a");
		expect(getRenderState().tasks.map((t) => t.subject)).toEqual(["a"]);
		setActiveRenderSession("b");
		expect(getRenderState().tasks.map((t) => t.subject)).toEqual(["b"]);
	});

	it("__resetState() clears BOTH the Map and the render pointer", () => {
		commitState("a", { tasks: [makeTask(1)], nextId: 2 });
		setActiveRenderSession("a");
		expect(getRenderState().tasks).toHaveLength(1);
		__resetState();
		// Map cleared: the old slot is gone.
		expect(getState("a").tasks).toEqual([]);
		// Pointer cleared: getRenderState() no longer resolves to the old slot.
		const rendered = getRenderState();
		expect(rendered.tasks).toEqual([]);
		expect(rendered.tasks).not.toBe(EMPTY_STATE.tasks);
	});
});

describe("rpiv-todo/state/store — sid(ctx)", () => {
	it("sid(ctx) returns ctx.sessionManager.getSessionId()", () => {
		expect(sid({ sessionManager: { getSessionId: () => "abc" } })).toBe("abc");
	});

	it("sid(ctx) coerces a null/undefined session id to empty string (defensive)", () => {
		// A session id that resolves to null/undefined at runtime is normalized
		// to "" so the Map key stays a plain string (Phase 2 sid-gate invariant).
		expect(sid({ sessionManager: { getSessionId: () => null as unknown as string } })).toBe("");
		expect(sid({ sessionManager: { getSessionId: () => undefined as unknown as string } })).toBe("");
	});
});

describe("rpiv-todo/state/store — foreground render-pointer accessors", () => {
	it("getActiveRenderSession() returns the session set by setActiveRenderSession()", () => {
		__resetState();
		setActiveRenderSession("s1");
		expect(getActiveRenderSession()).toBe("s1");
		// getRenderState() resolves to that session's slot.
		expect(getRenderState()).toEqual(getState("s1"));
	});

	it("clearActiveRenderSession() resets the pointer; getRenderState() returns a fresh EMPTY_STATE", () => {
		__resetState();
		commitState("s1", { tasks: [makeTask(1)], nextId: 2 });
		setActiveRenderSession("s1");
		expect(getRenderState().tasks).toEqual([makeTask(1)]);
		clearActiveRenderSession();
		expect(getActiveRenderSession()).toBe("");
		const rendered = getRenderState();
		expect(rendered.tasks).toEqual([]);
		expect(rendered.nextId).toBe(EMPTY_STATE.nextId);
		// Fresh copy — never aliases EMPTY_STATE.tasks.
		expect(rendered.tasks).not.toBe(EMPTY_STATE.tasks);
	});

	it("__resetState() clears the foreground pointer", () => {
		setActiveRenderSession("s1");
		__resetState();
		expect(getActiveRenderSession()).toBe("");
	});
});
