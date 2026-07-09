import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerTodo from "./index.js";
import { __resetState } from "./todo.js";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-todo", "config.json");

function writeConfigFile(contents: string): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, contents, "utf-8");
}
function removeConfigFile(): void {
	rmSync(CONFIG_PATH, { force: true });
}

// Drives the composer's default export (index.ts) to verify the collapse/expand
// shortcut registration and handler guard ladder. registerTodo() builds a fresh
// closure each call, so isolation is automatic given __resetState() clears the
// store. The shortcut handler closes over the closure-local `todoOverlay` and
// re-reads it at fire time — the session_start event is what (lazily) constructs
// that overlay, so driving the event is what makes the toggle path reachable.
function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodo(pi);
	const sessionStart = captured.events.get("session_start")?.[0];
	const toolEnd = captured.events.get("tool_execution_end")?.[0] as
		| ((event: { toolName: string; isError: boolean }) => Promise<void>)
		| undefined;
	const tool = captured.tools.get("todo");
	if (!sessionStart) throw new Error("session_start handler not registered");
	if (!toolEnd) throw new Error("tool_execution_end handler not registered");
	if (!tool) throw new Error("todo tool not registered");
	return { captured, sessionStart, toolEnd, tool };
}

beforeEach(() => {
	__resetState();
	removeConfigFile();
});
afterEach(() => {
	__resetState();
	removeConfigFile();
});

describe("rpiv-todo — collapse/expand shortcut registration", () => {
	it("registers 'ctrl+shift+t' with a description at factory scope", () => {
		const { captured } = setup();
		const shortcut = captured.shortcuts.get("ctrl+shift+t");
		expect(shortcut).toBeDefined();
		expect(typeof shortcut?.description).toBe("string");
		expect(shortcut?.description).toContain("Collapse");
	});

	it("handler is a no-op in headless mode (!ctx.hasUI)", async () => {
		const { captured, sessionStart, toolEnd, tool } = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await sessionStart?.({} as never, ctx as never);
		// Seed a task and pump tool_execution_end so the widget registers.
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "a" } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		const handler = captured.shortcuts.get("ctrl+shift+t")?.handler;
		expect(handler).toBeDefined();
		// Headless ctx: handler bails before touching the overlay — must not throw.
		await handler?.({ hasUI: false } as never);
		// The overlay (foreground) widget was registered exactly once — no toggle.
		expect(ctx.ui.setWidget as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
	});

	it("handler is a no-op before any session_start created the overlay (!todoOverlay)", async () => {
		const { captured } = setup();
		// No session_start fired yet → closure-local todoOverlay is undefined.
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await captured.shortcuts.get("ctrl+shift+t")?.handler?.(ctx as never);
		expect(ctx.ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("handler is a no-op when the overlay exists but the widget is not registered (!isRegistered, empty list)", async () => {
		const { captured, sessionStart } = setup();
		// A UI-bearing session_start constructs the overlay, but with no tasks the
		// widget never registers (auto-hide on empty) → isRegistered() is false.
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await sessionStart?.({} as never, ctx as never);
		expect(ctx.ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

		await captured.shortcuts.get("ctrl+shift+t")?.handler?.(ctx as never);
		// Still unregistered — toggle never fired.
		expect(ctx.ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("handler toggles the overlay when it is registered (render shape flips to the collapsed hint)", async () => {
		const { captured, sessionStart, toolEnd, tool } = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await sessionStart?.({} as never, ctx as never);
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "a" } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		const setWidget = ctx.ui.setWidget as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0][1] as (
			tui: { requestRender: (...args: unknown[]) => void },
			theme: { fg: (c: string, s: string) => string },
		) => { render: (w: number) => string[]; invalidate: () => void };
		const requestRender = vi.fn();
		const identityTheme = { fg: (_c: string, s: string) => s } as unknown as {
			fg: (c: string, s: string) => string;
		};
		const widget = factory({ requestRender }, identityTheme);

		// Before: expanded render carries the task, not the collapse hint.
		expect(widget.render(200).some((l) => l.includes("ctrl+shift+t to expand"))).toBe(false);

		// Toggle → collapses; forced redraw on the height step.
		await captured.shortcuts.get("ctrl+shift+t")?.handler?.(ctx as never);
		expect(requestRender).toHaveBeenCalledWith(true);
		expect(widget.render(200).some((l) => l.includes("ctrl+shift+t to expand"))).toBe(true);

		// Toggle again → re-expands; hint gone.
		await captured.shortcuts.get("ctrl+shift+t")?.handler?.(ctx as never);
		expect(widget.render(200).some((l) => l.includes("ctrl+shift+t to expand"))).toBe(false);
	});
});

describe("rpiv-todo — collapse/expand shortcut config resolution", () => {
	// resolveCollapseKey() runs inside registerTodo() at factory scope, reading the
	// config file fresh from disk — so the config MUST be written before setup().

	it("registers the configured key (collapseKey: 'alt+o') instead of the default", () => {
		writeConfigFile(JSON.stringify({ collapseKey: "alt+o" }));
		const { captured } = setup();
		expect(captured.shortcuts.has("alt+o")).toBe(true);
		expect(captured.shortcuts.has("ctrl+shift+t")).toBe(false);
	});

	it("skips registerShortcut entirely when collapseKey is 'off'", () => {
		writeConfigFile(JSON.stringify({ collapseKey: "off" }));
		const { captured } = setup();
		expect(captured.shortcuts.size).toBe(0);
	});

	it("falls back to the default key when collapseKey is invalid", () => {
		writeConfigFile(JSON.stringify({ collapseKey: "ctr+t" }));
		const { captured } = setup();
		expect(captured.shortcuts.has("ctrl+shift+t")).toBe(true);
	});

	it("default config registers the default key (ctrl+shift+t)", () => {
		const { captured } = setup();
		expect(captured.shortcuts.has("ctrl+shift+t")).toBe(true);
	});
});
