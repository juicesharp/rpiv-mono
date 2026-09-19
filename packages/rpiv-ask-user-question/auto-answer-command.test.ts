import { createMockCommandCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { ASK_USER_QUESTION_TOOL_NAME } from "./ask-user-question.js";
import { AUTO_ANSWER_COMMAND, registerAutoAnswerCommand } from "./auto-answer-command.js";

describe("registerAutoAnswerCommand", () => {
	it("reports status without writing configuration", async () => {
		const { pi, captured } = createMockPi();
		const state = { enabled: false };
		const save = vi.fn(() => true);
		registerAutoAnswerCommand(pi, state, save);
		const ctx = createMockCommandCtx({ hasUI: true });

		await captured.commands.get(AUTO_ANSWER_COMMAND)?.handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Jev auto-answer is off.", "info");
		expect(save).not.toHaveBeenCalled();
	});

	it("persists on, updates shared state, and restores the tool without UI", async () => {
		const { pi, captured } = createMockPi();
		pi.setActiveTools(["other"]);
		const state = { enabled: false };
		const save = vi.fn(() => true);
		registerAutoAnswerCommand(pi, state, save);
		const ctx = createMockCommandCtx({ hasUI: false });

		await captured.commands.get(AUTO_ANSWER_COMMAND)?.handler("on", ctx);

		expect(save).toHaveBeenCalledWith(true);
		expect(state.enabled).toBe(true);
		expect(pi.getActiveTools()).toEqual(["other", ASK_USER_QUESTION_TOOL_NAME]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Jev auto-answer is now on.", "info");
	});

	it("persists off and strips the tool when no UI is available", async () => {
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ASK_USER_QUESTION_TOOL_NAME, "other"]);
		const state = { enabled: true };
		registerAutoAnswerCommand(pi, state, () => true);
		const ctx = createMockCommandCtx({ hasUI: false });

		await captured.commands.get(AUTO_ANSWER_COMMAND)?.handler("off", ctx);

		expect(state.enabled).toBe(false);
		expect(pi.getActiveTools()).toEqual(["other"]);
	});

	it("leaves memory untouched when persistence fails", async () => {
		const { pi, captured } = createMockPi();
		const state = { enabled: false };
		registerAutoAnswerCommand(pi, state, () => false);
		const ctx = createMockCommandCtx({ hasUI: true });

		await captured.commands.get(AUTO_ANSWER_COMMAND)?.handler("on", ctx);

		expect(state.enabled).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Could not save the Jev auto-answer setting.", "error");
	});

	it("rejects unknown actions and completes supported values", async () => {
		const { pi, captured } = createMockPi();
		registerAutoAnswerCommand(pi, { enabled: false }, () => true);
		const command = captured.commands.get(AUTO_ANSWER_COMMAND)!;
		const ctx = createMockCommandCtx({ hasUI: true });

		await command.handler("maybe", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(`Usage: /${AUTO_ANSWER_COMMAND} on|off|status`, "error");
		expect(command.getArgumentCompletions?.("o")).toEqual([
			{ value: "on", label: "on" },
			{ value: "off", label: "off" },
		]);
		expect(command.getArgumentCompletions?.("x")).toBeNull();
	});
});
