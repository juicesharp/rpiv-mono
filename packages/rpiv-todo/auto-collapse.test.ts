import { rmSync, writeFileSync } from "node:fs";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { configPath } from "@juicesharp/rpiv-config";
import { createMockUI } from "@juicesharp/rpiv-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAutoCollapse, saveAutoCollapse } from "./auto-collapse.ts";
import { __resetState, replaceState, setActiveRenderSession } from "./state/store.ts";
import { TodoOverlay } from "./todo-overlay.ts";

const theme = { fg: (_color: string, text: string) => text };
const file = configPath("rpiv-todo", "auto-collapse.json");

afterEach(() => {
	rmSync(file, { force: true });
	__resetState();
});

describe("automatic collapse", () => {
	it("defaults off, persists the selected state, and rejects malformed config", () => {
		expect(readAutoCollapse()).toBe(false);
		saveAutoCollapse(true);
		expect(readAutoCollapse()).toBe(true);
		saveAutoCollapse(false);
		expect(readAutoCollapse()).toBe(false);
		writeFileSync(file, "{}");
		expect(() => readAutoCollapse()).toThrow("Invalid auto-collapse configuration");
	});

	it("collapses away from the end, allows a temporary override, and restores the manual state", () => {
		setActiveRenderSession("test");
		replaceState("test", { nextId: 2, tasks: [{ id: 1, subject: "task", status: "pending" }] });
		const ui = createMockUI() as unknown as ExtensionUIContext;
		const overlay = new TodoOverlay();
		overlay.setUICtx(ui);
		overlay.update();
		const factory = vi.mocked(ui.setWidget).mock.calls[0][1] as (tui: TUI, theme: unknown) => Component;
		const tui = {
			mode: "fullscreen",
			isFollowingOutput: true,
			requestRender: vi.fn((force?: boolean) => {
				if (force) tui.isFollowingOutput = true;
			}),
		};
		const widget = factory(tui as unknown as TUI, theme);
		const click = () => widget.handleMouse?.({ type: "click", button: "left", x: 1, y: 0 } as never);
		expect(widget.render(80)[0]).toContain("[-]");
		tui.isFollowingOutput = false;
		expect(widget.render(80)[0]).toContain("[-]");
		overlay.setAutoCollapse(true);
		expect(widget.render(80)[0]).toContain("[+]");
		click();
		expect(widget.render(80)[0]).toContain("[-]");
		expect(widget.render(80)[0]).toContain("[-]");
		tui.isFollowingOutput = true;
		expect(widget.render(80)[0]).toContain("[-]");
		click();
		tui.isFollowingOutput = false;
		expect(widget.render(80)[0]).toContain("[+]");
		tui.isFollowingOutput = true;
		expect(widget.render(80)[0]).toContain("[+]");
		overlay.dispose();
	});
});
