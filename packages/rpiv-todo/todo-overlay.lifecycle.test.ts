import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, createMockUI } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetState, registerTodoTool, setActiveRenderSession } from "./todo.js";
import { TodoOverlay } from "./todo-overlay.js";

const WIDGET_KEY = "rpiv-todos";

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

// Register the todo tool and seed module state via its real execute() — this
// exercises the same mutation path production uses.
async function seed(captured: ReturnType<typeof createMockPi>["captured"], actions: unknown[]) {
	const tool = captured.tools.get("todo");
	if (!tool) throw new Error("todo tool not registered");
	const ctx = createMockCtx();
	for (const p of actions) {
		await tool.execute?.("tc", p as never, undefined as never, undefined as never, ctx as never);
	}
	setActiveRenderSession("test-session");
	return tool;
}

function makeCtx() {
	return createMockUI() as unknown as ExtensionUIContext;
}

function registerTool() {
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	return { captured };
}

beforeEach(() => {
	__resetState();
});
afterEach(() => {
	__resetState();
	vi.restoreAllMocks();
});

describe("TodoOverlay — lifecycle", () => {
	it("update() with no UI ctx bound is a no-op", () => {
		const overlay = new TodoOverlay();
		expect(() => overlay.update()).not.toThrow();
	});

	it("update() with empty todos does not register a widget", () => {
		const overlay = new TodoOverlay();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		expect(ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("first update() with non-empty todos registers the widget exactly once", async () => {
		const { captured } = registerTool();
		await seed(captured, [{ action: "create", subject: "a" }]);
		const overlay = new TodoOverlay();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		expect(setWidget).toHaveBeenCalledTimes(1);
		expect(setWidget.mock.calls[0][0]).toBe(WIDGET_KEY);
		expect(typeof setWidget.mock.calls[0][1]).toBe("function");
		expect(setWidget.mock.calls[0][2]).toEqual({ placement: "aboveEditor" });
	});

	it("second update() after registration calls tui.requestRender instead of re-registering", async () => {
		const { captured } = registerTool();
		await seed(captured, [{ action: "create", subject: "a" }]);
		const overlay = new TodoOverlay();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		// Invoke the captured factory so overlay's internal `tui` ref is populated.
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0][1] as (
			tui: { requestRender: () => void },
			theme: typeof identityTheme,
		) => { render: (w: number) => string[]; invalidate: () => void };
		const tui = { requestRender: vi.fn() };
		factory(tui, identityTheme);
		overlay.update();
		expect(setWidget).toHaveBeenCalledTimes(1);
		expect(tui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("transition non-empty → empty unregisters the widget", async () => {
		const { captured } = registerTool();
		const tool = await seed(captured, [{ action: "create", subject: "a" }]);
		const overlay = new TodoOverlay();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		// Delete → then hard-remove via "clear" to leave visibility list empty.
		await tool.execute?.(
			"tc",
			{ action: "clear" } as never,
			undefined as never,
			undefined as never,
			createMockCtx() as never,
		);
		overlay.update();
		expect(setWidget).toHaveBeenCalledTimes(2);
		expect(setWidget.mock.calls[1]).toEqual([WIDGET_KEY, undefined]);
	});

	it("empty → non-empty after empty transition re-registers", async () => {
		const { captured } = registerTool();
		const tool = await seed(captured, [{ action: "create", subject: "a" }]);
		const overlay = new TodoOverlay();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		await tool.execute?.(
			"tc",
			{ action: "clear" } as never,
			undefined as never,
			undefined as never,
			createMockCtx() as never,
		);
		overlay.update();
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "b" } as never,
			undefined as never,
			undefined as never,
			createMockCtx() as never,
		);
		overlay.update();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		// calls: register, unregister, re-register
		expect(setWidget).toHaveBeenCalledTimes(3);
		expect(typeof setWidget.mock.calls[2][1]).toBe("function");
	});

	it("setUICtx(same ctx) is idempotent", async () => {
		const { captured } = registerTool();
		await seed(captured, [{ action: "create", subject: "a" }]);
		const overlay = new TodoOverlay();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		expect(setWidget).toHaveBeenCalledTimes(1);
	});

	it("setUICtx(different ctx) resets cached registration; next update re-registers under the new ctx", async () => {
		const { captured } = registerTool();
		await seed(captured, [{ action: "create", subject: "a" }]);
		const overlay = new TodoOverlay();
		const ui1 = makeCtx();
		overlay.setUICtx(ui1);
		overlay.update();
		const ui2 = makeCtx();
		overlay.setUICtx(ui2);
		overlay.update();
		expect(ui1.setWidget as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
		expect(ui2.setWidget as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
	});

	it("dispose() unregisters the widget and clears ctx; later update() without setUICtx is a no-op", async () => {
		const { captured } = registerTool();
		await seed(captured, [{ action: "create", subject: "a" }]);
		const overlay = new TodoOverlay();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		overlay.dispose();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		expect(setWidget).toHaveBeenCalledTimes(2);
		expect(setWidget.mock.calls[1]).toEqual([WIDGET_KEY, undefined]);
		// Further updates without rebinding should not touch the mock.
		overlay.update();
		expect(setWidget).toHaveBeenCalledTimes(2);
	});

	it("uses the current UI theme after invalidation without re-registering", async () => {
		const { captured } = registerTool();
		await seed(captured, [{ action: "create", subject: "a" }]);
		const overlay = new TodoOverlay();
		const colorTheme = (label: string) => ({
			...identityTheme,
			fg: (color: string, text: string) => `<${label}:${color}>${text}</${label}:${color}>`,
		});
		const initialTheme = colorTheme("initial");
		const factoryTheme = colorTheme("factory");
		const switchedTheme = colorTheme("switched");
		const ui = createMockUI({ theme: initialTheme as never }) as unknown as ExtensionUIContext;
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0][1] as (
			tui: { requestRender: () => void },
			theme: typeof identityTheme,
		) => { render: (w: number) => string[]; invalidate: () => void };
		const requestRender = vi.fn();
		const widget = factory({ requestRender }, factoryTheme);

		expect(widget.render(200).join("\n")).toContain("<initial:accent>");
		expect(widget.render(200).join("\n")).not.toContain("<factory:");

		Object.assign(ui, { theme: switchedTheme });
		widget.invalidate();
		expect(widget.render(200).join("\n")).toContain("<switched:accent>");
		expect(overlay.isRegistered()).toBe(true);

		overlay.update();
		expect(setWidget).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("resetCompletedDisplayState() lets replayed completed tasks be shown once again", async () => {
		const { captured } = registerTool();
		await seed(captured, [
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed" },
		]);
		const overlay = new TodoOverlay();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0][1] as (
			tui: { requestRender: () => void },
			theme: typeof identityTheme,
		) => { render: (w: number) => string[]; invalidate: () => void };
		const widget = factory({ requestRender: vi.fn() }, identityTheme);
		expect(widget.render(200).join("\n")).toContain("done");
		overlay.hideCompletedTasksFromPreviousTurn();
		expect(widget.render(200)).toEqual([]);
		overlay.resetCompletedDisplayState();
		expect(widget.render(200).join("\n")).toContain("done");
	});

	it("hideCompletedTasksFromPreviousTurn() is a no-op when nothing is pending hide", () => {
		const overlay = new TodoOverlay();
		expect(() => overlay.hideCompletedTasksFromPreviousTurn()).not.toThrow();
	});

	it("all-deleted todos count as empty (no widget)", async () => {
		const { captured } = registerTool();
		const tool = await seed(captured, [{ action: "create", subject: "a" }]);
		await tool.execute?.(
			"tc",
			{ action: "update", id: 1, status: "deleted" } as never,
			undefined as never,
			undefined as never,
			createMockCtx() as never,
		);
		const overlay = new TodoOverlay();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		expect(ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});
});

describe("TodoOverlay — collapse/expand state", () => {
	async function setupRegistered() {
		const { captured } = registerTool();
		await seed(captured, [
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "update", id: 1, status: "completed" },
		]);
		const overlay = new TodoOverlay();
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0][1] as (
			tui: { requestRender: (...args: unknown[]) => void },
			theme: typeof identityTheme,
		) => { render: (w: number) => string[]; invalidate: () => void };
		const requestRender = vi.fn();
		const widget = factory({ requestRender }, identityTheme);
		return { overlay, widget, requestRender, tool: captured.tools.get("todo")! };
	}

	it("a new TodoOverlay starts with collapsed = false (renders the full view, not the 3-line collapsed shape)", async () => {
		const { widget } = await setupRegistered();
		// Full render: heading + 1 remaining task + trailing spacer = 3 visible-ish
		// rows — but crucially NOT the collapsed "└─ ctrl+shift+t to expand" hint.
		const out = widget.render(200).join("\n");
		expect(out).not.toContain("ctrl+shift+t to expand");
	});

	it("toggleCollapse() flips collapsed and calls requestRender(true) (forced, distinct from the non-forced requestRender())", async () => {
		const { overlay, widget, requestRender } = await setupRegistered();
		// Collapse → toggles to collapsed and forces a redraw.
		overlay.toggleCollapse();
		expect(requestRender).toHaveBeenCalledWith(true);
		expect(widget.render(200).some((l) => l.includes("ctrl+shift+t to expand"))).toBe(true);

		requestRender.mockClear();
		// Expand → toggles back to expanded and forces a redraw again.
		overlay.toggleCollapse();
		expect(requestRender).toHaveBeenCalledWith(true);
		expect(widget.render(200).some((l) => l.includes("ctrl+shift+t to expand"))).toBe(false);
	});

	it("isRegistered() reflects the widget registration state", async () => {
		const overlay = new TodoOverlay();
		expect(overlay.isRegistered()).toBe(false);
		const { captured } = registerTool();
		await seed(captured, [{ action: "create", subject: "a" }]);
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		expect(overlay.isRegistered()).toBe(true);
		overlay.dispose();
		expect(overlay.isRegistered()).toBe(false);
	});

	it("resetCompletedDisplayState() does NOT reset collapsed", async () => {
		const { overlay, widget } = await setupRegistered();
		overlay.toggleCollapse(); // collapsed = true
		expect(widget.render(200).some((l) => l.includes("ctrl+shift+t to expand"))).toBe(true);
		// resetCompletedDisplayState clears the completed-display bookkeeping but
		// must leave the ephemeral `collapsed` flag alone (the "respect collapsed" seam).
		overlay.resetCompletedDisplayState();
		expect(widget.render(200).some((l) => l.includes("ctrl+shift+t to expand"))).toBe(true);
	});
});
