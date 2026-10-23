import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { reconcileAdvisorTool } from "./advisor/handlers.ts";
import { ADVISOR_TOOL_NAME } from "./advisor/index.ts";

const NOTIFY = { disabled: "stripped", restored: "added" };

describe("reconcileAdvisorTool", () => {
	it("strips advisor when blocked and tool is active", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME, "other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		const ctx = createMockCtx({ hasUI: true });
		reconcileAdvisorTool(pi, ctx, { blocked: true, notify: NOTIFY });
		expect(pi.setActiveTools).toHaveBeenCalledWith(["other"]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("stripped", "info");
	});

	it("no-ops when blocked and tool is not active", () => {
		const { pi } = createMockPi();
		pi.setActiveTools(["other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		const ctx = createMockCtx({ hasUI: true });
		reconcileAdvisorTool(pi, ctx, { blocked: true, notify: NOTIFY });
		expect(pi.setActiveTools).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("adds advisor when unblocked and tool is not active", () => {
		const { pi } = createMockPi();
		pi.setActiveTools(["other"]);
		vi.mocked(pi.setActiveTools).mockClear();
		const ctx = createMockCtx({ hasUI: true });
		reconcileAdvisorTool(pi, ctx, { blocked: false, notify: NOTIFY });
		expect(pi.setActiveTools).toHaveBeenCalledWith(["other", ADVISOR_TOOL_NAME]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("added", "info");
	});

	it("no-ops when unblocked and tool is already active", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		const ctx = createMockCtx({ hasUI: true });
		reconcileAdvisorTool(pi, ctx, { blocked: false, notify: NOTIFY });
		expect(pi.setActiveTools).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("skips notify when opts.notify is omitted", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		const ctx = createMockCtx({ hasUI: true });
		reconcileAdvisorTool(pi, ctx, { blocked: true });
		expect(pi.setActiveTools).toHaveBeenCalledWith([]);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("skips notify when ctx.hasUI is false (even with notify provided)", () => {
		const { pi } = createMockPi();
		pi.setActiveTools([ADVISOR_TOOL_NAME]);
		vi.mocked(pi.setActiveTools).mockClear();
		const ctx = createMockCtx({ hasUI: false });
		reconcileAdvisorTool(pi, ctx, { blocked: true, notify: NOTIFY });
		expect(pi.setActiveTools).toHaveBeenCalledWith([]);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});
