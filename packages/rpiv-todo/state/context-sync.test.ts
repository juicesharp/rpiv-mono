import { beforeEach, describe, expect, it } from "vitest";
import type { Task } from "../tool/types.ts";
import {
	__resetSyncState,
	beginTurn,
	consumePendingInjection,
	hasOpenTasks,
	markContinueOffered,
	markResyncPending,
	noteTodoSuccess,
	noteTurnEnd,
	renderResyncBlock,
	renderReviewBlock,
	type SyncSettings,
	shouldForceReview,
} from "./context-sync.ts";

const SETTINGS: SyncSettings = { enabled: true, staleAfterTurns: 3, reminderCooldownTurns: 3 };

const task = (id: number, status: Task["status"], subject = `task ${id}`, extra: Partial<Task> = {}): Task => ({
	id,
	status,
	subject,
	...extra,
});

beforeEach(() => __resetSyncState());

describe("context-sync — rendered blocks", () => {
	it("renders open tasks with status glyphs and a completion count", () => {
		const block = renderResyncBlock([
			task(1, "completed"),
			task(2, "in_progress", "Write tests", { activeForm: "writing" }),
		]);
		expect(block).toContain("1/2 completed");
		expect(block).toContain("[>] #2 Write tests (writing)");
		// Completed rows are not actionable, so they are summarized by the count only.
		expect(block).not.toContain("#1");
		expect(block).toContain("</todo-resync>");
	});

	it("states that nothing is left when every task is completed", () => {
		const block = renderResyncBlock([task(1, "completed"), task(2, "completed")]);
		expect(block).toContain("All tasks completed");
	});

	it("returns undefined for an empty or fully deleted list", () => {
		expect(renderResyncBlock([])).toBeUndefined();
		expect(renderResyncBlock([task(1, "deleted")])).toBeUndefined();
	});

	it("folds a long list instead of emitting every row", () => {
		const tasks = Array.from({ length: 30 }, (_, i) => task(i + 1, "pending"));
		const block = renderResyncBlock(tasks);
		expect(block).toContain("0/30 completed");
		expect(block).toContain("… 19 more");
		expect(block?.split("\n").length).toBeLessThan(20);
	});

	it("review block carries only outstanding work and the turn count", () => {
		const block = renderReviewBlock([task(1, "completed"), task(2, "pending"), task(3, "in_progress")], 7);
		expect(block).toContain('note="statuses not updated for 7 turns"');
		expect(block).toContain("[ ] #2 task 2");
		expect(block).toContain("[>] #3 task 3");
		expect(block).not.toContain("#1");
	});

	it("review block is absent when no work is outstanding", () => {
		expect(renderReviewBlock([task(1, "completed")], 7)).toBeUndefined();
	});

	it("hasOpenTasks counts pending and in_progress only", () => {
		expect(hasOpenTasks([task(1, "completed"), task(2, "deleted")])).toBe(false);
		expect(hasOpenTasks([task(1, "pending")])).toBe(true);
		expect(hasOpenTasks([task(1, "in_progress")])).toBe(true);
	});
});

describe("context-sync — injection lifecycle", () => {
	it("injects nothing until something is armed", () => {
		expect(consumePendingInjection("s", [task(1, "pending")], SETTINGS)).toBeUndefined();
	});

	it("resync is injected exactly once", () => {
		markResyncPending("s");
		expect(consumePendingInjection("s", [task(1, "pending")], SETTINGS)).toContain("<todo-resync");
		expect(consumePendingInjection("s", [task(1, "pending")], SETTINGS)).toBeUndefined();
	});

	it("resync wins over a pending review and clears both", () => {
		for (let i = 0; i < SETTINGS.staleAfterTurns; i++) {
			noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
		}
		markResyncPending("s");
		expect(consumePendingInjection("s", [task(1, "pending")], SETTINGS)).toContain("<todo-resync");
		expect(consumePendingInjection("s", [task(1, "pending")], SETTINGS)).toBeUndefined();
	});

	it("stays silent below the stale threshold", () => {
		noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
		noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
		expect(consumePendingInjection("s", [task(1, "pending")], SETTINGS)).toBeUndefined();
	});

	it("arms a review once the threshold is crossed", () => {
		for (let i = 0; i < SETTINGS.staleAfterTurns; i++) {
			noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
		}
		expect(consumePendingInjection("s", [task(1, "pending")], SETTINGS)).toContain("<todo-review");
	});

	it("never arms a review when no task is outstanding", () => {
		for (let i = 0; i < SETTINGS.staleAfterTurns + 2; i++) {
			noteTurnEnd("s", [task(1, "completed")], SETTINGS, false);
		}
		expect(consumePendingInjection("s", [task(1, "completed")], SETTINGS)).toBeUndefined();
	});

	it("honours the cooldown before arming a second review", () => {
		for (let i = 0; i < SETTINGS.staleAfterTurns; i++) {
			noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
		}
		expect(consumePendingInjection("s", [task(1, "pending")], SETTINGS)).toContain("<todo-review");
		// Threshold re-crossed but the cooldown has not elapsed yet.
		noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
		expect(consumePendingInjection("s", [task(1, "pending")], SETTINGS)).toBeUndefined();
		for (let i = 0; i < SETTINGS.reminderCooldownTurns; i++) {
			noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
		}
		expect(consumePendingInjection("s", [task(1, "pending")], SETTINGS)).toContain("<todo-review");
	});

	it("a successful todo call resets the counter and the cooldown", () => {
		for (let i = 0; i < SETTINGS.staleAfterTurns; i++) {
			noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
		}
		consumePendingInjection("s", [task(1, "pending")], SETTINGS);
		noteTodoSuccess("s");
		for (let i = 0; i < SETTINGS.staleAfterTurns - 1; i++) {
			noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
		}
		expect(consumePendingInjection("s", [task(1, "pending")], SETTINGS)).toBeUndefined();
	});

	it("zero staleAfterTurns disables the review path but not the resync", () => {
		const off: SyncSettings = { ...SETTINGS, staleAfterTurns: 0 };
		for (let i = 0; i < 10; i++) noteTurnEnd("s", [task(1, "pending")], off, false);
		expect(consumePendingInjection("s", [task(1, "pending")], off)).toBeUndefined();
		markResyncPending("s");
		expect(consumePendingInjection("s", [task(1, "pending")], off)).toContain("<todo-resync");
	});

	it("enabled:false suppresses every injection", () => {
		const off: SyncSettings = { ...SETTINGS, enabled: false };
		for (let i = 0; i < 10; i++) noteTurnEnd("s", [task(1, "pending")], off, false);
		markResyncPending("s");
		expect(consumePendingInjection("s", [task(1, "pending")], off)).toBeUndefined();
	});

	it("scopes every counter per session", () => {
		markResyncPending("a");
		expect(consumePendingInjection("a", [task(1, "pending")], SETTINGS)).toContain("<todo-resync");
		expect(consumePendingInjection("b", [task(1, "pending")], SETTINGS)).toBeUndefined();
	});
});

it("a later reminder re-opens the settle guard (no session-lifetime latch)", () => {
	for (let i = 0; i < SETTINGS.staleAfterTurns; i++) {
		noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
	}
	expect(shouldForceReview("s", [task(1, "pending")], SETTINGS)).toBe(true);
	markContinueOffered("s");
	expect(shouldForceReview("s", [task(1, "pending")], SETTINGS)).toBe(false);

	// The model ignored the continuation. Once the cooldown elapses the next
	// reminder must be able to force its own continuation, or the guard would
	// stay latched for the rest of the session.
	for (let i = 0; i < SETTINGS.reminderCooldownTurns; i++) {
		noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
	}
	expect(shouldForceReview("s", [task(1, "pending")], SETTINGS)).toBe(true);
});

it("a nested todo call counts as an update even when the turn reports no results", () => {
	// codemode's `ctx.executeTool("todo")` fires tool_execution_end but never
	// appears in turn_end.toolResults, so the turn-scoped flag must cover it.
	for (let i = 0; i < SETTINGS.staleAfterTurns; i++) {
		noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
	}
	noteTodoSuccess("s");
	noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
	// A reset turn, not a "turn without todo": the counter stays at zero.
	for (let i = 0; i < SETTINGS.staleAfterTurns - 1; i++) {
		noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
	}
	expect(consumePendingInjection("s", [task(1, "pending")], SETTINGS)).toBeUndefined();
});

it("a turn boundary drops a leftover success flag", () => {
	// Simulate an out-of-order tool event: the flag is set, then a new turn
	// starts without that turn having called todo.
	noteTodoSuccess("s");
	beginTurn("s");
	noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
	noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
	noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
	expect(shouldForceReview("s", [task(1, "pending")], SETTINGS)).toBe(true);
});

it("a turn_end that itself reports a todo success resets without double counting", () => {
	for (let i = 0; i < SETTINGS.staleAfterTurns; i++) {
		noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
	}
	noteTurnEnd("s", [task(1, "pending")], SETTINGS, true);
	expect(shouldForceReview("s", [task(1, "pending")], SETTINGS)).toBe(false);
});

describe("context-sync — settle boundary guard", () => {
	it("does not force a review before one is armed", () => {
		expect(shouldForceReview("s", [task(1, "pending")], SETTINGS)).toBe(false);
	});

	it("forces exactly one review, then stays quiet", () => {
		for (let i = 0; i < SETTINGS.staleAfterTurns; i++) {
			noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
		}
		expect(shouldForceReview("s", [task(1, "pending")], SETTINGS)).toBe(true);
		markContinueOffered("s");
		expect(shouldForceReview("s", [task(1, "pending")], SETTINGS)).toBe(false);
	});

	it("does not force a review once the list is clear", () => {
		for (let i = 0; i < SETTINGS.staleAfterTurns; i++) {
			noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
		}
		expect(shouldForceReview("s", [task(1, "completed")], SETTINGS)).toBe(false);
	});

	it("a later todo call re-arms the settle guard", () => {
		for (let i = 0; i < SETTINGS.staleAfterTurns; i++) {
			noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
		}
		markContinueOffered("s");
		// The successful call happens INSIDE a turn, so that turn still closes with
		// the flag set (a reset turn), and only later turns advance the counter.
		noteTodoSuccess("s");
		noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
		for (let i = 0; i < SETTINGS.staleAfterTurns; i++) {
			noteTurnEnd("s", [task(1, "pending")], SETTINGS, false);
		}
		expect(shouldForceReview("s", [task(1, "pending")], SETTINGS)).toBe(true);
	});
});
