import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
	return {
		...actual,
		completeSimple: vi.fn(),
		supportsXhigh: vi.fn(() => false),
	};
});

import { registerAdvisorTool, setAdvisorEffort, setAdvisorModel } from "./advisor.js";

describe("advisor execute — buildErrorResult envelope", () => {
	it("omits advisorModel when label undefined (no model selected)", async () => {
		setAdvisorModel(undefined);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get("advisor");
		expect(tool).toBeDefined();
		const ctx = createMockCtx();
		const result = await tool?.execute?.("tc1", {}, undefined as never, undefined as never, ctx);
		expect(result?.content[0]).toMatchObject({ type: "text" });
		expect(result?.details).toMatchObject({ errorMessage: "no advisor model selected" });
		expect(result?.details).not.toHaveProperty("advisorModel");
	});

	it("reflects current effort in details.effort", async () => {
		setAdvisorModel(undefined);
		setAdvisorEffort("medium");
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get("advisor");
		const ctx = createMockCtx();
		const result = await tool?.execute?.("tc1", {}, undefined as never, undefined as never, ctx);
		expect(result?.details).toMatchObject({ effort: "medium" });
	});

	it("includes advisorModel label when model is set but auth fails", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get("advisor");
		const ctx = createMockCtx();
		ctx.modelRegistry = {
			...ctx.modelRegistry,
			getApiKeyAndHeaders: (async () => ({ ok: false, error: "bad" })) as never,
		} as never;
		const result = await tool?.execute?.("tc1", {}, undefined as never, undefined as never, ctx);
		expect(result?.details).toMatchObject({ advisorModel: "a:m", errorMessage: "bad" });
	});
});
