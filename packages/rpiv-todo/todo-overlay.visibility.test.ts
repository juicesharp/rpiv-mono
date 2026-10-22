import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMockCommandCtx, createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as config from "./config.ts";
import registerExtension from "./index.ts";
import { getRenderState } from "./state/store.ts";
import { setActiveRenderSession } from "./todo.ts";
import { TodoOverlay } from "./todo-overlay.ts";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-todo", "config.json");

function writeConfig(value: unknown): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(value), "utf-8");
}

async function seed() {
	const { pi, captured } = createMockPi();
	registerExtension(pi);

	const tool = captured.tools.get("todo");

	if (!tool?.execute) throw new Error("todo tool not registered");

	const result = await tool.execute(
		"create-task",
		{ action: "create", subject: "Keep this task" },
		undefined,
		undefined,
		createMockCtx(),
	);
	setActiveRenderSession("test-session");

	return { captured, result };
}

afterEach(() => {
	rmSync(CONFIG_PATH, { force: true });
	vi.restoreAllMocks();
});

describe("TodoOverlay widget visibility", () => {
	it.each([
		{ label: "missing configuration", value: undefined, enabled: true },
		{ label: "missing enabled field", value: { widget: {} }, enabled: true },
		{ label: "explicit true", value: { widget: { enabled: true } }, enabled: true },
		{ label: "explicit false", value: { widget: { enabled: false } }, enabled: false },
		{ label: "a string value", value: { widget: { enabled: "false" } }, enabled: true },
		{ label: "a null value", value: { widget: { enabled: null } }, enabled: true },
		{ label: "a null widget", value: { widget: null }, enabled: true },
	])("handles $label without changing task state", async ({ value, enabled }) => {
		if (value !== undefined) writeConfig(value);

		await seed();

		const before = structuredClone(getRenderState());
		const overlay = new TodoOverlay();
		const ui = createMockCtx({ hasUI: true }).ui;

		overlay.setUICtx(ui);
		overlay.update();

		expect({ state: getRenderState(), widgets: vi.mocked(ui.setWidget).mock.calls }).toStrictEqual({
			state: before,
			widgets: enabled ? [["rpiv-todos", expect.any(Function), { placement: "aboveEditor" }]] : [],
		});
	});

	it("keeps task persistence and /todos usable when the widget is disabled", async () => {
		writeConfig({ widget: { enabled: false } });

		const { captured, result } = await seed();
		const before = structuredClone(getRenderState());
		const recorded = structuredClone(result.details);
		const overlay = new TodoOverlay();
		const ui = createMockCtx({ hasUI: true }).ui;
		const command = captured.commands.get("todos");
		const commandCtx = createMockCommandCtx({ hasUI: true });

		if (!command) throw new Error("todos command not registered");

		overlay.setUICtx(ui);
		overlay.update();
		overlay.toggleCollapse();
		overlay.update();

		await command.handler("", commandCtx);

		expect({
			tools: [...captured.tools.keys()],
			commands: [...captured.commands.keys()],
			entries: captured.entries,
			state: getRenderState(),
			widgets: vi.mocked(ui.setWidget).mock.calls,
			notifications: vi.mocked(commandCtx.ui.notify).mock.calls,
		}).toStrictEqual({
			tools: ["todo"],
			commands: ["todos"],
			entries: [{ customType: "rpiv-todo-state", data: recorded }],
			state: before,
			widgets: [],
			notifications: [["1 pending\n── Pending ──\n  ○ #1 Keep this task", "info"]],
		});
	});

	it("reads visibility once per overlay instead of parsing config on each update", async () => {
		await seed();

		const readConfig = vi.spyOn(config, "loadConfig").mockReturnValue({ widget: { enabled: false } });
		const overlay = new TodoOverlay();
		const ui = createMockCtx({ hasUI: true }).ui;

		overlay.setUICtx(ui);
		overlay.update();
		overlay.update();

		expect({ reads: readConfig.mock.calls, widgets: vi.mocked(ui.setWidget).mock.calls }).toStrictEqual({
			reads: [[]],
			widgets: [],
		});
	});
});
