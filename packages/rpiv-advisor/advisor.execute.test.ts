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
		cleanupSessionResources: vi.fn(),
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
		convertToLlm: vi.fn(actual.convertToLlm),
	};
});

import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { registerAdvisorTool, setAdvisorModel } from "./advisor/index.ts";

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
	vi.mocked(cleanupSessionResources).mockClear();
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
		// R6.4 guard: a non-empty first attempt does NOT retry.
		expect(completeSimple).toHaveBeenCalledTimes(1);
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

	it("sends an advisor-scoped session id on the runtime path", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ sessionId: "session-123" });
		const runtime = { completeSimple: vi.fn(async (..._args: unknown[]) => resp({ text: "runtime advice" })) };
		Object.defineProperty(ctx.modelRegistry, "runtime", { value: runtime });

		await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		const options = runtime.completeSimple.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
		expect(options).toHaveProperty("sessionId", "advisor-session-123");
	});

	it("sends the same advisor-scoped session id on the legacy path and on the empty-response retry", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({}) as never)
			.mockResolvedValueOnce(resp({ text: "legacy advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ sessionId: "session-456" });

		await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		const calls = vi.mocked(completeSimple).mock.calls;
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call[2]).toMatchObject({ apiKey: "test-key", headers: {}, sessionId: "advisor-session-456" });
		}
	});

	it("releases the advisor session's provider resources on session_shutdown", async () => {
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ sessionId: "session-789" });

		for (const handler of captured.events.get("session_shutdown") ?? []) await handler({}, ctx);
		expect(cleanupSessionResources).toHaveBeenCalledTimes(1);
		expect(cleanupSessionResources).toHaveBeenCalledWith("advisor-session-789");
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

	it("strips inherited tool declarations from system messages", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		const user = makeUserMessage("q");
		vi.mocked(convertToLlm).mockReturnValueOnce([
			{
				role: "system",
				content: "base",
				toolsAdded: [{ name: "read", description: "", parameters: {} }],
				timestamp: 1,
			},
			{ role: "system", content: "later", toolsRemoved: [{ name: "read" }], timestamp: 2 },
			user,
		] as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);

		await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, createMockCtx());

		expect(vi.mocked(completeSimple).mock.calls[0]?.[1]?.messages).toEqual([
			{ role: "system", content: "base", timestamp: 1 },
			{ role: "system", content: "later", timestamp: 2 },
			user,
		]);
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
		// R6.4 guard: an error stopReason short-circuits — NOT retried.
		expect(completeSimple).toHaveBeenCalledTimes(1);
	});

	it("empty-response retries once then surfaces ERR_EMPTY_RESPONSE envelope", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		// Two consecutive empty resolutions — the second is what makes the retry
		// bounded and deterministic (without it the exhausted mock returns
		// `undefined` and the unit would throw into the catch arm).
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "   " }) as never)
			.mockResolvedValueOnce(resp({ text: "" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(completeSimple).toHaveBeenCalledTimes(2);
		expect(r?.details).toMatchObject({ errorMessage: "empty response" });
	});

	it("retry succeeds when the second attempt returns advice", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ text: "   " }) as never)
			.mockResolvedValueOnce(resp({ text: "recovered advice" }) as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ type: "text", text: "recovered advice" });
		expect(completeSimple).toHaveBeenCalledTimes(2);
	});

	it("retries once on the runtime facade path too", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		// getRuntimeCompleteSimple() returns completeSimple.bind(runtime), so the
		// two mockReturnValueOnce resolutions are consumed by the bound method.
		const runtime = {
			completeSimple: vi
				.fn()
				.mockResolvedValueOnce(resp({ text: "" }) as never)
				.mockResolvedValueOnce(resp({ text: "runtime recovered" }) as never),
		};
		// Pi keeps ModelRuntime behind ModelRegistry's runtime-private slot. Keep
		// this test non-enumerable to mirror that host shape.
		Object.defineProperty(ctx.modelRegistry, "runtime", { value: runtime });

		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ type: "text", text: "runtime recovered" });
		expect(runtime.completeSimple).toHaveBeenCalledTimes(2);
		expect(completeSimple).not.toHaveBeenCalled();
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

describe("executeAdvisor — retry on transient provider errors", () => {
	const OVERLOADED = "Codex error: Our servers are currently overloaded. Please try again later.";
	const run = async (settings?: unknown) => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		if (settings !== undefined) Object.assign(pi, { getSettings: () => settings });
		registerAdvisorTool(pi);
		return captured.tools
			.get("advisor")
			?.execute?.("tc", {}, undefined as never, undefined as never, createMockCtx());
	};

	it("retries a transient error under Pi's retry settings and returns the advice", async () => {
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(resp({ stopReason: "error", errorMessage: OVERLOADED }) as never)
			.mockResolvedValueOnce(resp({ text: "advice" }) as never);
		const r = await run({ retry: { baseDelayMs: 1 } });
		expect(r?.content[0]).toMatchObject({ text: "advice" });
		expect(completeSimple).toHaveBeenCalledTimes(2);
	});

	it("surfaces the last error once the retry budget is spent", async () => {
		vi.mocked(completeSimple).mockResolvedValue(resp({ stopReason: "error", errorMessage: OVERLOADED }) as never);
		const r = await run({ retry: { maxRetries: 2, baseDelayMs: 1 } });
		expect(r?.details).toMatchObject({ stopReason: "error", errorMessage: OVERLOADED });
		expect(completeSimple).toHaveBeenCalledTimes(3);
	});

	it("does not retry a permanent error", async () => {
		vi.mocked(completeSimple).mockResolvedValueOnce(
			resp({ stopReason: "error", errorMessage: "401 Unauthorized: invalid api key" }) as never,
		);
		await run({ retry: { baseDelayMs: 1 } });
		expect(completeSimple).toHaveBeenCalledTimes(1);
	});

	it("does not retry when Pi's retry setting is disabled", async () => {
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ stopReason: "error", errorMessage: OVERLOADED }) as never);
		await run({ retry: { enabled: false, baseDelayMs: 1 } });
		expect(completeSimple).toHaveBeenCalledTimes(1);
	});

	it("does not retry on a host without settings access", async () => {
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ stopReason: "error", errorMessage: OVERLOADED }) as never);
		await run();
		expect(completeSimple).toHaveBeenCalledTimes(1);
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

	it("returns no-api-key envelope when apiKey is missing and the host has no runtime facade", async () => {
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

	it("proceeds via the runtime facade when OAuth auth resolves ok without an apiKey", async () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const ctx = createMockCtx();
		// OAuth-backed providers (e.g. kimi-coding) resolve ok with no literal key;
		// credentials are applied inside Pi's runtime facade.
		(ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: true,
		});
		const runtime = {
			completeSimple: vi.fn((..._args: unknown[]) => Promise.resolve(resp({ text: "oauth advice" }))),
		};
		Object.defineProperty(ctx.modelRegistry, "runtime", { value: runtime });

		const r = await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);
		expect(r?.content[0]).toMatchObject({ type: "text", text: "oauth advice" });
		expect(completeSimple).not.toHaveBeenCalled();
		const options = runtime.completeSimple.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
		expect(options).not.toHaveProperty("apiKey");
		expect(options).not.toHaveProperty("headers");
	});
});
