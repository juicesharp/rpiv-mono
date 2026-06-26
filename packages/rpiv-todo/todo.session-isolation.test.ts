import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, type vi } from "vitest";
import registerTodo from "./index.js";
import { EMPTY_STATE } from "./state/state.js";
import { getActiveRenderSession, getRenderState, getState } from "./state/store.js";
import { __resetState } from "./todo.js";

// Capture the extension's registered handlers + tool + command. Each registerTodo()
// call builds a fresh closure (fresh module-level `todoOverlay`), so isolation
// between tests is automatic given __resetState() clears the store.
function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodo(pi);
	const sessionStart = captured.events.get("session_start")?.[0];
	const sessionShutdown = captured.events.get("session_shutdown")?.[0];
	const tool = captured.tools.get("todo");
	const cmd = captured.commands.get("todos");
	if (!sessionStart) throw new Error("session_start handler not registered");
	if (!sessionShutdown) throw new Error("session_shutdown handler not registered");
	if (!tool) throw new Error("todo tool not registered");
	if (!cmd) throw new Error("todos command not registered");
	return { sessionStart, sessionShutdown, tool, cmd };
}

beforeEach(() => __resetState());
afterEach(() => __resetState());

describe("rpiv-todo — per-session todo store isolation (Phase 1 baseline)", () => {
	it("a child session_start (empty branch) leaves the parent's committed task intact", async () => {
		const { sessionStart, tool } = setup();
		const parent = createMockCtx({ sessionId: "parent", hasUI: true });
		const child = createMockCtx({ sessionId: "child", hasUI: true });

		// Parent comes online (empty branch → EMPTY_STATE in the parent slot) and
		// creates a task.
		await sessionStart({} as never, parent as never);
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "parent-task" } as never,
			undefined as never,
			undefined as never,
			parent as never,
		);
		expect(getState("parent").tasks.map((t) => t.subject)).toEqual(["parent-task"]);

		// A child session starts (empty branch). Its replay writes the CHILD slot
		// only — the parent slot is untouched.
		await sessionStart({} as never, child as never);
		expect(getState("parent").tasks.map((t) => t.subject)).toEqual(["parent-task"]);
		expect(getState("child").tasks).toEqual([]);
	});

	it("a child todo call mutates only the child's slot; the parent's /todos still shows only the parent's task", async () => {
		const { sessionStart, tool, cmd } = setup();
		const parent = createMockCtx({ sessionId: "parent", hasUI: true });
		const child = createMockCtx({ sessionId: "child", hasUI: true });

		await sessionStart({} as never, parent as never);
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "parent-task" } as never,
			undefined as never,
			undefined as never,
			parent as never,
		);
		await sessionStart({} as never, child as never);

		// Child creates its own task → lands in the CHILD slot only.
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "child-task" } as never,
			undefined as never,
			undefined as never,
			child as never,
		);
		expect(getState("child").tasks.map((t) => t.subject)).toEqual(["child-task"]);
		expect(getState("parent").tasks.map((t) => t.subject)).toEqual(["parent-task"]);

		// Parent's /todos reads the parent slot — shows only the parent's task.
		await cmd.handler("", parent as never);
		const parentNotify = parent.ui.notify as ReturnType<typeof vi.fn>;
		expect(parentNotify).toHaveBeenCalledTimes(1);
		expect(parentNotify.mock.calls[0][1]).toBe("info");
		expect(parentNotify.mock.calls[0][0]).toContain("parent-task");
		expect(parentNotify.mock.calls[0][0]).not.toContain("child-task");

		// Child's /todos reads the child slot — shows only the child's task.
		await cmd.handler("", child as never);
		const childNotify = child.ui.notify as ReturnType<typeof vi.fn>;
		expect(childNotify.mock.calls[0][0]).toContain("child-task");
		expect(childNotify.mock.calls[0][0]).not.toContain("parent-task");
	});

	it("the render pointer stays on the parent slot even after a child creates tasks (creator-ownership)", async () => {
		const { sessionStart, tool } = setup();
		const parent = createMockCtx({ sessionId: "parent", hasUI: true });
		const child = createMockCtx({ sessionId: "child", hasUI: true });

		await sessionStart({} as never, parent as never);
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "parent-task" } as never,
			undefined as never,
			undefined as never,
			parent as never,
		);

		// Child comes online and creates a task in its own slot.
		await sessionStart({} as never, child as never);
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "child-task" } as never,
			undefined as never,
			undefined as never,
			child as never,
		);

		// Creator-ownership: the render slot is still the parent's. (Phase 1 sets
		// the pointer once at overlay creation; a child hits the !todoOverlay guard
		// and cannot re-set it. NOTE: full child-rebind prevention is Phase 2.)
		expect(getRenderState().tasks.map((t) => t.subject)).toEqual(["parent-task"]);
		// Sanity: the child's task DID land in its own slot.
		expect(getState("child").tasks.map((t) => t.subject)).toEqual(["child-task"]);
	});

	it("session_shutdown evicts the shutting-down session's own slot (fresh EMPTY_STATE copy)", async () => {
		const { sessionStart, sessionShutdown, tool } = setup();
		const parent = createMockCtx({ sessionId: "parent", hasUI: true });

		await sessionStart({} as never, parent as never);
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "parent-task" } as never,
			undefined as never,
			undefined as never,
			parent as never,
		);
		expect(getState("parent").tasks).toHaveLength(1);

		await sessionShutdown({} as never, parent as never);

		// Slot evicted; a subsequent read returns a fresh EMPTY_STATE copy.
		const after = getState("parent");
		expect(after.tasks).toEqual([]);
		expect(after.nextId).toBe(1);
		expect(after.tasks).not.toBe(EMPTY_STATE.tasks);
	});
});

describe("rpiv-todo — foreground overlay policy (Slice 2)", () => {
	const PARENT = "parent-session";
	const CHILD = "child-session";
	const WIDGET_KEY = "rpiv-todos";

	function widgetSpy(ctx: ReturnType<typeof createMockCtx>) {
		return ctx.ui.setWidget as unknown as ReturnType<typeof vi.fn>;
	}

	function setup() {
		const { pi, captured } = createMockPi();
		registerTodo(pi);
		const start = captured.events.get("session_start")?.[0] as
			| ((e: unknown, ctx: unknown) => Promise<void>)
			| undefined;
		const shutdown = captured.events.get("session_shutdown")?.[0] as
			| ((e: unknown, ctx: unknown) => Promise<void>)
			| undefined;
		const toolEnd = captured.events.get("tool_execution_end")?.[0] as
			| ((event: { toolName: string; isError: boolean }) => Promise<void>)
			| undefined;
		const tool = captured.tools.get("todo");
		return { captured, start, shutdown, toolEnd, tool };
	}

	it("first hasUI session_start claims the foreground and renders its slot", async () => {
		const { start, toolEnd, tool } = setup();
		const parentCtx = createMockCtx({ hasUI: true, sessionId: PARENT });

		await start?.({}, parentCtx);
		expect(getActiveRenderSession()).toBe(PARENT);

		// Create a parent task; pump tool_execution_end so the overlay renders it.
		await tool?.execute?.(
			"tc",
			{ action: "create", subject: "parent task" } as never,
			undefined as never,
			undefined as never,
			parentCtx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		// Overlay registered a widget on the parent ui and renders the parent slot.
		expect(widgetSpy(parentCtx)).toHaveBeenCalled();
		expect(getRenderState().tasks.map((t) => t.subject)).toEqual(["parent task"]);
	});

	it("a child session_start (distinct sid, hasUI) does not claim foreground or rebind the overlay", async () => {
		const { start, toolEnd, tool } = setup();
		const parentCtx = createMockCtx({ hasUI: true, sessionId: PARENT });
		const childCtx = createMockCtx({ hasUI: true, sessionId: CHILD });

		await start?.({}, parentCtx);
		await tool?.execute?.(
			"tc",
			{ action: "create", subject: "parent task" } as never,
			undefined as never,
			undefined as never,
			parentCtx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		// Child session_start — distinct sid, hasUI true. Gate skips it.
		await start?.({}, childCtx);

		// Foreground unchanged; overlay still renders the parent slot.
		expect(getActiveRenderSession()).toBe(PARENT);
		expect(getRenderState().tasks.map((t) => t.subject)).toEqual(["parent task"]);
		// Child ui was never bound — setUICtx/update skipped by the sid gate.
		expect(widgetSpy(childCtx)).not.toHaveBeenCalled();
	});

	it("a child todo call writes the child's slot; the overlay still shows the parent's todos", async () => {
		const { start, toolEnd, tool } = setup();
		const parentCtx = createMockCtx({ hasUI: true, sessionId: PARENT });
		const childCtx = createMockCtx({ hasUI: true, sessionId: CHILD });

		await start?.({}, parentCtx);
		await tool?.execute?.(
			"tc",
			{ action: "create", subject: "parent task" } as never,
			undefined as never,
			undefined as never,
			parentCtx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		// Child starts (skipped by the gate) and runs its own todo.
		await start?.({}, childCtx);
		await tool?.execute?.(
			"tc",
			{ action: "create", subject: "child task" } as never,
			undefined as never,
			undefined as never,
			childCtx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		// Child slot holds the child task; the overlay (foreground = parent) shows parent's.
		expect(getState(CHILD).tasks.map((t) => t.subject)).toEqual(["child task"]);
		expect(getRenderState().tasks.map((t) => t.subject)).toEqual(["parent task"]);
	});

	it("a child session_shutdown does not dispose the foreground overlay", async () => {
		const { start, shutdown, toolEnd, tool } = setup();
		const parentCtx = createMockCtx({ hasUI: true, sessionId: PARENT });
		const childCtx = createMockCtx({ hasUI: true, sessionId: CHILD });

		await start?.({}, parentCtx);
		await tool?.execute?.(
			"tc",
			{ action: "create", subject: "parent task" } as never,
			undefined as never,
			undefined as never,
			parentCtx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		// Child shuts down — distinct sid; the teardown gate skips it.
		await shutdown?.({}, childCtx);

		// Foreground pointer + parent slot intact; no dispose call on the parent ui.
		expect(getActiveRenderSession()).toBe(PARENT);
		expect(getRenderState().tasks.map((t) => t.subject)).toEqual(["parent task"]);
		expect(widgetSpy(parentCtx)).not.toHaveBeenCalledWith(WIDGET_KEY, undefined);
	});

	it("the foreground's own session_shutdown disposes the overlay and clears foreground", async () => {
		const { start, shutdown, toolEnd, tool } = setup();
		const parentCtx = createMockCtx({ hasUI: true, sessionId: PARENT });

		await start?.({}, parentCtx);
		await tool?.execute?.(
			"tc",
			{ action: "create", subject: "parent task" } as never,
			undefined as never,
			undefined as never,
			parentCtx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		await shutdown?.({}, parentCtx);

		// Dispose path fires setWidget(KEY, undefined); pointer cleared; slot evicted.
		expect(widgetSpy(parentCtx)).toHaveBeenCalledWith(WIDGET_KEY, undefined);
		expect(getActiveRenderSession()).toBe("");
		expect(getState(PARENT).tasks).toEqual([]);
	});

	it("a headless launcher (hasUI:false) never constructs an overlay, nor does a headless child", async () => {
		const { start } = setup();
		const headlessCtx = createMockCtx({ hasUI: false, sessionId: PARENT });
		const childHeadlessCtx = createMockCtx({ hasUI: false, sessionId: CHILD });

		await start?.({}, headlessCtx);
		await start?.({}, childHeadlessCtx);

		// No foreground claimed; no widget registered on either ui.
		expect(getActiveRenderSession()).toBe("");
		expect(widgetSpy(headlessCtx)).not.toHaveBeenCalled();
		expect(widgetSpy(childHeadlessCtx)).not.toHaveBeenCalled();
	});
});
