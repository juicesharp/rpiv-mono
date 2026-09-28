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
	return { widget, tool, ui, overlay, ctx };
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

	it("completed task fades only after K newer completions displace it", async () => {
		// Last-3 rule: the 1st-3rd completions stay on screen; completing a 4th
		// drops the oldest immediately — mid-turn, no agent_start needed.
		const { widget, tool, ctx } = await setup([
			{ action: "create", subject: "c1" },
			{ action: "create", subject: "c2" },
			{ action: "create", subject: "c3" },
			{ action: "create", subject: "c4" },
			{ action: "create", subject: "next" },
		]);
		for (let i = 1; i <= 3; i++) {
			await tool.execute?.(
				"tc",
				{ action: "update", id: i, status: "completed" } as never,
				undefined as never,
				undefined as never,
				ctx as never,
			);
		}
		const kept = widget.render(200).join("\n");
		expect(kept).toContain("c1");
		expect(kept).toContain("c3");
		await tool.execute?.(
			"tc",
			{ action: "update", id: 4, status: "completed" } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		const faded = widget.render(200).join("\n");
		expect(faded).not.toContain("c1");
		expect(faded).toContain("c2");
		expect(faded).toContain("c4");
		expect(faded).toContain("next");
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

	it("hides pending overflow behind the later marker when completed sit before the anchor", async () => {
		// 3 completed (all kept — within K) + 10 pending = 13. Anchor = p1 at
		// index 3; both markers → 9 task rows → window p1..p9, p10 folds into
		// the later marker.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 3; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		for (let i = 4; i <= 13; i++) actions.push({ action: "create", subject: `p${i}` });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(13);
		expect(lines.join("\n")).toContain("… 3 earlier");
		expect(lines.join("\n")).not.toContain("later");
		expect(lines.join("\n")).toContain("p9");
		expect(lines.join("\n")).toContain("p13");
		expect(lines.join("\n")).not.toContain("c3");
	});

	it("backfills an earlier completed task when the anchor sits at the window edge", async () => {
		// 3 completed + 9 pending = 12 → anchor p1 at index 3; only the later
		// marker qualifies (window reaches the end), so slots = 10 and the
		// window shifts left to idx 2: one completed row backfills the window.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 3; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		for (let i = 4; i <= 12; i++) actions.push({ action: "create", subject: `p${i}` });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(13);
		expect(lines[1]).toContain("… 2 earlier");
		expect(lines[2]).toContain("c3");
		expect(lines[3]).toContain("p4");
		expect(lines[11]).toContain("p12");
		expect(lines.join("\n")).not.toContain("later");
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

	it("shows only the K most recent completions when everything is done", async () => {
		// 13 completions → keep-last-3 eligibility leaves exactly the three
		// newest stamped rows — no windowing needed.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 13; i++) {
			actions.push({ action: "create", subject: `t${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(5); // heading + 3 kept rows + spacer
		expect(lines.join("\n")).toContain("Todos (3/3)");
		expect(lines.join("\n")).toContain("t11");
		expect(lines.join("\n")).toContain("t13");
		expect(lines.join("\n")).not.toContain("t10");
		expect(lines.join("\n")).not.toContain("earlier");
		expect(lines.join("\n")).not.toContain("later");
	});

	it("fades stale completed tasks out of the overflow window too", async () => {
		// 11 pending + 5 completed = 16 raw, but keep-last-3 eligibility leaves
		// only 3 completions → 14 overlay tasks: anchor p1, later-only marker →
		// 10 visible rows (p1..p10); p11 and the 3 kept completions hide behind
		// the marker.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 11; i++) actions.push({ action: "create", subject: `p${i}` });
		for (let i = 12; i <= 16; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		const { widget } = await setup(actions);
		const rendered = widget.render(200).join("\n");
		expect(rendered).toContain("Todos (3/14)");
		expect(rendered).toContain("… 4 later");
		expect(rendered).toContain("p10");
		expect(rendered).not.toContain("p11");
		expect(rendered).not.toContain("c15");
		expect(rendered).not.toContain("c16");
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

	it("keeps scattered in_progress rows visible above the focus window", async () => {
		// 15 tasks: in_progress at #3 and #11. Without hoisting, #11 would sit
		// behind the `… N later` marker; the active strip lifts it to the top.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 15; i++) actions.push({ action: "create", subject: `t${i}` });
		actions.push({ action: "update", id: 3, status: "in_progress" });
		actions.push({ action: "update", id: 11, status: "in_progress" });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		const body = lines.join("\n");
		// Both actives render as the first two body rows.
		expect(lines[1]).toContain("t3");
		expect(lines[2]).toContain("t11");
		// The rest window keeps remaining budget and hides middle pendings.
		expect(body).toContain("later");
		expect(body).not.toContain("more active");
		// 13 rest tasks in budget 9 → marker eats 1 → 8 rest rows + 2 actives.
		expect(lines).toHaveLength(13);
		expect(body).not.toContain("t15");
	});

	it("renders `… N more active` as the last row when the strip overflows", async () => {
		// 12 in_progress + 2 pending, budget 11 → cap B-2=9 actives + marker.
		writeConfigFile(JSON.stringify({ maxWidgetLines: 12 }));
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 12; i++) {
			actions.push({ action: "create", subject: `a${i}` });
			actions.push({ action: "update", id: i, status: "in_progress" });
		}
		actions.push({ action: "create", subject: "p13" });
		actions.push({ action: "create", subject: "p14" });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(12); // heading + 9 actives + marker + spacer
		expect(lines[1]).toContain("a1");
		expect(lines[9]).toContain("a9");
		expect(lines[10]).toMatch(/^└─/);
		expect(lines[10]).toContain("… 3 more active");
		const body = lines.join("\n");
		expect(body).not.toContain("a10");
		expect(body).not.toContain("p13");
		expect(body).not.toContain("later");
	});

	it("does not hoist actives on the degenerate two-row body budget", async () => {
		// maxWidgetLines=3 → heading + 2 rows: no room for strip + fold marker,
		// so the window runs over the filtered list like before.
		writeConfigFile(JSON.stringify({ maxWidgetLines: 3 }));
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [
			{ action: "create", subject: "c1" },
			{ action: "update", id: 1, status: "completed" },
		];
		for (let i = 2; i <= 4; i++) actions.push({ action: "create", subject: `p${i}` });
		actions.push({ action: "update", id: 4, status: "in_progress" });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(4);
		expect(lines[1]).toContain("p2");
		expect(lines[2]).toContain("+3 more");
		expect(lines.join("\n")).not.toContain("more active");
	});

	it("renders the strip naturally in expansion mode without markers", async () => {
		let toolsExpanded = false;
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 14; i++) actions.push({ action: "create", subject: `t${i}` });
		actions.push({ action: "update", id: 5, status: "in_progress" });
		actions.push({ action: "update", id: 12, status: "in_progress" });
		const { widget } = await setup(actions, { getToolsExpanded: () => toolsExpanded });
		const collapsed = widget.render(200).join("\n");
		expect(collapsed).toContain("later");

		toolsExpanded = true;
		const expanded = widget.render(200);
		expect(expanded).toHaveLength(16); // heading + 14 tasks + spacer
		const body = expanded.join("\n");
		expect(body).not.toContain("earlier");
		expect(body).not.toContain("later");
		expect(body).not.toContain("more active");
		// Expansion mode bypasses the strip and renders the list in natural
		// order (the strip exists only to rescue actives hidden by the window).
		expect(expanded[1]).toContain("t1");
		expect(expanded[5]).toContain("t5");
		expect(expanded[12]).toContain("t12");
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

	it("collapsed render does not interfere with completed fading", async () => {
		const { widget, overlay } = await setup([
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed" },
		]);
		overlay.toggleCollapse(); // collapse
		widget.render(200); // collapsed render
		overlay.toggleCollapse(); // expand
		// The completed task is still visible: fading is driven by completion
		// recency, not by whether a collapsed frame rendered it.
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

	it("drops faded completed tasks from the heading counts", async () => {
		// 4 completions → oldest fades → heading counts exclude it (done/total
		// derives from the eligible list, same as before).
		const { widget, tool, ctx } = await setup([
			{ action: "create", subject: "c1" },
			{ action: "create", subject: "c2" },
			{ action: "create", subject: "c3" },
			{ action: "create", subject: "c4" },
			{ action: "create", subject: "next" },
		]);
		expect(widget.render(200).join("\n")).toContain("Todos (0/5)");
		for (let i = 1; i <= 4; i++) {
			await tool.execute?.(
				"tc",
				{ action: "update", id: i, status: "completed" } as never,
				undefined as never,
				undefined as never,
				ctx as never,
			);
		}
		const rendered = widget.render(200).join("\n");
		expect(rendered).toContain("Todos (3/4)");
		expect(rendered).toContain("next");
		expect(rendered).not.toContain("c1");
		expect(rendered).toContain("c4");
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
