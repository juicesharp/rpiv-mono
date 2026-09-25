import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
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

async function setup(
	actions: Array<{ action: TaskAction; [k: string]: unknown }>,
	uiOverrides: Partial<Omit<ExtensionUIContext, "theme">> = {},
) {
	__resetState();
	setActiveRenderSession("test-session");
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const tool = captured.tools.get("todo")!;
	const ctx = createMockCtx();
	for (const p of actions) {
		await tool.execute?.("tc", p as never, undefined as never, undefined as never, ctx as never);
	}
	const ui = createMockUI(uiOverrides) as unknown as ExtensionUIContext;
	const overlay = new TodoOverlay();
	overlay.setUICtx(ui);
	overlay.update();
	const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
	const factory = setWidget.mock.calls[0][1] as (
		tui: { requestRender: () => void },
		theme: typeof identityTheme,
	) => { render: (w: number) => string[]; invalidate: () => void };
	const widget = factory({ requestRender: vi.fn() }, identityTheme);
	return { widget, tool, ui, overlay };
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

describe("TodoOverlay — overflow focus window", () => {
	it("starts at the top when the first task is unfinished", async () => {
		// 12 pending tasks → budget=11 → marker reserves one row, visible first 10.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 12; i++) actions.push({ action: "create", subject: `t${i}` });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(13);
		expect(lines[1]).toContain("t1");
		expect(lines[10]).toContain("t10");
		expect(lines[11]).toContain("└─");
		expect(lines[11]).toContain("… 2 later");
		expect(lines.join("\n")).not.toContain("t11");
		expect(lines.join("\n")).not.toContain("earlier");
	});

	it("hides a completed tail behind the later marker", async () => {
		// 8 pending + 4 completed = 12 total. The window starts at the first task
		// (already unfinished), so the trailing completed pair folds into the
		// later marker.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 8; i++) actions.push({ action: "create", subject: `p${i}` });
		for (let i = 9; i <= 12; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(13);
		for (let i = 1; i <= 8; i++) expect(lines.join("\n")).toContain(`p${i}`);
		expect(lines.join("\n")).toContain("c9");
		expect(lines.join("\n")).toContain("c10");
		expect(lines.join("\n")).not.toContain("c11");
		expect(lines[lines.length - 2]).toContain("… 2 later");
		expect(lines.join("\n")).not.toContain("earlier");
	});

	it("anchors the window at the first unfinished task", async () => {
		// 3 completed + 12 pending = 15 total → both markers, 9 task rows.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 3; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		for (let i = 4; i <= 15; i++) actions.push({ action: "create", subject: `p${i}` });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(13);
		expect(lines[1]).toMatch(/^├─/);
		expect(lines[1]).toContain("… 3 earlier");
		expect(lines[2]).toContain("p4");
		expect(lines[10]).toContain("p12");
		expect(lines[11]).toMatch(/^└─/);
		expect(lines[11]).toContain("… 3 later");
		expect(lines.join("\n")).not.toContain("c3");
		expect(lines.join("\n")).not.toContain("p13");
	});

	it("backfills from earlier tasks so the window stays full", async () => {
		// 9 completed + 3 pending = 12 total → the anchor is near the end, so the
		// window shifts backward and keeps 10 task rows; only the earlier marker.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 9; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		for (let i = 10; i <= 12; i++) actions.push({ action: "create", subject: `p${i}` });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(13);
		expect(lines[1]).toContain("… 2 earlier");
		expect(lines[2]).toContain("c3");
		expect(lines[11]).toContain("p12");
		expect(lines[11]).toContain("└─");
		expect(lines.join("\n")).not.toContain("c2");
		expect(lines.join("\n")).not.toContain("later");
	});

	it("shows the final window when every task is completed", async () => {
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 13; i++) {
			actions.push({ action: "create", subject: `t${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(13);
		expect(lines[1]).toContain("… 3 earlier");
		expect(lines[2]).toContain("t4");
		expect(lines[11]).toContain("t13");
		expect(lines[11]).toContain("└─");
		expect(lines.join("\n")).not.toContain("later");
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
		expect(beforeNextTurn).toContain("… 6 later");
		overlay.hideCompletedTasksFromPreviousTurn();
		const afterNextTurn = widget.render(200).join("\n");
		expect(afterNextTurn).toContain("Todos (0/11)");
		expect(afterNextTurn).toContain("p11");
		expect(afterNextTurn).not.toContain("earlier");
		expect(afterNextTurn).not.toContain("later");
		expect(afterNextTurn).not.toContain("completed");
	});

	it("does not engage overflow at exactly 11 visible tasks", async () => {
		// 11 tasks → all fit (heading + 11 = 12), plus trailing spacer = 13. No marker rows.
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

	it("follows Pi's tool-output expansion mode and renders every task", async () => {
		let toolsExpanded = false;
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 17; i++) actions.push({ action: "create", subject: `t${i}` });
		const { widget } = await setup(actions, { getToolsExpanded: () => toolsExpanded });

		const collapsed = widget.render(200).join("\n");
		expect(collapsed).toContain("… 7 later");
		expect(collapsed).not.toContain("t17");

		toolsExpanded = true;
		const expanded = widget.render(200);
		expect(expanded).toHaveLength(19); // heading + 17 tasks + trailing spacer
		expect(expanded.join("\n")).toContain("t17");
		expect(expanded.join("\n")).not.toContain("earlier");
		expect(expanded.join("\n")).not.toContain("later");
		expect(expanded[expanded.length - 2]).toContain("└─");

		toolsExpanded = false;
		expect(widget.render(200).join("\n")).toContain("… 7 later");
	});

	it("keeps the configured budget when the host has no expansion-state API", async () => {
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 17; i++) actions.push({ action: "create", subject: `t${i}` });
		const { widget } = await setup(actions);
		expect(widget.render(200).join("\n")).toContain("… 7 later");
	});

	it("folds both hidden sides into one summary on a two-row body budget", async () => {
		// maxWidgetLines=3 → heading + 2 body rows. With an unfinished anchor in
		// the middle there is no room for two marker rows, so the overflow folds
		// into a single legacy `+N more` bottom summary.
		writeConfigFile(JSON.stringify({ maxWidgetLines: 3 }));
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 2; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		for (let i = 3; i <= 5; i++) actions.push({ action: "create", subject: `p${i}` });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(4);
		expect(lines[1]).toContain("p3");
		expect(lines[2]).toContain("+4 more");
		expect(lines.join("\n")).not.toContain("earlier");
		expect(lines.join("\n")).not.toContain("later");
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
