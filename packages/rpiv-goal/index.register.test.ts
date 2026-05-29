import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import goalExtension, { __resetGoalRuntime } from "./index.js";
import { extractContinuationMarker } from "./prompt.js";
import { STATE_ENTRY, TOOL_NAME, WIDGET_KEY } from "./state.js";

function setup() {
	const appendEntry = vi.fn();
	const { pi, captured } = createMockPi({ appendEntry: appendEntry as never });
	goalExtension(pi);
	const ctx = createMockCtx({ hasUI: true });
	(ctx as unknown as { hasPendingMessages: () => boolean }).hasPendingMessages = vi.fn(() => false);
	return { pi, captured, ctx, appendEntry };
}

function command(captured: ReturnType<typeof setup>["captured"]) {
	const cmd = captured.commands.get("goal");
	if (!cmd) throw new Error("goal command not registered");
	return cmd;
}

function tool(captured: ReturnType<typeof setup>["captured"]) {
	const registered = captured.tools.get(TOOL_NAME);
	if (!registered) throw new Error("goal_complete tool not registered");
	return registered;
}

function event(captured: ReturnType<typeof setup>["captured"], name: string) {
	const handler = captured.events.get(name)?.[0];
	if (!handler) throw new Error(`${name} handler not registered`);
	return handler as (event: Record<string, unknown>, ctx: unknown) => Promise<unknown> | unknown;
}

function sendSpy(pi: ReturnType<typeof setup>["pi"]) {
	return pi.sendUserMessage as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
	__resetGoalRuntime();
});

describe("rpiv-goal registration", () => {
	it("registers one /goal command and the goal_complete tool", () => {
		const { captured } = setup();
		expect(captured.commands.has("goal")).toBe(true);
		expect(captured.tools.get(TOOL_NAME)?.label).toBe("Goal Complete");
		expect(JSON.stringify(captured.tools.get(TOOL_NAME)?.parameters)).toContain("evidence");
	});
});

describe("/goal command", () => {
	it("starts a goal, persists it, updates UI, and sends the start prompt", async () => {
		const { pi, captured, ctx, appendEntry } = setup();
		await command(captured).handler("--tokens 100k fix failing tests", ctx as never);

		expect(appendEntry).toHaveBeenCalledWith(STATE_ENTRY, {
			goal: expect.objectContaining({
				objective: "fix failing tests",
				status: "active",
				tokenBudget: 100_000,
			}),
		});
		expect(ctx.ui.setWidget).toHaveBeenCalledWith(WIDGET_KEY, expect.any(Array), {
			placement: "aboveEditor",
		});
		expect(sendSpy(pi).mock.calls[0]?.[0]).toContain("<goal_objective>");
	});

	it("completes a goal through the terminating tool", async () => {
		const { captured, ctx, appendEntry } = setup();
		await command(captured).handler("ship it", ctx as never);
		const result = await tool(captured).execute(
			"tc",
			{ summary: "done", evidence: "tests passed" },
			undefined,
			undefined,
			ctx,
		);

		expect(appendEntry).toHaveBeenLastCalledWith(STATE_ENTRY, {
			goal: expect.objectContaining({
				status: "complete",
				completedSummary: "done",
				completionEvidence: "tests passed",
			}),
		});
		expect(result.terminate).toBe(true);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(expect.any(String), "🎯 complete");
	});
});

describe("auto-continuation guards", () => {
	it("sends one continuation after a run that used a work tool", async () => {
		const { pi, captured, ctx } = setup();
		await command(captured).handler("finish the change", ctx as never);
		sendSpy(pi).mockClear();

		await event(captured, "agent_start")({ type: "agent_start" }, ctx);
		await event(captured, "tool_execution_end")(
			{ type: "tool_execution_end", toolName: "bash", isError: false },
			ctx,
		);
		await event(captured, "agent_end")(
			{
				type: "agent_end",
				messages: [{ role: "assistant", stopReason: "stop", usage: { input: 10, output: 5 } }],
			},
			ctx,
		);

		expect(sendSpy(pi)).toHaveBeenCalledTimes(1);
		expect(sendSpy(pi).mock.calls[0]?.[0]).toContain("Continue the active /goal");
	});

	it("suppresses a cancelled continuation marker regardless of input source", async () => {
		const { pi, captured, ctx } = setup();
		await command(captured).handler("finish the change", ctx as never);
		sendSpy(pi).mockClear();

		await event(captured, "agent_start")({ type: "agent_start" }, ctx);
		await event(captured, "tool_execution_end")(
			{ type: "tool_execution_end", toolName: "bash", isError: false },
			ctx,
		);
		await event(captured, "agent_end")(
			{
				type: "agent_end",
				messages: [{ role: "assistant", stopReason: "stop", usage: { input: 10 } }],
			},
			ctx,
		);
		const queuedPrompt = String(sendSpy(pi).mock.calls[0]?.[0] ?? "");
		expect(extractContinuationMarker(queuedPrompt)).toBeTruthy();

		await command(captured).handler("pause", ctx as never);
		const result = await event(captured, "input")(
			{
				type: "input",
				source: "interactive",
				text: queuedPrompt,
			},
			ctx,
		);

		expect(result).toEqual({ action: "handled" });
	});

	it("does not continue when another message is pending", async () => {
		const { pi, captured, ctx } = setup();
		await command(captured).handler("finish the change", ctx as never);
		(ctx as unknown as { hasPendingMessages: () => boolean }).hasPendingMessages = vi.fn(() => true);
		sendSpy(pi).mockClear();

		await event(captured, "agent_start")({ type: "agent_start" }, ctx);
		await event(captured, "tool_execution_end")(
			{ type: "tool_execution_end", toolName: "bash", isError: false },
			ctx,
		);
		await event(captured, "agent_end")(
			{
				type: "agent_end",
				messages: [{ role: "assistant", stopReason: "stop", usage: { input: 10 } }],
			},
			ctx,
		);

		expect(sendSpy(pi)).not.toHaveBeenCalled();
	});

	it("pauses instead of looping after an empty turn", async () => {
		const { pi, captured, ctx, appendEntry } = setup();
		await command(captured).handler("finish the change", ctx as never);
		sendSpy(pi).mockClear();

		await event(captured, "agent_start")({ type: "agent_start" }, ctx);
		await event(captured, "agent_end")(
			{
				type: "agent_end",
				messages: [{ role: "assistant", stopReason: "stop", usage: { input: 10 } }],
			},
			ctx,
		);

		expect(sendSpy(pi)).not.toHaveBeenCalled();
		expect(appendEntry).toHaveBeenLastCalledWith(STATE_ENTRY, {
			goal: expect.objectContaining({ status: "paused", pauseReason: "empty_turn" }),
		});
	});
});
