import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi, createMockUI } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetState, registerTodoTool, setActiveRenderSession, type TaskAction } from "./todo.ts";
import { TodoOverlay } from "./todo-overlay.ts";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-todo", "config.json");

function writeConfigFile(contents: string): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, contents, "utf-8");
}
function removeConfigFile(): void {
	rmSync(CONFIG_PATH, { force: true });
}

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

/** A normalized click on the heading row (local y=0), overridable per case. */
function headingClick(overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 3,
		y: 0,
		screenX: 13,
		screenY: 40,
		width: 120,
		height: 1,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	};
}

async function setup(actions: Array<{ action: TaskAction; [k: string]: unknown }>) {
	__resetState();
	setActiveRenderSession("test-session");
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const tool = captured.tools.get("todo")!;
	const ctx = createMockCtx();
	for (const p of actions) {
		await tool.execute?.("tc", p as never, undefined as never, undefined as never, ctx as never);
	}
	const ui = createMockUI() as unknown as ExtensionUIContext;
	const overlay = new TodoOverlay();
	overlay.setUICtx(ui);
	overlay.update();
	const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
	const factory = setWidget.mock.calls[0][1] as (
		tui: { requestRender: () => void },
		theme: typeof identityTheme,
	) => {
		render: (w: number) => string[];
		invalidate: () => void;
		handleMouse?: (event: TuiMouseEvent) => { handled?: boolean } | undefined;
	};
	const widget = factory({ requestRender: vi.fn() }, identityTheme);
	return { widget, tool, ui, overlay };
}

const twoTasks = [
	{ action: "create" as TaskAction, subject: "a" },
	{ action: "create" as TaskAction, subject: "b" },
];

function isCollapsed(widget: { render: (w: number) => string[] }): boolean {
	return widget.render(200).some((line) => line.includes("to expand") || line.includes("collapsed"));
}

beforeEach(() => {
	__resetState();
	removeConfigFile();
});
afterEach(() => {
	__resetState();
	removeConfigFile();
	vi.restoreAllMocks();
});

describe("TodoOverlay — header click toggles the panel", () => {
	it("collapses on an unmodified left click on the heading row", async () => {
		const { widget } = await setup(twoTasks);
		expect(isCollapsed(widget)).toBe(false);
		const result = widget.handleMouse?.(headingClick());
		expect(isCollapsed(widget)).toBe(true);
		expect(result?.handled).toBe(true);
	});

	it("expands again on the next heading click", async () => {
		const { widget } = await setup(twoTasks);
		widget.handleMouse?.(headingClick());
		expect(isCollapsed(widget)).toBe(true);
		widget.handleMouse?.(headingClick());
		expect(isCollapsed(widget)).toBe(false);
	});

	it("ignores clicks on task rows", async () => {
		const { widget } = await setup(twoTasks);
		const result = widget.handleMouse?.(headingClick({ y: 1 }));
		expect(isCollapsed(widget)).toBe(false);
		expect(result).toBeUndefined();
	});

	it("ignores modified clicks", async () => {
		for (const modifier of ["shift", "alt", "ctrl"] as const) {
			const { widget } = await setup(twoTasks);
			const result = widget.handleMouse?.(headingClick({ [modifier]: true }));
			expect(isCollapsed(widget)).toBe(false);
			expect(result).toBeUndefined();
		}
	});

	it("ignores non-left buttons", async () => {
		for (const button of ["right", "middle"] as const) {
			const { widget } = await setup(twoTasks);
			const result = widget.handleMouse?.(headingClick({ button }));
			expect(isCollapsed(widget)).toBe(false);
			expect(result).toBeUndefined();
		}
	});

	it("ignores press, release, drag, move and wheel events", async () => {
		for (const type of ["press", "release", "drag", "move", "wheel"] as const) {
			const { widget } = await setup(twoTasks);
			const result = widget.handleMouse?.(headingClick({ type }));
			expect(isCollapsed(widget)).toBe(false);
			expect(result).toBeUndefined();
		}
	});

	it("toggles even when the keyboard shortcut is off", async () => {
		writeConfigFile(JSON.stringify({ collapseKey: "off" }));
		const { widget } = await setup(twoTasks);
		widget.handleMouse?.(headingClick());
		expect(isCollapsed(widget)).toBe(true);
		widget.handleMouse?.(headingClick());
		expect(isCollapsed(widget)).toBe(false);
	});

	it("toggles a collapsed panel back open from the same heading row", async () => {
		const { widget, overlay } = await setup(twoTasks);
		overlay.toggleCollapse(); // collapsed via the shortcut path
		expect(isCollapsed(widget)).toBe(true);
		widget.handleMouse?.(headingClick());
		expect(isCollapsed(widget)).toBe(false);
	});
});
