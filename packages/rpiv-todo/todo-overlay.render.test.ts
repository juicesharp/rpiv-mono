import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, createMockUI } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetState, registerTodoTool, setActiveRenderSession, type TaskAction } from "./todo.js";
import { TodoOverlay } from "./todo-overlay.js";

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

async function setup(actions: Array<{ action: TaskAction; [k: string]: unknown }>, terminalRows = 24) {
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
	) => { render: (w: number) => string[]; invalidate: () => void };
	const tui = { requestRender: vi.fn(), terminal: { rows: terminalRows } };
	const widget = factory(tui, identityTheme);
	return { widget, tool, ui, overlay, tui };
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

describe("TodoOverlay — heading", () => {
	it("includes 'Todos (completed/total)' count", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "update", id: 1, status: "completed" },
		]);
		const lines = widget.render(200);
		expect(lines[0]).toContain("Todos (1/2)");
	});

	it("uses filled icon '●' when any task is active (pending/in_progress)", async () => {
		const { widget } = await setup([{ action: "create", subject: "a" }]);
		expect(widget.render(200)[0]).toContain("●");
	});

	it("uses hollow icon '○' when all tasks are completed", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "update", id: 1, status: "completed" },
		]);
		expect(widget.render(200)[0]).toContain("○");
	});
});

describe("TodoOverlay — natural-order rendering (no overflow)", () => {
	it("renders one line per visible task plus heading, last row uses '└─'", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "create", subject: "c" },
		]);
		const lines = widget.render(200);
		expect(lines).toHaveLength(5); // heading + 3 + trailing spacer
		expect(lines[1]).toContain("├─");
		expect(lines[2]).toContain("├─");
		expect(lines[3]).toContain("└─");
		expect(lines[4]).toBe(""); // trailing spacer below the panel
	});

	it("omits deleted tasks from the rendered output", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "visible" },
			{ action: "create", subject: "gone" },
			{ action: "update", id: 2, status: "deleted" },
		]);
		const out = widget.render(200).join("\n");
		expect(out).toContain("visible");
		expect(out).not.toContain("gone");
	});
});

describe("TodoOverlay — per-task formatting", () => {
	it("pending task uses '○' glyph", async () => {
		const { widget } = await setup([{ action: "create", subject: "pending-task" }]);
		expect(widget.render(200)[1]).toContain("○");
		expect(widget.render(200)[1]).toContain("pending-task");
	});

	it("in_progress task uses '◐' glyph and appends (activeForm)", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "do it", activeForm: "Doing it" },
			{ action: "update", id: 1, status: "in_progress" },
		]);
		const line = widget.render(200)[1];
		expect(line).toContain("◐");
		expect(line).toContain("do it");
		expect(line).toContain("(Doing it)");
	});

	it("completed task stays visible until the next agent turn starts", async () => {
		const { widget, overlay } = await setup([
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed" },
		]);
		const firstRender = widget.render(200);
		expect(firstRender[1]).toContain("✓");
		expect(firstRender[1]).toContain("done");
		expect(widget.render(200)[1]).toContain("done");
		overlay.hideCompletedTasksFromPreviousTurn();
		expect(widget.render(200)).toEqual([]);
	});

	it("keeps completed rows and counts visible across agent turns in session mode", async () => {
		writeConfigFile(JSON.stringify({ completedTaskVisibility: "session" }));
		const { widget, overlay } = await setup([
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed" },
			{ action: "create", subject: "next" },
		]);
		expect(widget.render(200).join("\n")).toContain("Todos (1/2)");
		overlay.hideCompletedTasksFromPreviousTurn();
		const nextTurn = widget.render(200).join("\n");
		expect(nextTurn).toContain("Todos (1/2)");
		expect(nextTurn).toContain("done");
		expect(nextTurn).toContain("next");
	});

	it("applies a session-to-turn policy change at the next agent turn", async () => {
		writeConfigFile(JSON.stringify({ completedTaskVisibility: "session" }));
		const { widget, overlay } = await setup([
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed" },
			{ action: "create", subject: "next" },
		]);
		// Rendering in session mode marks the retained rows. The following agent turn
		// must apply a switch back to turn mode immediately, not one turn later.
		expect(widget.render(200).join("\n")).toContain("Todos (1/2)");
		writeConfigFile(JSON.stringify({ completedTaskVisibility: "turn" }));
		overlay.hideCompletedTasksFromPreviousTurn();
		const nextTurn = widget.render(200).join("\n");
		expect(nextTurn).toContain("Todos (0/1)");
		expect(nextTurn).not.toContain("done");
		expect(nextTurn).toContain("next");
	});
});

describe("TodoOverlay — session completed-row folding", () => {
	it("folds only the oldest completed prefix, retains the newest five rows, and expands in place", async () => {
		writeConfigFile(
			JSON.stringify({
				completedTaskVisibility: "session",
				completedTaskPresentation: "chronological",
				maxVisibleCompleted: 5,
			}),
		);
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 7; i++) actions.push({ action: "create", subject: `task-${i}` });
		for (let i = 1; i <= 6; i++) actions.push({ action: "update", id: i, status: "completed" });
		const { widget, overlay } = await setup(actions);
		const folded = widget.render(200).join("\n");
		expect(folded).toContain("Todos (6/7)");
		expect(folded).toContain("▶ 1 completed");
		expect(folded).toContain("ctrl+shift+c to expand");
		expect(folded).not.toContain("task-1");
		for (let i = 2; i <= 7; i++) expect(folded).toContain(`task-${i}`);
		expect(folded.indexOf("▶ 1 completed")).toBeLessThan(folded.indexOf("task-2"));
		overlay.toggleCompletedRows();
		const expanded = widget.render(200).join("\n");
		expect(expanded).toContain("▼ 1 completed");
		expect(expanded).toContain("task-1");
		expect(expanded.indexOf("task-1")).toBeLessThan(expanded.indexOf("task-2"));
		overlay.toggleCompletedRows();
		expect(widget.render(200).join("\n")).not.toContain("task-1");
	});

	it("keeps all active and pending rows visible beyond maxWidgetLines", async () => {
		writeConfigFile(
			JSON.stringify({
				completedTaskVisibility: "session",
				completedTaskPresentation: "chronological",
				maxWidgetLines: 3,
			}),
		);
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 8; i++) actions.push({ action: "create", subject: `open-${i}` });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		for (let i = 1; i <= 8; i++) expect(lines.join("\n")).toContain(`open-${i}`);
		expect(lines).toHaveLength(10); // heading + 8 tasks + trailing spacer
		expect(lines.join("\n")).not.toContain("+5 more");
	});

	it("does not reorder or fold completed rows behind an unfinished task", async () => {
		writeConfigFile(
			JSON.stringify({
				completedTaskVisibility: "session",
				completedTaskPresentation: "chronological",
				maxVisibleCompleted: 5,
			}),
		);
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 8; i++) actions.push({ action: "create", subject: `task-${i}` });
		actions.push({ action: "update", id: 1, status: "completed" });
		for (let i = 3; i <= 8; i++) actions.push({ action: "update", id: i, status: "completed" });
		const { widget } = await setup(actions);
		const output = widget.render(200).join("\n");
		expect(output).not.toContain("▶");
		for (const i of [1, 3, 4, 5, 6, 7, 8]) expect(output).toContain(`task-${i}`);
		expect(output.indexOf("task-1")).toBeLessThan(output.indexOf("task-2"));
		expect(output.indexOf("task-2")).toBeLessThan(output.indexOf("task-3"));
	});

	it("keeps all completed rows expanded when the completed-row shortcut is off", async () => {
		writeConfigFile(
			JSON.stringify({
				completedTaskVisibility: "session",
				completedTaskPresentation: "chronological",
				maxVisibleCompleted: 0,
				completedCollapseKey: "off",
			}),
		);
		const { widget } = await setup([
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed" },
		]);
		const output = widget.render(200).join("\n");
		expect(output).toContain("done");
		expect(output).not.toContain("▶");
	});

	it("keeps completed rows expanded until the session shortcut has been bound", async () => {
		writeConfigFile(
			JSON.stringify({
				completedTaskVisibility: "session",
				completedTaskPresentation: "chronological",
				maxVisibleCompleted: 0,
			}),
		);
		const { widget, overlay } = await setup([
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed" },
		]);
		overlay.setCompletedRowsShortcutEnabled(false);
		const output = widget.render(200).join("\n");
		expect(output).toContain("done");
		expect(output).not.toContain("▶");
	});

	it("keeps completed rows expanded when the completed-row key collides with the whole-panel key", async () => {
		writeConfigFile(
			JSON.stringify({
				completedTaskVisibility: "session",
				completedTaskPresentation: "chronological",
				maxVisibleCompleted: 0,
				collapseKey: "ctrl+shift+c",
			}),
		);
		const { widget } = await setup([
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed" },
		]);
		const output = widget.render(200).join("\n");
		expect(output).toContain("done");
		expect(output).not.toContain("▶");
	});
});

describe("TodoOverlay — session priority presentation", () => {
	it("uses Claude-like priority order and a status-counted overflow summary by default", async () => {
		writeConfigFile(JSON.stringify({ completedTaskVisibility: "session" }));
		const { widget } = await setup(
			[
				{ action: "create", subject: "old-completed" },
				{ action: "update", id: 1, status: "completed" },
				{ action: "create", subject: "in-progress" },
				{ action: "update", id: 2, status: "in_progress" },
				{ action: "create", subject: "ready" },
				{ action: "create", subject: "blocked", blockedBy: [3] },
				{ action: "create", subject: "other-completed" },
				{ action: "update", id: 5, status: "completed" },
			],
			16,
		);
		const output = widget.render(200).join("\n");
		expect(output).toContain("Todos (2/5)");
		expect(output.indexOf("in-progress")).toBeLessThan(output.indexOf("ready"));
		expect(output.indexOf("ready")).toBeLessThan(output.indexOf("blocked"));
		expect(output).not.toContain("old-completed");
		expect(output).not.toContain("other-completed");
		expect(output).toContain("… +2 completed");
	});

	it("returns an expired recent completion to the older-completed overflow group", async () => {
		vi.useFakeTimers();
		try {
			writeConfigFile(JSON.stringify({ completedTaskVisibility: "session" }));
			const { widget, tool, tui } = await setup(
				[
					{ action: "create", subject: "old-completed" },
					{ action: "update", id: 1, status: "completed" },
					{ action: "create", subject: "in-progress" },
					{ action: "update", id: 2, status: "in_progress" },
					{ action: "create", subject: "newly-completed" },
					{ action: "create", subject: "ready" },
				],
				16,
			);
			widget.render(200); // establish the pre-completion snapshot
			await tool.execute?.(
				"tc",
				{ action: "update", id: 3, status: "completed" } as never,
				undefined as never,
				undefined as never,
				createMockCtx() as never,
			);
			let output = widget.render(200).join("\n");
			expect(output.indexOf("newly-completed")).toBeLessThan(output.indexOf("in-progress"));
			await vi.advanceTimersByTimeAsync(5_000);
			expect(tui.requestRender).toHaveBeenCalledWith(true);
			output = widget.render(200).join("\n");
			expect(output.indexOf("in-progress")).toBeLessThan(output.indexOf("ready"));
			expect(output).not.toContain("newly-completed");
			expect(output).toContain("… +1 completed");
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps original task order when the complete priority list fits the terminal budget", async () => {
		writeConfigFile(JSON.stringify({ completedTaskVisibility: "session" }));
		const { widget } = await setup(
			[
				{ action: "create", subject: "completed-first" },
				{ action: "update", id: 1, status: "completed" },
				{ action: "create", subject: "in-progress-second" },
				{ action: "update", id: 2, status: "in_progress" },
				{ action: "create", subject: "pending-third" },
			],
			24,
		);
		const output = widget.render(200).join("\n");
		expect(output.indexOf("completed-first")).toBeLessThan(output.indexOf("in-progress-second"));
		expect(output.indexOf("in-progress-second")).toBeLessThan(output.indexOf("pending-third"));
		expect(output).not.toContain("… +");
	});

	it("temporarily surfaces a task completed during the current session", async () => {
		writeConfigFile(JSON.stringify({ completedTaskVisibility: "session" }));
		const { widget, tool } = await setup(
			[
				{ action: "create", subject: "old-completed" },
				{ action: "update", id: 1, status: "completed" },
				{ action: "create", subject: "in-progress" },
				{ action: "update", id: 2, status: "in_progress" },
				{ action: "create", subject: "newly-completed" },
				{ action: "create", subject: "ready" },
			],
			16,
		);
		widget.render(200); // establish the pre-completion snapshot
		await tool.execute?.(
			"tc",
			{ action: "update", id: 3, status: "completed" } as never,
			undefined as never,
			undefined as never,
			createMockCtx() as never,
		);
		const output = widget.render(200).join("\n");
		expect(output.indexOf("newly-completed")).toBeLessThan(output.indexOf("in-progress"));
		expect(output.indexOf("in-progress")).toBeLessThan(output.indexOf("ready"));
		expect(output).not.toContain("old-completed");
	});
});

describe("TodoOverlay — showIds gate", () => {
	it("does NOT show #id prefix when no task has blockedBy", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
		]);
		const out = widget.render(200).join("\n");
		expect(out).not.toMatch(/#\d/);
	});

	it("shows #id prefix and '⛓' dep suffix when any task has blockedBy", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "base" },
			{ action: "create", subject: "follow-up", blockedBy: [1] },
		]);
		const out = widget.render(200).join("\n");
		expect(out).toContain("#1");
		expect(out).toContain("#2");
		expect(out).toContain("⛓");
	});
});

describe("TodoOverlay — overflow collapse", () => {
	it("drops completed first when dropping is enough", async () => {
		// 12 total = 8 pending + 4 completed. budget=10. All pending fit,
		// plus 2 of the 4 completed (in natural order). 2 completed hidden.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 8; i++) actions.push({ action: "create", subject: `p${i}` });
		for (let i = 9; i <= 12; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		// heading + 10 visible + 1 summary + trailing spacer = 13
		expect(lines).toHaveLength(13);
		// All pending present
		for (let i = 1; i <= 8; i++) expect(lines.join("\n")).toContain(`p${i}`);
		// Last row is the trailing spacer; the summary sits just above it
		expect(lines[lines.length - 1]).toBe("");
		expect(lines[lines.length - 2]).toContain("+2 more");
		expect(lines[lines.length - 2]).toContain("2 completed");
	});

	it("truncates pending tail when dropping all completed isn't enough", async () => {
		// 12 pending tasks → budget=10 → visible first 10, 2 pending truncated.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 12; i++) actions.push({ action: "create", subject: `t${i}` });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(13);
		expect(lines[lines.length - 1]).toBe("");
		const summary = lines[lines.length - 2];
		expect(summary).toContain("+2 more");
		expect(summary).toContain("2 pending");
		expect(summary).not.toContain("completed");
	});

	it("summary contains both 'completed' and 'pending' when mixed overflow", async () => {
		// 12 pending + 3 completed = 15 total. budget=10. All 12 pending won't
		// fit — visible = first 10 pending, truncatedTail = 2 pending, hidden
		// completed = 3. Summary: "+5 more (3 completed, 2 pending)".
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 12; i++) actions.push({ action: "create", subject: `p${i}` });
		for (let i = 13; i <= 15; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		const { widget } = await setup(actions);
		// Last line is the trailing spacer, so the summary is the second-to-last.
		const summary = widget.render(200).slice(-2)[0];
		expect(summary).toContain("+5 more");
		expect(summary).toContain("3 completed");
		expect(summary).toContain("2 pending");
	});

	it("hides overflowed completed tasks on the next agent turn too", async () => {
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 11; i++) actions.push({ action: "create", subject: `p${i}` });
		for (let i = 12; i <= 16; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		const { widget, overlay } = await setup(actions);
		const beforeNextTurn = widget.render(200).join("\n");
		expect(beforeNextTurn).toContain("Todos (5/16)");
		expect(beforeNextTurn).toContain("+6 more");
		expect(beforeNextTurn).toContain("5 completed");
		overlay.hideCompletedTasksFromPreviousTurn();
		const afterNextTurn = widget.render(200).join("\n");
		expect(afterNextTurn).toContain("Todos (0/11)");
		expect(afterNextTurn).toContain("p11");
		expect(afterNextTurn).not.toContain("+1 more");
		expect(afterNextTurn).not.toContain("completed");
	});

	it("does not engage overflow at exactly 11 visible tasks", async () => {
		// 11 tasks → all fit (heading + 11 = 12), plus trailing spacer = 13. No summary row.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 11; i++) actions.push({ action: "create", subject: `t${i}` });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(13);
		// Last row is the trailing spacer; the row above is the last task row
		expect(lines[lines.length - 1]).toBe("");
		expect(lines[lines.length - 2]).not.toContain("+");
		expect(lines[lines.length - 2]).toContain("└─");
	});
});

describe("TodoOverlay — collapse/expand render", () => {
	it("collapsed view returns exactly three lines: heading with (completed/total), expand hint, trailing spacer", async () => {
		const { widget, overlay } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "update", id: 1, status: "completed" },
		]);
		overlay.toggleCollapse(); // collapse
		const lines = widget.render(200);
		expect(lines).toHaveLength(3); // heading + hint + trailing spacer
		expect(lines[0]).toContain("Todos (1/2)");
		expect(lines[1]).toContain("└─");
		expect(lines[1]).toContain("ctrl+shift+t to expand");
		expect(lines[2]).toBe(""); // trailing spacer
	});

	it("uncollapsed (default) yields the unchanged full render (regression-safe)", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
		]);
		// Full render: heading + 2 tasks + trailing spacer = 4 lines
		const lines = widget.render(200);
		expect(lines).toHaveLength(4);
		expect(lines.some((l) => l.includes("a"))).toBe(true);
		expect(lines.some((l) => l.includes("b"))).toBe(true);
	});

	it("collapsed render short-circuits before completed-display tracking (no task queued for hide while collapsed)", async () => {
		const { widget, overlay } = await setup([
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed" },
		]);
		overlay.toggleCollapse(); // collapse
		widget.render(200); // collapsed render — must NOT queue the completed task
		// Draining the pending-hide set is a no-op because nothing was queued.
		overlay.hideCompletedTasksFromPreviousTurn();
		overlay.toggleCollapse(); // expand
		// The completed task is still visible: the collapsed render never queued it,
		// so the drain above couldn't hide it.
		const expanded = widget.render(200).join("\n");
		expect(expanded).toContain("done");
		expect(expanded).toContain("✓");
	});
});

describe("TodoOverlay — collapse hint resolves the key from config", () => {
	// resolveCollapseKey() runs at render time (per-render, like the row budget), so
	// the config MUST be written before widget.render(). setup() itself doesn't read
	// the collapse key — it constructs the overlay directly.

	it("renders the configured key in the collapsed hint (alt+o)", async () => {
		writeConfigFile(JSON.stringify({ collapseKey: "alt+o" }));
		const { widget, overlay } = await setup([{ action: "create", subject: "a" }]);
		overlay.toggleCollapse(); // collapse
		const lines = widget.render(200);
		expect(lines[1]).toContain("alt+o to expand");
		// The placeholder is always spliced — never leaks the raw {key} token.
		expect(lines[1]).not.toContain("{key}");
		expect(lines[1]).not.toContain("ctrl+shift+t");
	});

	it("renders the default key in the collapsed hint when config is missing", async () => {
		const { widget, overlay } = await setup([{ action: "create", subject: "a" }]);
		overlay.toggleCollapse(); // collapse
		const lines = widget.render(200);
		expect(lines[1]).toContain("ctrl+shift+t to expand");
		expect(lines[1]).not.toContain("{key}");
	});

	it("renders the default key when the configured spec is invalid", async () => {
		writeConfigFile(JSON.stringify({ collapseKey: "ctr+t" }));
		const { widget, overlay } = await setup([{ action: "create", subject: "a" }]);
		overlay.toggleCollapse(); // collapse
		const lines = widget.render(200);
		expect(lines[1]).toContain("ctrl+shift+t to expand");
	});

	it("renders a static collapsed label — not the sentinel — when the key resolves to off", async () => {
		// Reachable mid-session: collapse with a bound key, then edit the config to
		// "off" without /reload. The per-render resolver returns the sentinel; the
		// hint must not splice it into the {key} placeholder ("off to expand").
		const { widget, overlay } = await setup([{ action: "create", subject: "a" }]);
		overlay.toggleCollapse(); // collapse
		writeConfigFile(JSON.stringify({ collapseKey: "off" }));
		const lines = widget.render(200);
		expect(lines[1]).toContain("collapsed");
		expect(lines[1]).not.toContain("off to expand");
		expect(lines[1]).not.toContain("{key}");
	});
});

describe("TodoOverlay — width truncation", () => {
	it("renders without throwing at small widths", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a very long subject that would overflow a narrow column" },
		]);
		expect(() => widget.render(20)).not.toThrow();
	});

	it("drops completed tasks from counts after the next agent turn starts", async () => {
		const { widget, overlay } = await setup([
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed" },
			{ action: "create", subject: "next" },
		]);
		expect(widget.render(200).join("\n")).toContain("Todos (1/2)");
		const secondRender = widget.render(200).join("\n");
		expect(secondRender).toContain("Todos (1/2)");
		expect(secondRender).toContain("next");
		expect(secondRender).toContain("done");
		overlay.hideCompletedTasksFromPreviousTurn();
		const hiddenRender = widget.render(200).join("\n");
		expect(hiddenRender).toContain("Todos (0/1)");
		expect(hiddenRender).toContain("next");
		expect(hiddenRender).not.toContain("done");
	});

	it("re-renders reflect live state changes without re-registering", async () => {
		const { widget, tool } = await setup([{ action: "create", subject: "first" }]);
		const out1 = widget.render(200).join("\n");
		expect(out1).toContain("first");
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "second" } as never,
			undefined as never,
			undefined as never,
			createMockCtx() as never,
		);
		const out2 = widget.render(200).join("\n");
		expect(out2).toContain("first");
		expect(out2).toContain("second");
	});
});
