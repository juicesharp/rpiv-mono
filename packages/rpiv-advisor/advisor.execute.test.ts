import {
	buildSessionEntries,
	createMockCtx,
	createMockPi,
	makeAssistantMessage,
	makeUserMessage,
} from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		getSupportedThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high"]),
	};
});

// completeSimple lives on /compat since pi 0.80 (see test/setup.ts).
vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: vi.fn(),
	};
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		buildSessionContext: vi.fn(),
	};
});

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { registerAdvisorTool, setAdvisorModel } from "./advisor/index.js";

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
	vi.mocked(buildSessionContext).mockImplementation(
		(entries) =>
			({
				messages: ((entries ?? []) as { type?: string; message?: unknown }[])
					.filter((e) => e?.type === "message")
					.map((e) => (e as { message: unknown }).message),
				thinkingLevel: "off",
				model: null,
			}) as ReturnType<typeof buildSessionContext>,
	);
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

	it("uses Pi's auth-aware runtime completion when the host exposes it", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const runtime = {
			completeSimple: vi.fn(function (this: unknown, ..._args: unknown[]) {
				expect(this).toBe(runtime);
				return Promise.resolve(resp({ text: "runtime advice" }));
			}),
		};
		// Pi keeps ModelRuntime behind ModelRegistry's runtime-private slot. Keep
		// this test non-enumerable to mirror that host shape.
		Object.defineProperty(ctx.modelRegistry, "runtime", { value: runtime });

		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ type: "text", text: "runtime advice" });
		expect(runtime.completeSimple).toHaveBeenCalledTimes(1);
		expect(completeSimple).not.toHaveBeenCalled();
		const options = runtime.completeSimple.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
		expect(options).toHaveProperty("signal", undefined);
		expect(options).toHaveProperty("reasoning", undefined);
		expect(options).not.toHaveProperty("apiKey");
		expect(options).not.toHaveProperty("headers");
	});

	it("uses the legacy completion path when the host has no runtime facade", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "legacy advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();

		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ type: "text", text: "legacy advice" });
		expect(completeSimple).toHaveBeenCalledTimes(1);
		const options = vi.mocked(completeSimple).mock.calls[0]?.[2] as Record<string, unknown> | undefined;
		expect(options).toMatchObject({ apiKey: "test-key", headers: {} });
	});

	it("uses compacted session context instead of raw branch messages", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		vi.mocked(buildSessionContext).mockReturnValueOnce({
			messages: [
				{
					role: "compactionSummary",
					summary: "COMPACTED SUMMARY OF EARLIER WORK",
					tokensBefore: 12345,
					timestamp: Date.now(),
				},
				makeUserMessage("kept user message"),
				makeAssistantMessage({ text: "post-compaction assistant" }),
			],
			thinkingLevel: "off",
			model: null,
		} as ReturnType<typeof buildSessionContext>);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({
			branch: buildSessionEntries([
				makeUserMessage("OLD RAW PRE-COMPACTION DETAIL"),
				makeAssistantMessage({ text: "old raw assistant detail" }),
			]),
		});

		await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);

		const payload = vi.mocked(completeSimple).mock.calls[0]?.[1] as { messages?: unknown[] };
		const serialized = JSON.stringify(payload.messages);
		expect(serialized).toContain("COMPACTED SUMMARY OF EARLIER WORK");
		expect(serialized).toContain("kept user message");
		expect(serialized).toContain("post-compaction assistant");
		expect(serialized).not.toContain("OLD RAW PRE-COMPACTION DETAIL");
		expect(serialized).not.toContain("old raw assistant detail");
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

describe("executeAdvisor — auth envelopes", () => {
	it("returns no-model envelope when advisor is not configured", async () => {
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.details).toMatchObject({ errorMessage: "no advisor model selected" });
	});

	it("wraps misconfigured auth into details.errorMessage", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		(ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: false,
			error: "bad config",
		});
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("bad config") });
		expect(r?.details).toMatchObject({ errorMessage: "bad config", advisorModel: "a:m" });
	});

	it("returns no-api-key envelope when auth.ok but apiKey is missing", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		(ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: true,
			apiKey: undefined,
			headers: {},
		});
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("no API key") });
		expect(r?.details).toMatchObject({ errorMessage: "no API key for a", advisorModel: "a:m" });
	});
});
