import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import registerTodo from "./index.ts";
import { __resetState } from "./todo.ts";
import type { Task } from "./tool/types.ts";

/**
 * End-to-end wiring of the context-sync events through the real extension
 * factory. The scenario under test is issue #222: the task data survives a
 * rebuild of the session (compaction / resume / tree navigation) while the
 * model's context does not, so the list must be re-stated on the next request —
 * exactly once, without writing anything to the session.
 */

const CONFIG_DIR = join(process.env.HOME ?? "", ".config", "rpiv-todo");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const SYSTEM = { role: "system", content: "system prompt", timestamp: 0 } as const;

function task(id: number, status: Task["status"], subject = `task ${id}`): Task {
	return { id, status, subject };
}

/** A `rpiv-todo-state` custom entry, the shape `replayFromBranch` restores from. */
function stateEntry(tasks: Task[]): unknown {
	return {
		type: "custom",
		id: `entry-${tasks.length}`,
		customType: "rpiv-todo-state",
		data: { action: "create", params: {}, tasks, nextId: tasks.length + 1 },
	};
}

/** A `todo` toolResult message — visible to the model, unlike a custom entry. */
function toolResultEntry(tasks: Task[]): unknown {
	return {
		type: "message",
		id: "tr",
		message: {
			role: "toolResult",
			toolCallId: "tc",
			toolName: "todo",
			content: [],
			isError: false,
			timestamp: 0,
			details: { action: "create", params: {}, tasks, nextId: tasks.length + 1 },
		},
	};
}

/** A compaction boundary: everything before it is replaced by a summary. */
function compactionEntry(firstKeptEntryId?: string): unknown {
	return { type: "compaction", id: "cmp", summary: "earlier work", firstKeptEntryId };
}

type Handlers = ReturnType<typeof setup>;

function setup(branch: unknown[] = [], sessionId = "s1") {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodo(pi);
	const handler = (name: string) => {
		const list = captured.events.get(name);
		if (!list?.length) throw new Error(`${name} handler not registered`);
		return list[0] as (event: unknown, ctx: unknown) => Promise<unknown>;
	};
	return {
		pi,
		captured,
		sessionId,
		branch,
		ctx: () => createMockCtx({ branch: branch as never, sessionId, hasUI: false }),
		start: handler("session_start"),
		compact: handler("session_compact"),
		tree: handler("session_tree"),
		toolEnd: handler("tool_execution_end"),
		turnEnd: handler("turn_end"),
		settle: handler("agent_before_settle"),
		inject: handler("context_with_system"),
	};
}

/** Run the injection hook and return the appended text, or undefined when nothing was added. */
async function injectedText(h: Handlers, ctx = h.ctx()): Promise<string | undefined> {
	const result = (await h.inject({ type: "context_with_system", messages: [SYSTEM] }, ctx)) as
		| { messages: Array<{ role: string; content: unknown }> }
		| undefined;
	if (!result) return undefined;
	const last = result.messages.at(-1) as
		| { role?: string; content?: Array<{ type: string; text?: string }> }
		| undefined;
	if (last?.role !== "user") return undefined;
	return last?.content?.[0]?.text;
}

async function turn(h: Handlers, ctx = h.ctx()): Promise<void> {
	await h.turnEnd({ type: "turn_end", turnIndex: 1, toolResults: [], entries: [], continue: false }, ctx);
}

beforeEach(() => {
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(CONFIG_FILE, JSON.stringify({ staleAfterTurns: 3, reminderCooldownTurns: 3 }));
});

afterEach(() => {
	rmSync(CONFIG_FILE, { force: true });
	__resetState();
});

describe("context sync — session reconstruction", () => {
	it("re-states the list on the request after session_start (resume)", async () => {
		const h = setup([stateEntry([task(1, "completed"), task(2, "in_progress"), task(3, "pending")])]);
		await h.start({ type: "session_start", reason: "resume" }, h.ctx());

		const text = await injectedText(h);
		expect(text).toContain("<todo-resync");
		expect(text).toContain("1/3 completed");
		expect(text).toContain("[>] #2 task 2");
	});

	it("injects once, then a normal request carries nothing", async () => {
		const h = setup([stateEntry([task(1, "pending")])]);
		await h.start({ type: "session_start", reason: "resume" }, h.ctx());
		expect(await injectedText(h)).toContain("<todo-resync");
		expect(await injectedText(h)).toBeUndefined();
	});

	it("keeps the transcript intact and appends after it", async () => {
		const h = setup([stateEntry([task(1, "pending")])]);
		await h.start({ type: "session_start", reason: "resume" }, h.ctx());
		const result = (await h.inject({ type: "context_with_system", messages: [SYSTEM] }, h.ctx())) as {
			messages: Array<{ role: string }>;
		};
		expect(result.messages[0].role).toBe("system");
		expect(result.messages).toHaveLength(2);
	});

	it("re-states after compaction", async () => {
		const h = setup([stateEntry([task(1, "in_progress")])]);
		await h.start({ type: "session_start", reason: "startup" }, h.ctx());
		await injectedText(h);
		await h.compact({ type: "session_compact", reason: "manual", willRetry: false }, h.ctx());
		expect(await injectedText(h)).toContain("<todo-resync");
	});

	it("re-states after tree navigation", async () => {
		const h = setup([stateEntry([task(1, "pending")])]);
		await h.start({ type: "session_start", reason: "startup" }, h.ctx());
		await injectedText(h);
		await h.tree({ type: "session_tree", newLeafId: "x", oldLeafId: "y" }, h.ctx());
		expect(await injectedText(h)).toContain("<todo-resync");
	});

	it("says nothing when the restored branch has no tasks", async () => {
		const h = setup([]);
		await h.start({ type: "session_start", reason: "new" }, h.ctx());
		expect(await injectedText(h)).toBeUndefined();
	});

	it("does NOT re-state a resumed transcript that still shows the todo results", async () => {
		// Real `pi -c`: the history is complete, so the model already has the list.
		// Injecting again here was the over-injection a live run exposed.
		const h = setup([toolResultEntry([task(1, "pending")])]);
		await h.start({ type: "session_start", reason: "resume" }, h.ctx());
		expect(await injectedText(h)).toBeUndefined();
	});

	it("re-states when a compaction sits after the last todo result", async () => {
		const h = setup([toolResultEntry([task(1, "pending")]), compactionEntry()]);
		await h.start({ type: "session_start", reason: "resume" }, h.ctx());
		const text = await injectedText(h);
		expect(text).toContain("<todo-resync");
		expect(text).toContain("[ ] #1 task 1");
	});

	it("re-states a codemode-only list that never produced a todo tool result", async () => {
		const h = setup([stateEntry([task(1, "pending")])]);
		await h.start({ type: "session_start", reason: "resume" }, h.ctx());
		expect(await injectedText(h)).toContain("<todo-resync");
	});

	it("keeps quiet when a todo result survives inside the compaction's kept range", async () => {
		// `getBranch()` returns the raw parent chain, so an entry kept by a
		// compaction still appears BEFORE the compaction entry itself. That is the
		// case a plain ordering check gets wrong: the result is visible, yet it sits
		// earlier in the list than the boundary.
		const kept = toolResultEntry([task(1, "pending")]) as { id: string };
		kept.id = "tr-kept";
		const h = setup([kept, compactionEntry("tr-kept")]);
		await h.start({ type: "session_start", reason: "resume" }, h.ctx());
		expect(await injectedText(h)).toBeUndefined();
	});

	it("re-states when the surviving todo result is older than the kept range", async () => {
		const stale = toolResultEntry([task(1, "pending")]) as { id: string };
		stale.id = "tr-old";
		const kept = { type: "message", id: "kept-1", message: { role: "user", content: [] } };
		const h = setup([stale, kept, compactionEntry("kept-1")]);
		await h.start({ type: "session_start", reason: "resume" }, h.ctx());
		expect(await injectedText(h)).toContain("<todo-resync");
	});

	it("reports an all-completed list instead of staying silent", async () => {
		const h = setup([stateEntry([task(1, "completed"), task(2, "completed")])]);
		await h.start({ type: "session_start", reason: "resume" }, h.ctx());
		expect(await injectedText(h)).toContain("All tasks completed");
	});

	it("skips a malformed snapshot instead of crashing the session", async () => {
		const h = setup([{ type: "custom", id: "bad", customType: "rpiv-todo-state", data: { tasks: "nope" } }]);
		await h.start({ type: "session_start", reason: "resume" }, h.ctx());
		expect(await injectedText(h)).toBeUndefined();
	});
});

describe("context sync — stale list reminder", () => {
	async function withTasks(): Promise<Handlers> {
		const h = setup([stateEntry([task(1, "completed"), task(2, "pending"), task(3, "in_progress")])]);
		await h.start({ type: "session_start", reason: "startup" }, h.ctx());
		await injectedText(h); // drain the resync
		return h;
	}

	it("stays silent below the threshold", async () => {
		const h = await withTasks();
		await turn(h);
		await turn(h);
		expect(await injectedText(h)).toBeUndefined();
	});

	it("nudges a reconcile once the threshold is crossed", async () => {
		const h = await withTasks();
		await turn(h);
		await turn(h);
		await turn(h);
		const text = await injectedText(h);
		expect(text).toContain("<todo-review");
		expect(text).toContain("[ ] #2 task 2");
		expect(text).toContain("[>] #3 task 3");
		// Completed rows are not repeated in the nudge.
		expect(text).not.toContain("#1");
	});

	it("a successful todo call clears the counter", async () => {
		const h = await withTasks();
		await turn(h);
		await turn(h);
		await h.toolEnd({ type: "tool_execution_end", toolName: "todo", isError: false }, h.ctx());
		await turn(h);
		expect(await injectedText(h)).toBeUndefined();
	});

	it("does not nudge when every task is completed", async () => {
		const h = setup([stateEntry([task(1, "completed")])]);
		await h.start({ type: "session_start", reason: "startup" }, h.ctx());
		await injectedText(h);
		for (let i = 0; i < 5; i++) await turn(h);
		expect(await injectedText(h)).toBeUndefined();
	});
});

describe("context sync — settle boundary", () => {
	/** A boundary event with a runnable context, the shape Pi builds when it can continue. */
	const boundary = (over: Record<string, unknown> = {}) => ({
		type: "agent_before_settle",
		entries: [],
		continue: false,
		context: {
			canContinue: true,
			contextEntries: [],
			contextMessages: [],
			llmMessages: [],
			pendingMessages: [],
		},
		...over,
	});

	async function stale(): Promise<Handlers> {
		const h = setup([stateEntry([task(1, "in_progress")])]);
		await h.start({ type: "session_start", reason: "startup" }, h.ctx());
		await injectedText(h);
		for (let i = 0; i < 3; i++) await turn(h);
		return h;
	}

	it("requests one continuation when a stale list is about to be left behind", async () => {
		const h = await stale();
		expect(await h.settle(boundary(), h.ctx())).toEqual({ continue: true });
	});

	it("asks at most once per reminder", async () => {
		const h = await stale();
		await h.settle(boundary(), h.ctx());
		expect(await h.settle(boundary(), h.ctx())).toBeUndefined();
	});

	it("does nothing when Pi already has a continuation", async () => {
		const h = await stale();
		expect(await h.settle(boundary({ continue: true }), h.ctx())).toBeUndefined();
	});

	it("does nothing when nothing is stale", async () => {
		const h = setup([stateEntry([task(1, "in_progress")])]);
		await h.start({ type: "session_start", reason: "startup" }, h.ctx());
		await injectedText(h);
		expect(await h.settle(boundary(), h.ctx())).toBeUndefined();
	});

	it("does not ask when the boundary has no runnable context (headless `-p`)", async () => {
		// Pi rejects `continue` here with "requested continuation without runnable
		// model context", so the reminder just waits for the next real turn.
		const h = await stale();
		expect(await h.settle(boundary({ context: { canContinue: false } }), h.ctx())).toBeUndefined();
	});
});

describe("context sync — no session writes", () => {
	it("never appends an entry or sends a message", async () => {
		const h = setup([stateEntry([task(1, "pending")])]);
		await h.start({ type: "session_start", reason: "resume" }, h.ctx());
		await injectedText(h);
		for (let i = 0; i < 5; i++) await turn(h);
		await h.settle(
			{
				type: "agent_before_settle",
				entries: [],
				continue: false,
				context: {
					canContinue: true,
					contextEntries: [],
					contextMessages: [],
					llmMessages: [],
					pendingMessages: [],
				},
			},
			h.ctx(),
		);
		await injectedText(h);

		expect(h.captured.entries).toEqual([]);
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
	});
});

describe("context sync — session isolation", () => {
	it("one session's resync never leaks into another", async () => {
		const tasks = [stateEntry([task(1, "pending")])];
		const a = setup(tasks, "a");
		await a.start({ type: "session_start", reason: "resume" }, a.ctx());
		// A different session with an empty branch.
		const b = createMockCtx({ branch: [] as never, sessionId: "b", hasUI: false });
		expect(await injectedText(a)).toContain("<todo-resync");
		expect(await injectedText(a, b)).toBeUndefined();
	});

	it("shutdown drops the session's sync state", async () => {
		const h = setup([stateEntry([task(1, "pending")])]);
		await h.start({ type: "session_start", reason: "resume" }, h.ctx());
		const shutdown = h.captured.events.get("session_shutdown")?.[0] as (e: unknown, c: unknown) => Promise<void>;
		await shutdown({ type: "session_shutdown", reason: "quit" }, h.ctx());
		expect(await injectedText(h)).toBeUndefined();
	});
});

describe("context sync — newest state source decides visibility", () => {
	it("re-states when a later nested update only wrote the custom snapshot", async () => {
		// codemode appends the snapshot but leaves no toolResult, so an older
		// visible result must not be mistaken for "the model has the latest list".
		const result = toolResultEntry([task(1, "pending")]) as { id: string };
		result.id = "tr-old";
		const snapshot = stateEntry([task(1, "in_progress")]) as { id: string };
		snapshot.id = "snap-new";
		const h = setup([result, snapshot]);
		await h.start({ type: "session_start", reason: "resume" }, h.ctx());
		const text = await injectedText(h);
		expect(text).toContain("<todo-resync");
		expect(text).toContain("[>] #1");
	});

	it("stays quiet when the newest source is a visible todo result", async () => {
		const snapshot = stateEntry([task(1, "pending")]) as { id: string };
		snapshot.id = "snap-old";
		const result = toolResultEntry([task(1, "in_progress")]) as { id: string };
		result.id = "tr-new";
		const h = setup([snapshot, result]);
		await h.start({ type: "session_start", reason: "resume" }, h.ctx());
		expect(await injectedText(h)).toBeUndefined();
	});
});
