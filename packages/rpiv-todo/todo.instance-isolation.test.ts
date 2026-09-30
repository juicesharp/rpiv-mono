import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	buildSessionEntries,
	createMockCtx,
	createMockPi,
	makeTheme,
	makeTodoToolResult,
} from "@juicesharp/rpiv-test-utils";
import { expect, it, vi } from "vitest";
import registerTodo from "./index.js";

const theme = makeTheme() as unknown as Theme;

function setup(sessionId: string, subject: string, hasUI = true) {
	const { pi, captured } = createMockPi();
	registerTodo(pi);
	const branch = buildSessionEntries([
		makeTodoToolResult({
			action: "create",
			params: { subject },
			tasks: [{ id: 1, subject, status: "pending" }],
			nextId: 2,
		}),
	]);
	const ctx = createMockCtx({ sessionId, hasUI, branch });
	let widget: Component | undefined;
	let lines: string[] = [];
	const render = () => {
		lines = widget?.render(200) ?? [];
	};
	const tui = { requestRender: render } as unknown as TUI;
	vi.mocked(ctx.ui.setWidget).mockImplementation((_key, content) => {
		widget = typeof content === "function" ? content(tui, theme) : undefined;
		render();
	});
	const tool = captured.tools.get("todo")!;
	async function emit(event: string, data = {}) {
		for (const handler of captured.events.get(event) ?? []) await handler(data as never, ctx as never);
	}
	return {
		ctx,
		emit,
		lines: () => lines.join("\n"),
		callTitle: () =>
			tool.renderCall!({ action: "get", id: 1 } as never, theme, undefined as never)
				.render(200)
				.join("\n"),
		async rename(subject: string) {
			await tool.execute("tc", { action: "update", id: 1, subject } as never, undefined, undefined, ctx as never);
			await emit("tool_execution_end", { toolName: "todo", isError: false });
		},
	};
}

it("binds cached-factory instances independently through rendering, replay, shutdown and replacement", async () => {
	// All instances use the same imported factory and store, just as the SDK cache does.
	const a = setup("instance-a", "alpha task");
	const b = setup("instance-b", "beta task");
	const child = setup("headless-child", "child task", false);
	await a.emit("session_start");
	await b.emit("session_start");
	await child.emit("session_start");
	expect(a.lines()).toContain("alpha task");
	expect(b.lines()).toContain("beta task");
	expect(a.lines()).not.toContain("beta task");
	expect(b.lines()).not.toContain("alpha task");
	expect(a.callTitle()).toContain("alpha task");
	expect(b.callTitle()).toContain("beta task");
	expect(child.ctx.ui.setWidget).not.toHaveBeenCalled();

	await b.rename("beta updated");
	expect(b.lines()).toContain("beta updated");
	expect(b.callTitle()).toContain("beta updated");
	expect(a.lines()).toContain("alpha task");
	await child.emit("session_shutdown");
	await a.emit("session_shutdown");
	expect(a.lines()).toBe("");
	expect(b.lines()).toContain("beta updated");
	expect(b.callTitle()).toContain("beta updated");

	// Replay restores each instance's persisted branch without touching another widget.
	await b.emit("session_compact");
	expect(b.lines()).toContain("beta task");
	await b.rename("beta changed again");
	await b.emit("session_tree");
	expect(b.lines()).toContain("beta task");
	const replacement = setup("instance-a", "alpha restored");
	await replacement.emit("session_start");
	expect(replacement.lines()).toContain("alpha restored");
	expect(replacement.callTitle()).toContain("alpha restored");
	expect(b.callTitle()).toContain("beta task");
	await replacement.emit("session_shutdown");
	await b.emit("session_shutdown");
});
