import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./advisor-ui.js", () => ({
	showAdvisorPicker: vi.fn(),
	showEffortPicker: vi.fn(),
}));

import {
	ADVISOR_TOOL_NAME,
	getAdvisorEffort,
	getAdvisorModel,
	registerAdvisorBeforeAgentStart,
	registerAdvisorCommand,
	registerModelSelectHandler,
	registerThinkingLevelSelectHandler,
	restoreAdvisorState,
	setAdvisorModel,
	setDisabledForModels,
} from "./advisor/index.js";
import { showAdvisorPicker, showEffortPicker } from "./advisor-ui.js";

const modelA = { provider: "anthropic", id: "opus", name: "Opus" } as unknown as Model<Api>;
const modelR = {
	provider: "anthropic",
	id: "opus-thinking",
	name: "Opus Thinking",
	reasoning: true,
} as unknown as Model<Api>;
const modelMax = {
	provider: "openai",
	id: "gpt-max",
	name: "GPT Max",
	reasoning: true,
} as unknown as Model<Api>;
const modelBlocked = { provider: "anthropic", id: "sonnet", name: "Sonnet" } as unknown as Model<Api>;

beforeEach(() => {
	vi.mocked(showAdvisorPicker).mockReset();
	vi.mocked(showEffortPicker).mockReset();
});

function register() {
	const { pi, captured } = createMockPi();
	registerAdvisorCommand(pi);
	return { pi, captured, handler: () => captured.commands.get("advisor")?.handler };
}

describe("/advisor — command shape", () => {
	it("registers under 'advisor'", () => {
		const { captured } = register();
		expect(captured.commands.has("advisor")).toBe(true);
	});
});

describe("/advisor — !hasUI", () => {
	it("notifies error and skips picker", async () => {
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: false });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(showAdvisorPicker).not.toHaveBeenCalled();
	});
});

describe("/advisor — user cancels picker", () => {
	it("no-ops when showAdvisorPicker resolves null", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce(null);
		const { pi, captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBeUndefined();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("/advisor — NO_ADVISOR", () => {
	it("clears model+effort, drops advisor from active tools, notifies disabled", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("__no_advisor__");
		const { pi, captured } = register();
		pi.setActiveTools([ADVISOR_TOOL_NAME, "other"]);
		setAdvisorModel(modelA);
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBeUndefined();
		expect(getAdvisorEffort()).toBeUndefined();
		expect(pi.setActiveTools).toHaveBeenLastCalledWith(["other"]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Advisor disabled"), "info");
	});

	it("skips setActiveTools when advisor was not in the list", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("__no_advisor__");
		const { pi, captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Advisor disabled"), "info");
	});
});

describe("/advisor — selection not found", () => {
	it("notifies errSelectionNotFound when pick is unknown", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("ghost:nonesuch");
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Advisor selection not found"), "error");
	});
});

describe("/advisor — non-reasoning model", () => {
	it("sets model, adds tool, notifies enabled (no effort suffix)", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic/opus");
		const { pi, captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBe(modelA);
		expect(getAdvisorEffort()).toBeUndefined();
		expect(pi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
		const [msg] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [];
		expect(msg).toBe("Advisor: anthropic/opus");
		expect(showEffortPicker).not.toHaveBeenCalled();
	});
});

describe("/advisor — reasoning model", () => {
	it("uses the host model's supported effort levels, including max", async () => {
		vi.mocked(getSupportedThinkingLevels).mockReturnValueOnce(["off", "low", "medium", "high", "max"]);
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("openai/gpt-max");
		vi.mocked(showEffortPicker).mockResolvedValueOnce(null);
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelMax] });

		await captured.commands.get("advisor")?.handler("", ctx as never);

		const items = vi.mocked(showEffortPicker).mock.calls[0]?.[1];
		expect(items?.map((item) => item.value)).toEqual(["__off__", "low", "medium", "high", "max"]);
	});

	it("returns early when effort picker is cancelled", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic/opus-thinking");
		vi.mocked(showEffortPicker).mockResolvedValueOnce(null);
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelR] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBeUndefined();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("OFF_VALUE yields effort=undefined", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic/opus-thinking");
		vi.mocked(showEffortPicker).mockResolvedValueOnce("__off__");
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelR] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBe(modelR);
		expect(getAdvisorEffort()).toBeUndefined();
		const [msg] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [];
		expect(msg).toBe("Advisor: anthropic/opus-thinking");
	});

	it("explicit level persists effort + shows it in enabled notification", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic/opus-thinking");
		vi.mocked(showEffortPicker).mockResolvedValueOnce("medium");
		const { pi, captured } = register();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		const ctx = createMockCtx({ hasUI: true, models: [modelR] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBe(modelR);
		expect(getAdvisorEffort()).toBe("medium");
		const [msg] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [];
		expect(msg).toBe("Advisor: anthropic/opus-thinking, medium");
	});
});

describe("/advisor — save failure (persist-first ordering, review I2)", () => {
	it("disable path: error notify; in-memory model + active tools unchanged", async () => {
		if (process.platform === "win32") return;
		const { mkdirSync, rmSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const configPath = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mkdirSync(dirname(configPath), { recursive: true });
		// Force EISDIR on writeFileSync — same trick the web-tools save-failure
		// test uses. Drives saveAdvisorConfig → false through the real disk path.
		mkdirSync(configPath, { recursive: true });
		try {
			vi.mocked(showAdvisorPicker).mockResolvedValueOnce("__no_advisor__");
			const { pi, captured } = register();
			pi.setActiveTools([ADVISOR_TOOL_NAME, "other"]);
			vi.mocked(pi.setActiveTools).mockClear();
			setAdvisorModel(modelA);
			const ctx = createMockCtx({ hasUI: true, models: [modelA] });

			await captured.commands.get("advisor")?.handler("", ctx as never);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Failed to save advisor selection"),
				"error",
			);
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Advisor disabled"), "info");
			// Persist-first: in-memory model and active-tools registry must be untouched.
			expect(getAdvisorModel()).toBe(modelA);
			expect(pi.setActiveTools).not.toHaveBeenCalled();
		} finally {
			rmSync(configPath, { recursive: true, force: true });
		}
	});

	it("enable path: error notify; in-memory model + active tools unchanged", async () => {
		if (process.platform === "win32") return;
		const { mkdirSync, rmSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const configPath = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mkdirSync(dirname(configPath), { recursive: true });
		mkdirSync(configPath, { recursive: true });
		try {
			vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic/opus");
			const { pi, captured } = register();
			const ctx = createMockCtx({ hasUI: true, models: [modelA] });

			await captured.commands.get("advisor")?.handler("", ctx as never);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Failed to save advisor selection"),
				"error",
			);
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Advisor: anthropic/opus"), "info");
			// Persist-first: in-memory model must NOT be set; tool must NOT be added.
			expect(getAdvisorModel()).toBeUndefined();
			expect(pi.setActiveTools).not.toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
		} finally {
			rmSync(configPath, { recursive: true, force: true });
		}
	});
});

describe("registerAdvisorBeforeAgentStart", () => {
	it("strips advisor from active tools when no model is set", async () => {
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME, "other"]);
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		await handler?.({} as never, undefined as never);
		expect(pi.setActiveTools).toHaveBeenLastCalledWith(["other"]);
	});

	it("no-ops when advisor is not in active tools", async () => {
		const { pi, captured } = createMockPi();
		pi.setActiveTools(["other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		await handler?.({} as never, undefined as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("no-ops when an advisor model is set", async () => {
		setAdvisorModel(modelA);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		await handler?.({} as never, undefined as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("restoreAdvisorState — blocklist", () => {
	it("skips tool activation when executor is blocked but still sets model", async () => {
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const configPath = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				modelKey: "anthropic:opus",
				disabledForModels: ["anthropic:sonnet"],
			}),
		);

		const { pi } = createMockPi();
		const ctx = createMockCtx({
			hasUI: true,
			model: modelBlocked,
			models: [modelA],
		});
		restoreAdvisorState(ctx as never, pi);
		expect(getAdvisorModel()).toBe(modelA);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("activates tool when executor is not blocked", async () => {
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const configPath = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				modelKey: "anthropic:opus",
				disabledForModels: ["anthropic:sonnet"],
			}),
		);

		const { pi } = createMockPi();
		const ctx = createMockCtx({
			hasUI: true,
			model: modelA,
			models: [modelA],
		});
		restoreAdvisorState(ctx as never, pi);
		expect(getAdvisorModel()).toBe(modelA);
		expect(pi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
	});
});

describe("registerAdvisorBeforeAgentStart — blocklist", () => {
	it("strips advisor when executor model is blocked", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelBlocked });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenLastCalledWith([]);
	});

	it("no-ops when executor model is not blocked", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelA });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("no-ops when blocklist is empty", async () => {
		setAdvisorModel(modelA);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelBlocked });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("registerModelSelectHandler — blocklist", () => {
	it("strips advisor when switching to blocked model", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const ctx = createMockCtx({ hasUI: true });
		await handler?.({ model: modelBlocked, previousModel: modelA, source: "set" } as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenLastCalledWith([]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("disabled for"), "info");
	});

	it("re-adds advisor when switching from blocked to non-blocked", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = createMockPi();
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const ctx = createMockCtx({ hasUI: true });
		await handler?.({ model: modelA, previousModel: modelBlocked, source: "set" } as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("restored"), "info");
	});

	it("no-ops when no advisor model is configured", async () => {
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const ctx = createMockCtx({ hasUI: true });
		await handler?.({ model: modelBlocked, previousModel: modelA, source: "set" } as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("no-ops when source is 'restore' (avoids duplicate notification with restoreAdvisorState)", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const ctx = createMockCtx({ hasUI: true });
		await handler?.({ model: modelBlocked, previousModel: undefined, source: "restore" } as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

describe("/advisor — blocked executor notification", () => {
	it("shows inactive notification and does NOT activate the tool when executor is blocked", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic/opus");
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = register();
		vi.mocked(pi.setActiveTools).mockClear();
		const ctx = createMockCtx({ hasUI: true, models: [modelA], model: modelBlocked });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("inactive for current executor"), "info");
		const calls = vi.mocked(pi.setActiveTools).mock.calls;
		for (const [tools] of calls) {
			expect(tools).not.toContain(ADVISOR_TOOL_NAME);
		}
	});

	it("strips advisor from active tools when /advisor runs with executor blocked and tool already active", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic/opus");
		setDisabledForModels(["anthropic:sonnet"]);
		const { pi, captured } = register();
		pi.setActiveTools([ADVISOR_TOOL_NAME, "other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		const ctx = createMockCtx({ hasUI: true, models: [modelA], model: modelBlocked });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(["other"]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("inactive for current executor"), "info");
	});

	it("shows enabled notification without inactive qualifier when executor is not blocked", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic/opus");
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA], model: modelA });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		const [msg, severity] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [];
		expect(msg).toBe("Advisor: anthropic/opus");
		expect(severity).toBe("info");
	});

	it("shows inactive notification when executor blocked by effort-aware entry at threshold", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic/opus");
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = register();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("high");
		vi.mocked(pi.setActiveTools).mockClear();
		const ctx = createMockCtx({ hasUI: true, models: [modelA], model: modelBlocked });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("inactive for current executor"), "info");
		const calls = vi.mocked(pi.setActiveTools).mock.calls;
		for (const [tools] of calls) {
			expect(tools).not.toContain(ADVISOR_TOOL_NAME);
		}
	});

	it("shows enabled notification when executor effort below threshold for effort-aware entry", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic/opus");
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA], model: modelBlocked });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		const [msg, severity] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [];
		expect(msg).toBe("Advisor: anthropic/opus");
		expect(severity).toBe("info");
	});
});

describe("registerAdvisorBeforeAgentStart — effort-aware blocklist", () => {
	it("strips advisor when effort at threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("high");
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelBlocked });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenLastCalledWith([]);
	});

	it("re-adds advisor when effort drops below threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("low");
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelBlocked });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
	});

	it("no-ops when effort at threshold but model is not blocked", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("high");
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelA });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("does not block when thinking level is off", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("off");
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelBlocked });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("blocks when effort is one above threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "medium" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("high");
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelBlocked });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenLastCalledWith([]);
	});

	it("does not block when effort is one below threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("medium");
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerAdvisorBeforeAgentStart(pi);
		const handler = captured.events.get("before_agent_start")?.[0];
		const ctx = createMockCtx({ model: modelBlocked });
		await handler?.({} as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("registerModelSelectHandler — effort-aware blocklist", () => {
	it("strips advisor when model matches and effort at threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("high");
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const ctx = createMockCtx({ hasUI: true });
		await handler?.({ model: modelBlocked, previousModel: modelA, source: "set" } as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenLastCalledWith([]);
	});

	it("does not strip when model matches but effort is below threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("low");
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerModelSelectHandler(pi);
		const handler = captured.events.get("model_select")?.[0];
		const ctx = createMockCtx({ hasUI: true });
		await handler?.({ model: modelBlocked, previousModel: modelA, source: "set" } as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("registerThinkingLevelSelectHandler", () => {
	it("strips advisor when effort rises above threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		registerThinkingLevelSelectHandler(pi);
		const handler = captured.events.get("thinking_level_select")?.[0];
		const ctx = createMockCtx({ hasUI: true, model: modelBlocked });
		await handler?.({ type: "thinking_level_select", level: "high", previousLevel: "low" } as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenLastCalledWith([]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("disabled for"), "info");
	});

	it("re-adds advisor when effort drops below threshold", async () => {
		setAdvisorModel(modelA);
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		registerThinkingLevelSelectHandler(pi);
		const handler = captured.events.get("thinking_level_select")?.[0];
		const ctx = createMockCtx({ hasUI: true, model: modelBlocked });
		await handler?.({ type: "thinking_level_select", level: "low", previousLevel: "high" } as never, ctx as never);
		expect(pi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("restored"), "info");
	});

	it("no-ops when no advisor model is configured", async () => {
		setDisabledForModels([{ model: "anthropic:sonnet", minEffort: "high" }]);
		const { pi, captured } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		registerThinkingLevelSelectHandler(pi);
		const handler = captured.events.get("thinking_level_select")?.[0];
		const ctx = createMockCtx({ hasUI: true, model: modelBlocked });
		await handler?.({ type: "thinking_level_select", level: "high", previousLevel: "low" } as never, ctx as never);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("restoreAdvisorState — effort-aware blocklist", () => {
	it("skips tool activation when effort at threshold", async () => {
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const configPath = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				modelKey: "anthropic:opus",
				disabledForModels: [{ model: "anthropic:sonnet", minEffort: "high" }],
			}),
		);

		const { pi } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("high");
		const ctx = createMockCtx({
			hasUI: true,
			model: modelBlocked,
			models: [modelA],
		});
		restoreAdvisorState(ctx as never, pi);
		expect(getAdvisorModel()).toBe(modelA);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("activates tool when effort below threshold", async () => {
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const configPath = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				modelKey: "anthropic:opus",
				disabledForModels: [{ model: "anthropic:sonnet", minEffort: "high" }],
			}),
		);

		const { pi } = createMockPi();
		vi.mocked(pi.getThinkingLevel).mockReturnValue("low");
		const ctx = createMockCtx({
			hasUI: true,
			model: modelBlocked,
			models: [modelA],
		});
		restoreAdvisorState(ctx as never, pi);
		expect(getAdvisorModel()).toBe(modelA);
		expect(pi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
	});
});
