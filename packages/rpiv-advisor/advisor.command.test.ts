import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import type { Api, Model } from "@mariozechner/pi-ai";
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
	setAdvisorModel,
} from "./advisor.js";
import { showAdvisorPicker, showEffortPicker } from "./advisor-ui.js";

const modelA = { provider: "anthropic", id: "opus", name: "Opus" } as unknown as Model<Api>;
const modelR = {
	provider: "anthropic",
	id: "opus-thinking",
	name: "Opus Thinking",
	reasoning: true,
} as unknown as Model<Api>;

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
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic:opus");
		const { pi, captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelA] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBe(modelA);
		expect(getAdvisorEffort()).toBeUndefined();
		expect(pi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining([ADVISOR_TOOL_NAME]));
		const [msg] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [];
		expect(msg).toBe("Advisor: anthropic:opus");
		expect(showEffortPicker).not.toHaveBeenCalled();
	});
});

describe("/advisor — reasoning model", () => {
	it("returns early when effort picker is cancelled", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic:opus-thinking");
		vi.mocked(showEffortPicker).mockResolvedValueOnce(null);
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelR] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBeUndefined();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("OFF_VALUE yields effort=undefined", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic:opus-thinking");
		vi.mocked(showEffortPicker).mockResolvedValueOnce("__off__");
		const { captured } = register();
		const ctx = createMockCtx({ hasUI: true, models: [modelR] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBe(modelR);
		expect(getAdvisorEffort()).toBeUndefined();
		const [msg] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [];
		expect(msg).toBe("Advisor: anthropic:opus-thinking");
	});

	it("explicit level persists effort + shows it in enabled notification", async () => {
		vi.mocked(showAdvisorPicker).mockResolvedValueOnce("anthropic:opus-thinking");
		vi.mocked(showEffortPicker).mockResolvedValueOnce("medium");
		const { pi, captured } = register();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		const ctx = createMockCtx({ hasUI: true, models: [modelR] });
		await captured.commands.get("advisor")?.handler("", ctx as never);
		expect(getAdvisorModel()).toBe(modelR);
		expect(getAdvisorEffort()).toBe("medium");
		const [msg] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1) ?? [];
		expect(msg).toBe("Advisor: anthropic:opus-thinking, medium");
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
