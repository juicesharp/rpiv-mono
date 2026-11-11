import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { createMockUI } from "@juicesharp/rpiv-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetState, replaceState, setActiveRenderSession } from "./state/store.ts";
import { TodoOverlay } from "./todo-overlay.ts";

const theme = { fg: (_color: string, text: string) => text };
const event: TuiMouseEvent = {
	type: "click",
	button: "left",
	x: 8,
	y: 0,
	screenX: 8,
	screenY: 0,
	width: 80,
	height: 4,
	shift: false,
	alt: false,
	ctrl: false,
};

function setup() {
	setActiveRenderSession("mouse-test");
	replaceState("mouse-test", { nextId: 2, tasks: [{ id: 1, subject: "task", status: "pending" }] });
	const ui = createMockUI() as unknown as ExtensionUIContext;
	const overlay = new TodoOverlay();
	overlay.setUICtx(ui);
	overlay.update();
	const factory = vi.mocked(ui.setWidget).mock.calls[0][1] as (tui: TUI, theme: unknown) => Component;
	const tui = { mode: "fullscreen", isFollowingOutput: true, requestRender: vi.fn() };
	return { overlay, widget: factory(tui as unknown as TUI, theme), tui };
}

afterEach(() => __resetState());

describe("todo heading mouse interaction", () => {
	it("toggles from the heading text and button", () => {
		const { widget } = setup();
		expect(widget.handleMouse?.(event)).toEqual({ handled: true });
		expect(widget.render(80)[0]).toContain("[+]");
		expect(widget.handleMouse?.({ ...event, x: 1 })).toEqual({ handled: true });
		expect(widget.render(80)[0]).toContain("[-]");
	});

	it("does not consume modified clicks, task rows, other buttons or non-click events", () => {
		const { widget, tui } = setup();
		for (const change of [
			{ shift: true },
			{ alt: true },
			{ ctrl: true },
			{ y: 1 },
			{ button: "right" },
			{ button: "middle" },
			{ type: "press" },
			{ type: "release" },
			{ type: "drag" },
			{ type: "move" },
			{ type: "wheel" },
		]) {
			expect(widget.handleMouse?.({ ...event, x: 1, ...change } as TuiMouseEvent)).toBeUndefined();
			expect(widget.render(80)[0]).toContain("[-]");
		}
		expect(tui.requestRender).not.toHaveBeenCalled();
	});
});
