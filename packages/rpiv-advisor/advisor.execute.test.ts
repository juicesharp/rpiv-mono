import {
	buildSessionEntries,
	createMockCtx,
	createMockPi,
	makeAssistantMessage,
	makeUserMessage,
} from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
	return {
		...actual,
		completeSimple: vi.fn(),
		supportsXhigh: vi.fn(() => false),
	};
});

import { completeSimple } from "@mariozechner/pi-ai";
import { registerAdvisorTool, setAdvisorModel } from "./advisor.js";

function resp(input: { text?: string; stopReason?: "done" | "aborted" | "error" | "toolUse"; errorMessage?: string }) {
	return {
		role: "assistant",
		content: input.text ? [{ type: "text", text: input.text }] : [],
		timestamp: Date.now(),
		stopReason: input.stopReason ?? "done",
		errorMessage: input.errorMessage,
	};
}

beforeEach(() => {
	vi.mocked(completeSimple).mockReset();
});

describe("executeAdvisor — 4 StopReason branches", () => {
	it("happy path returns advisor text", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({
			branch: buildSessionEntries([makeUserMessage("q"), makeAssistantMessage({ text: "a" })]),
		});
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ type: "text", text: "advice" });
		expect(r?.details).toMatchObject({ advisorModel: "a:m" });
	});

	it("aborted stopReason returns cancel envelope", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ stopReason: "aborted" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ stopReason: "aborted", errorMessage: "aborted" });
	});

	it("error stopReason returns wrapped errorMessage", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ stopReason: "error", errorMessage: "502" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("502") });
		expect(r?.details).toMatchObject({ stopReason: "error", errorMessage: "502" });
	});

	it("empty-response returns ERR_EMPTY_RESPONSE envelope", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "   " }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ errorMessage: "empty response" });
	});

	it("thrown error is caught and wrapped in details.errorMessage", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockRejectedValueOnce(new Error("boom"));
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("boom") });
		expect(r?.details).toMatchObject({ errorMessage: "boom" });
	});
});
