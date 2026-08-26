import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_REMINDER_COOLDOWN_TURNS,
	DEFAULT_STALE_AFTER_TURNS,
	getReminderCooldownTurns,
	getStaleAfterTurns,
} from "./config.js";
import registerTodo from "./index.js";
import { getActivity } from "./state/activity-tracker.js";
import { __resetState } from "./todo.js";

// All tests run against a private XDG_CONFIG_HOME so the stale/cooldown
// thresholds can be controlled without touching the user's real config and
// without racing config.test.ts on the same ~/.config path.
const CONFIG_DIR = join(tmpdir(), "rpiv-todo-activity-test");
const CONFIG_PATH = join(CONFIG_DIR, "rpiv-todo", "config.json");

function writeConfig(partial: Record<string, unknown>): void {
	mkdirSync(join(CONFIG_DIR, "rpiv-todo"), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(partial), "utf-8");
}
function removeConfig(): void {
	rmSync(CONFIG_DIR, { recursive: true, force: true });
}

beforeEach(() => {
	vi.stubEnv("XDG_CONFIG_HOME", CONFIG_DIR);
	removeConfig();
	__resetState();
	// Default thresholds for the event tests: remind after 2 silent turns,
	// cooldown of 2 turns between reminders.
	writeConfig({ staleAfterTurns: 2, reminderCooldownTurns: 2 });
});
afterEach(() => {
	removeConfig();
	__resetState();
	vi.unstubAllEnvs();
});

function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodo(pi);
	const get = (name: string) => captured.events.get(name)?.[0];
	const sessionStart = get("session_start");
	const sessionCompact = get("session_compact");
	const sessionCompactFailed = get("session_compact_failed");
	const turnStart = get("turn_start");
	const turnEnd = get("turn_end");
	const toolResult = get("tool_result");
	const beforeAgentStart = get("before_agent_start");
	const tool = captured.tools.get("todo");
	if (!tool) throw new Error("todo tool not registered");
	if (!sessionStart) throw new Error("session_start handler not registered");
	if (!sessionCompact) throw new Error("session_compact handler not registered");
	if (!sessionCompactFailed) throw new Error("session_compact_failed handler not registered");
	if (!turnStart) throw new Error("turn_start handler not registered");
	if (!turnEnd) throw new Error("turn_end handler not registered");
	if (!toolResult) throw new Error("tool_result handler not registered");
	if (!beforeAgentStart) throw new Error("before_agent_start handler not registered");
	return {
		sessionStart,
		sessionCompact,
		sessionCompactFailed,
		turnStart,
		turnEnd,
		toolResult,
		beforeAgentStart,
		tool,
	};
}

const textContent = (text: string) => [{ type: "text", text }] as never;

function toolResultEvent(toolName: string, text: string, isError = false) {
	return {
		type: "tool_result",
		toolName,
		toolCallId: "tc",
		input: {},
		content: textContent(text),
		isError,
	} as never;
}

/** Create one task and mark it in_progress. */
async function seedInProgress(
	tool: NonNullable<ReturnType<typeof setup>["tool"]>,
	ctx: ReturnType<typeof createMockCtx>,
) {
	await tool.execute?.(
		"tc",
		{ action: "create", subject: "t1" } as never,
		undefined as never,
		undefined as never,
		ctx as never,
	);
	await tool.execute?.(
		"tc",
		{ action: "update", id: 1, status: "in_progress" } as never,
		undefined as never,
		undefined as never,
		ctx as never,
	);
}

function reminderText(result: unknown): string | undefined {
	const r = result as { content?: Array<{ type: string; text: string }> } | undefined;
	return r?.content
		?.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join(" ");
}

describe("rpiv-todo — stale-todo reminders (turn tracker)", () => {
	it("injects ONE reminder when an in_progress task goes staleAfterTurns without a todo call", async () => {
		const { sessionStart, turnStart, turnEnd, toolResult, tool } = setup();
		const ctx = createMockCtx({ sessionId: "parent" });
		await sessionStart({} as never, ctx as never);
		await seedInProgress(tool, ctx);

		// Turn 1: successful todo call establishes the baseline.
		turnStart({ turnIndex: 1 } as never, ctx as never);
		toolResult(toolResultEvent("todo", "created"), ctx as never);
		turnEnd({ turnIndex: 1 } as never, ctx as never);

		// Turn 2: no todo → 2-1 = 1 < staleAfter(2), no reminder.
		turnStart({ turnIndex: 2 } as never, ctx as never);
		const r2 = toolResult(toolResultEvent("bash", "out"), ctx as never);
		turnEnd({ turnIndex: 2 } as never, ctx as never);
		expect(reminderText(r2)).toBeUndefined();

		// Turn 3: no todo → 3-1 = 2 >= staleAfter(2), reminder injected.
		turnStart({ turnIndex: 3 } as never, ctx as never);
		const r3 = toolResult(toolResultEvent("bash", "out"), ctx as never);
		expect(reminderText(r3)).toContain("todo list");

		// Same turn, second tool result → cooldown suppresses a duplicate.
		const r3b = toolResult(toolResultEvent("read", "out"), ctx as never);
		expect(reminderText(r3b)).toBeUndefined();
	});

	it("resets the baseline after a successful todo call", async () => {
		const { sessionStart, turnStart, turnEnd, toolResult, tool } = setup();
		const ctx = createMockCtx({ sessionId: "parent" });
		await sessionStart({} as never, ctx as never);
		await seedInProgress(tool, ctx);

		// Turn 1: baseline = 1.
		turnStart({ turnIndex: 1 } as never, ctx as never);
		toolResult(toolResultEvent("todo", "created"), ctx as never);
		turnEnd({ turnIndex: 1 } as never, ctx as never);

		// Turn 3: stale → reminder (lastTodoTurn still 1).
		for (let t = 2; t <= 3; t++) {
			turnStart({ turnIndex: t } as never, ctx as never);
			turnEnd({ turnIndex: t } as never, ctx as never);
		}
		const r3 = toolResult(toolResultEvent("bash", "out"), ctx as never);
		expect(reminderText(r3)).toContain("todo list");

		// Turn 4: successful todo call resets baseline to 4.
		turnStart({ turnIndex: 4 } as never, ctx as never);
		toolResult(toolResultEvent("todo", "updated"), ctx as never);
		turnEnd({ turnIndex: 4 } as never, ctx as never);

		// Turn 5: 5-4 = 1 < 2 → no reminder.
		turnStart({ turnIndex: 5 } as never, ctx as never);
		const r5 = toolResult(toolResultEvent("bash", "out"), ctx as never);
		expect(reminderText(r5)).toBeUndefined();
	});

	it("does NOT reset the baseline when a todo call fails", async () => {
		const { sessionStart, turnStart, turnEnd, toolResult, tool } = setup();
		const ctx = createMockCtx({ sessionId: "parent" });
		await sessionStart({} as never, ctx as never);
		await seedInProgress(tool, ctx);

		turnStart({ turnIndex: 1 } as never, ctx as never);
		toolResult(toolResultEvent("todo", "created"), ctx as never);
		turnEnd({ turnIndex: 1 } as never, ctx as never);

		// Turn 2: a FAILED todo call must not advance the baseline.
		turnStart({ turnIndex: 2 } as never, ctx as never);
		toolResult(toolResultEvent("todo", "boom", true), ctx as never);
		turnEnd({ turnIndex: 2 } as never, ctx as never);

		// Turn 3: still stale (3-1 = 2) → reminder fires.
		turnStart({ turnIndex: 3 } as never, ctx as never);
		const r3 = toolResult(toolResultEvent("bash", "out"), ctx as never);
		expect(reminderText(r3)).toContain("todo list");
	});

	it("does not remind when no task is in_progress", async () => {
		const { sessionStart, turnStart, turnEnd, toolResult, tool } = setup();
		const ctx = createMockCtx({ sessionId: "parent" });
		await sessionStart({} as never, ctx as never);
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "done" } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		await tool.execute?.(
			"tc",
			{ action: "update", id: 1, status: "completed" } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);

		turnStart({ turnIndex: 1 } as never, ctx as never);
		toolResult(toolResultEvent("todo", "done"), ctx as never);
		turnEnd({ turnIndex: 1 } as never, ctx as never);

		// 10 silent turns — nothing in_progress, so never a reminder.
		for (let t = 2; t <= 11; t++) {
			turnStart({ turnIndex: t } as never, ctx as never);
			const r = toolResult(toolResultEvent("bash", "out"), ctx as never);
			expect(reminderText(r)).toBeUndefined();
			turnEnd({ turnIndex: t } as never, ctx as never);
		}
	});

	it("keeps parent and child turn counters isolated", async () => {
		const { sessionStart, turnStart, turnEnd, toolResult, tool } = setup();
		const parent = createMockCtx({ sessionId: "parent" });
		const child = createMockCtx({ sessionId: "child" });
		await sessionStart({} as never, parent as never);
		await sessionStart({} as never, child as never);

		// Parent has an in_progress task and a baseline at turn 1.
		await seedInProgress(tool, parent);
		turnStart({ turnIndex: 1 } as never, parent as never);
		toolResult(toolResultEvent("todo", "created"), parent as never);
		turnEnd({ turnIndex: 1 } as never, parent as never);

		// Child churns 10 turns doing bash; it has no in_progress tasks, so its
		// activity must not influence the parent's counters.
		for (let t = 1; t <= 10; t++) {
			turnStart({ turnIndex: t } as never, child as never);
			toolResult(toolResultEvent("bash", "out"), child as never);
			turnEnd({ turnIndex: t } as never, child as never);
		}

		// Parent is now stale (3-1 = 2) → reminder fires.
		for (let t = 2; t <= 3; t++) {
			turnStart({ turnIndex: t } as never, parent as never);
			turnEnd({ turnIndex: t } as never, parent as never);
		}
		const r = toolResult(toolResultEvent("bash", "out"), parent as never);
		expect(reminderText(r)).toContain("todo list");

		// The child's own tool results never carried a reminder.
		expect(getActivity("child").lastTodoTurn).toBeUndefined();
		expect(getActivity("parent").lastTodoTurn).toBe(1);
	});
});

describe("rpiv-todo — compaction resync hint", () => {
	it("injects one resync hint on the next before_agent_start and clears the flag", async () => {
		const { sessionStart, sessionCompact, beforeAgentStart } = setup();
		const ctx = createMockCtx({ sessionId: "parent" });
		await sessionStart({} as never, ctx as never);

		await sessionCompact({} as never, ctx as never);

		const first = beforeAgentStart(
			{ type: "before_agent_start", prompt: "do it", systemPrompt: "base", systemPromptOptions: {} } as never,
			ctx as never,
		) as { systemPrompt?: string } | undefined;
		expect(first?.systemPrompt).toContain("todo list");

		// Flag cleared → second start carries no hint.
		const second = beforeAgentStart(
			{ type: "before_agent_start", prompt: "do it", systemPrompt: "base", systemPromptOptions: {} } as never,
			ctx as never,
		);
		expect(second).toBeUndefined();
	});

	it("injects no hint without a preceding compaction", async () => {
		const { sessionStart, beforeAgentStart } = setup();
		const ctx = createMockCtx({ sessionId: "parent" });
		await sessionStart({} as never, ctx as never);

		const result = beforeAgentStart(
			{ type: "before_agent_start", prompt: "do it", systemPrompt: "base", systemPromptOptions: {} } as never,
			ctx as never,
		);
		expect(result).toBeUndefined();
	});
});

describe("rpiv-todo — stale/cooldown config getters", () => {
	it("returns the defaults when no config is present", () => {
		removeConfig();
		expect(getStaleAfterTurns()).toBe(DEFAULT_STALE_AFTER_TURNS);
		expect(getReminderCooldownTurns()).toBe(DEFAULT_REMINDER_COOLDOWN_TURNS);
	});

	it("returns configured positive integers", () => {
		writeConfig({ staleAfterTurns: 3, reminderCooldownTurns: 5 });
		expect(getStaleAfterTurns()).toBe(3);
		expect(getReminderCooldownTurns()).toBe(5);
	});

	it("falls back to the default for invalid values (0, negative, non-number)", () => {
		writeConfig({ staleAfterTurns: 0, reminderCooldownTurns: -2 });
		expect(getStaleAfterTurns()).toBe(DEFAULT_STALE_AFTER_TURNS);
		expect(getReminderCooldownTurns()).toBe(DEFAULT_REMINDER_COOLDOWN_TURNS);

		writeConfig({ staleAfterTurns: "twelve", reminderCooldownTurns: 2.5 });
		expect(getStaleAfterTurns()).toBe(DEFAULT_STALE_AFTER_TURNS);
		expect(getReminderCooldownTurns()).toBe(2);
	});
});

describe("rpiv-todo — reviewer fix regressions", () => {
	it("turn-0 baseline works: a successful todo call in turn 0 still enables stale reminders", async () => {
		const { sessionStart, turnStart, turnEnd, toolResult, tool } = setup();
		const ctx = createMockCtx({ sessionId: "parent" });
		await sessionStart({} as never, ctx as never);
		await seedInProgress(tool, ctx);

		// Pi resets turnIndex to 0 on agent_start, so the FIRST successful todo
		// call may legitimately happen in turn 0 → lastTodoTurn = 0. This must
		// NOT be confused with "no baseline yet" (the old `=== 0` sentinel would
		// have permanently disabled reminders for this run).
		turnStart({ turnIndex: 0 } as never, ctx as never);
		toolResult(toolResultEvent("todo", "created"), ctx as never);
		turnEnd({ turnIndex: 0 } as never, ctx as never);
		expect(getActivity("parent").lastTodoTurn).toBe(0);

		// Turn 1: 1-0 = 1 < staleAfter(2) → no reminder.
		turnStart({ turnIndex: 1 } as never, ctx as never);
		const r1 = toolResult(toolResultEvent("bash", "out"), ctx as never);
		turnEnd({ turnIndex: 1 } as never, ctx as never);
		expect(reminderText(r1)).toBeUndefined();

		// Turn 2: 2-0 = 2 >= staleAfter(2) → reminder fires.
		turnStart({ turnIndex: 2 } as never, ctx as never);
		const r2 = toolResult(toolResultEvent("bash", "out"), ctx as never);
		expect(reminderText(r2)).toContain("todo list");
	});

	it("a successful todo call in an already-stale turn injects NO reminder on that todo result", async () => {
		const { sessionStart, turnStart, turnEnd, toolResult, tool } = setup();
		const ctx = createMockCtx({ sessionId: "parent" });
		await sessionStart({} as never, ctx as never);
		await seedInProgress(tool, ctx);

		// Baseline at turn 0.
		turnStart({ turnIndex: 0 } as never, ctx as never);
		toolResult(toolResultEvent("todo", "created"), ctx as never);
		turnEnd({ turnIndex: 0 } as never, ctx as never);

		// Turn 2 is already stale (2-0 >= 2), but this turn SYNCES via a todo
		// call. The todo result itself must carry no "please call todo list".
		turnStart({ turnIndex: 2 } as never, ctx as never);
		const syncResult = toolResult(toolResultEvent("todo", "updated"), ctx as never);
		expect(reminderText(syncResult)).toBeUndefined();
		turnEnd({ turnIndex: 2 } as never, ctx as never);
		expect(getActivity("parent").lastTodoTurn).toBe(2);

		// Turn 3: 3-2 = 1 < staleAfter(2) → still no reminder after the sync.
		turnStart({ turnIndex: 3 } as never, ctx as never);
		const r3 = toolResult(toolResultEvent("bash", "out"), ctx as never);
		expect(reminderText(r3)).toBeUndefined();
	});

	it("a failed compaction clears the resync hint so no false 'restored' claim is injected", async () => {
		const { sessionStart, sessionCompact, sessionCompactFailed, beforeAgentStart } = setup();
		const ctx = createMockCtx({ sessionId: "parent" });
		await sessionStart({} as never, ctx as never);

		// Compaction sets the pending resync flag…
		await sessionCompact({} as never, ctx as never);
		expect(getActivity("parent").compactionResyncPending).toBe(true);

		// …but it FAILS/aborts → the flag must be cleared, and the next
		// before_agent_start must NOT inject a "state restored" hint (the session
		// was never rewritten, so the model's working memory was not lost).
		await sessionCompactFailed({} as never, ctx as never);
		expect(getActivity("parent").compactionResyncPending).toBeUndefined();

		const result = beforeAgentStart(
			{ type: "before_agent_start", prompt: "do it", systemPrompt: "base", systemPromptOptions: {} } as never,
			ctx as never,
		);
		expect(result).toBeUndefined();
	});

	it("a successful todo call resets the baseline across an otherwise-stale gap", async () => {
		const { sessionStart, turnStart, turnEnd, toolResult, tool } = setup();
		const ctx = createMockCtx({ sessionId: "parent" });
		await sessionStart({} as never, ctx as never);
		await seedInProgress(tool, ctx);

		turnStart({ turnIndex: 0 } as never, ctx as never);
		toolResult(toolResultEvent("todo", "created"), ctx as never);
		turnEnd({ turnIndex: 0 } as never, ctx as never);

		// Turn 2 stale → reminder, and lastReminderTurn = 2.
		turnStart({ turnIndex: 2 } as never, ctx as never);
		toolResult(toolResultEvent("bash", "out"), ctx as never);
		turnEnd({ turnIndex: 2 } as never, ctx as never);

		// Turn 4 syncs (todo success) → baseline advances to 4, so turn 5 (5-4=1)
		// is not stale even though cooldown (2) would also have suppressed a
		// reminder.
		turnStart({ turnIndex: 4 } as never, ctx as never);
		toolResult(toolResultEvent("todo", "updated"), ctx as never);
		turnEnd({ turnIndex: 4 } as never, ctx as never);
		expect(getActivity("parent").lastTodoTurn).toBe(4);

		turnStart({ turnIndex: 5 } as never, ctx as never);
		const r5 = toolResult(toolResultEvent("bash", "out"), ctx as never);
		expect(reminderText(r5)).toBeUndefined();
	});
});
