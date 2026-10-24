import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, createMockUI } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import registerTodo from "./index.ts";
import { commitState, setActiveRenderSession } from "./state/store.ts";
import { TodoOverlay } from "./todo-overlay.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	strikethrough: (text: string) => text,
};

function mount(ui: ExtensionUIContext) {
	const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
	const factory = setWidget.mock.calls[0][1] as (
		tui: { requestRender: () => void },
		factoryTheme: typeof theme,
	) => { render: (width: number) => string[] };
	return factory({ requestRender: vi.fn() }, theme);
}

async function completedParent() {
	const { pi, captured } = createMockPi();
	registerTodo(pi);
	const parent = createMockCtx({ hasUI: true, sessionId: "parent" });
	const emit = async (name: string, ctx = parent) => {
		for (const handler of captured.events.get(name) ?? []) {
			await handler({} as never, ctx as never);
		}
	};
	await emit("session_start");
	const tool = captured.tools.get("todo")!;
	for (const params of [
		{ action: "create", subject: "finished parent task" },
		{ action: "update", id: 1, status: "completed" },
	]) {
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, parent);
	}
	for (const handler of captured.events.get("tool_execution_end") ?? []) {
		await handler({ toolName: "todo", isError: false } as never, parent as never);
	}
	const widget = mount(parent.ui);
	expect(widget.render(100).join("\n")).toContain("finished parent task");
	return { emit, parent, widget };
}

describe("completed todo visibility", () => {
	it("hides displayed completions on the next foreground turn within the same agent run", async () => {
		const { emit, widget } = await completedParent();
		await emit("turn_start");
		expect(widget.render(100)).toEqual([]);
	});

	it("does not let child agent or turn starts hide foreground completions", async () => {
		const { emit, widget } = await completedParent();
		const child = createMockCtx({ hasUI: true, sessionId: "child" });
		await emit("agent_start", child);
		await emit("turn_start", child);
		expect(widget.render(100).join("\n")).toContain("finished parent task");
		await emit("turn_start");
		expect(widget.render(100)).toEqual([]);
	});

	it("unregisters the panel when its last displayed completion is hidden", () => {
		setActiveRenderSession("parent");
		commitState("parent", {
			tasks: [{ id: 1, subject: "finished", status: "completed" }],
			nextId: 2,
		});
		const overlay = new TodoOverlay();
		const ui = createMockUI() as unknown as ExtensionUIContext;
		overlay.setUICtx(ui);
		overlay.update();
		mount(ui).render(100);
		overlay.hideCompletedTasksFromPreviousTurn();
		expect(overlay.isRegistered()).toBe(false);
		expect(ui.setWidget).toHaveBeenLastCalledWith("rpiv-todos", undefined);
	});

	it("keeps overflow completions available until they have actually been displayed", () => {
		setActiveRenderSession("parent");
		commitState("parent", {
			tasks: Array.from({ length: 12 }, (_, index) => ({
				id: index + 1,
				subject: `done-${index + 1}`,
				status: "completed" as const,
			})),
			nextId: 13,
		});
		let expanded = false;
		const ui = createMockUI({ getToolsExpanded: () => expanded }) as unknown as ExtensionUIContext;
		const overlay = new TodoOverlay();
		overlay.setUICtx(ui);
		overlay.update();
		const widget = mount(ui);
		const first = widget.render(100).join("\n");
		expect(first).toContain("done-10");
		expect(first).not.toContain("done-11");
		overlay.hideCompletedTasksFromPreviousTurn();
		expanded = true;
		const next = widget.render(100).join("\n");
		expect(next).toContain("done-11");
		expect(next).toContain("done-12");
		expect(next).not.toContain("done-10");
		expect(overlay.isRegistered()).toBe(true);
	});
});
