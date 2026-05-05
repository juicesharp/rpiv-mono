import { createMockPi, makeTheme } from "@juicesharp/rpiv-test-utils";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetState, registerTodoTool, type TaskDetails, TOOL_NAME } from "./todo.js";

const theme = makeTheme() as unknown as Theme;

function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const tool = captured.tools.get(TOOL_NAME);
	if (!tool) throw new Error("tool not registered");
	return { tool, captured };
}

async function call(tool: ReturnType<typeof setup>["tool"], params: Record<string, unknown>) {
	return tool.execute?.("tc", params as never, undefined as never, undefined as never, {} as never);
}

beforeEach(() => {
	__resetState();
});
afterEach(() => {
	__resetState();
});

describe("registerTodoTool — registration shape", () => {
	it("registers under the tool name 'todo' with the expected label and guidelines", () => {
		const { captured } = setup();
		const tool = captured.tools.get("todo")!;
		expect(tool.name).toBe("todo");
		expect(tool.label).toBe("Todo");
		expect(tool.promptSnippet).toContain("task list");
		expect(Array.isArray(tool.promptGuidelines)).toBe(true);
		expect((tool.promptGuidelines as string[]).length).toBeGreaterThan(0);
	});

	it("exposes a typebox parameters schema declaring the six actions", () => {
		const { tool } = setup();
		const raw = JSON.stringify(tool.parameters);
		for (const action of ["create", "update", "list", "get", "delete", "clear"]) {
			expect(raw).toContain(action);
		}
	});
});

describe("registerTodoTool — execute mutates module state", () => {
	it("create → list returns the seeded row", async () => {
		const { tool } = setup();
		const r1 = await call(tool, { action: "create", subject: "first" });
		expect((r1?.details as TaskDetails).action).toBe("create");
		const r2 = await call(tool, { action: "list" });
		expect(r2?.content[0]).toMatchObject({ text: expect.stringContaining("first") });
	});

	it("clear resets module state and nextId", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		await call(tool, { action: "create", subject: "b" });
		const r = await call(tool, { action: "clear" });
		const d = r?.details as TaskDetails;
		expect(d.tasks).toEqual([]);
		expect(d.nextId).toBe(1);
	});
});

describe("registerTodoTool — renderCall", () => {
	it("create action emits 'todo +' and includes the subject", () => {
		const { tool } = setup();
		const node = tool.renderCall?.(
			{ action: "create", subject: "hello" } as never,
			theme,
			undefined as never,
		) as unknown as Text;
		expect(node).toBeInstanceOf(Text);
		const text = (node as unknown as { text: string }).text;
		expect(text).toContain("todo ");
		expect(text).toContain("+");
		expect(text).toContain("hello");
	});

	it("update action renders '#id' when the task has not been registered yet", () => {
		const { tool } = setup();
		const node = tool.renderCall?.(
			{ action: "update", id: 42 } as never,
			theme,
			undefined as never,
		) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("#42");
	});

	it("update action renders the task subject when seeded", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "seeded-subject" });
		const node = tool.renderCall?.(
			{ action: "update", id: 1 } as never,
			theme,
			undefined as never,
		) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("seeded-subject");
	});

	it("list action with a status filter renders the humanized status label", () => {
		const { tool } = setup();
		const node = tool.renderCall?.(
			{ action: "list", status: "in_progress" } as never,
			theme,
			undefined as never,
		) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("in progress");
	});

	it("clear action renders only the base prefix + glyph", () => {
		const { tool } = setup();
		const node = tool.renderCall?.({ action: "clear" } as never, theme, undefined as never) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("∅");
	});
});

describe("registerTodoTool — renderResult", () => {
	it("create renders the new task's status label (pending)", async () => {
		const { tool } = setup();
		const r = await call(tool, { action: "create", subject: "a" });
		const node = tool.renderResult?.(r as never, {} as never, theme, undefined as never) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("pending");
		expect((node as unknown as { text: string }).text).toContain("○");
	});

	it("update renders the transitioned status (in progress)", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		const r = await call(tool, { action: "update", id: 1, status: "in_progress" });
		const node = tool.renderResult?.(r as never, {} as never, theme, undefined as never) as unknown as Text;
		const text = (node as unknown as { text: string }).text;
		expect(text).toContain("in progress");
		expect(text).toContain("◐");
	});

	it("delete renders the deleted-tombstone label", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		const r = await call(tool, { action: "delete", id: 1 });
		const node = tool.renderResult?.(r as never, {} as never, theme, undefined as never) as unknown as Text;
		const text = (node as unknown as { text: string }).text;
		expect(text).toContain("deleted");
		expect(text).toContain("⊘");
	});

	it("list renders the plain '✓' fallback (no status leakage)", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		const r = await call(tool, { action: "list" });
		const node = tool.renderResult?.(r as never, {} as never, theme, undefined as never) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("✓");
	});

	it("get renders the plain '✓' fallback", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		const r = await call(tool, { action: "get", id: 1 });
		const node = tool.renderResult?.(r as never, {} as never, theme, undefined as never) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("✓");
	});

	it("clear renders the plain '✓' fallback", async () => {
		const { tool } = setup();
		await call(tool, { action: "clear" });
		const r = await call(tool, { action: "clear" });
		const node = tool.renderResult?.(r as never, {} as never, theme, undefined as never) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("✓");
	});

	it("missing details falls back to plain '✓'", () => {
		const { tool } = setup();
		const node = tool.renderResult?.(
			{ content: [], details: undefined } as never,
			{} as never,
			theme,
			undefined as never,
		) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("✓");
	});
});
