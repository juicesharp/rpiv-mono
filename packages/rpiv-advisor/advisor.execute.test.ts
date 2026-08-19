import type { Message } from "@earendil-works/pi-ai";
import {
	buildSessionEntries,
	createMockCtx,
	createMockPi,
	makeAssistantMessage,
	makeToolResult,
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

	it("removes prune-covered raw results, preserves the summary, and repairs the tail", async () => {
		setAdvisorModel({ provider: "a", id: "m", contextWindow: 32_000, maxTokens: 4_096 } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		const prunedAssistant = makeAssistantMessage({
			text: "ran the command",
			toolCalls: [{ id: "call-pruned", name: "bash", arguments: {} }],
		});
		const prunedResult = makeToolResult({
			toolName: "bash",
			toolCallId: "call-pruned",
			text: "RAW TOOL OUTPUT THAT MUST NOT BE FORWARDED",
		});
		const pruneSummaryEntry = {
			type: "custom_message",
			customType: "context-prune-summary",
			content: "<context-prune-summary>summary of the raw output</context-prune-summary>",
			details: { toolCallRefs: [{ shortId: "t1", toolCallId: "call-pruned" }] },
		} as never;
		vi.mocked(buildSessionContext).mockReturnValueOnce({
			messages: [
				makeUserMessage("task"),
				prunedAssistant,
				prunedResult,
				makeUserMessage("<context-prune-summary>summary of the raw output</context-prune-summary>"),
				makeAssistantMessage({
					text: "current work",
					toolCalls: [{ id: "advisor-inflight", name: "advisor", arguments: {} }],
				}),
			],
			thinkingLevel: "off",
			model: null,
		} as ReturnType<typeof buildSessionContext>);
		const { pi, captured } = createMockPi();
		const ctx = createMockCtx({
			branch: [...buildSessionEntries([makeUserMessage("task"), prunedAssistant, prunedResult]), pruneSummaryEntry],
		});
		registerAdvisorTool(pi);
		const result = await captured.tools
			.get("advisor")
			?.execute?.("tc", {}, undefined as never, undefined as never, ctx);

		const payload = vi.mocked(completeSimple).mock.calls[0]?.[1] as { messages?: Message[] };
		const serialized = JSON.stringify(payload.messages);
		expect(serialized).toContain("summary of the raw output");
		expect(serialized).not.toContain("RAW TOOL OUTPUT THAT MUST NOT BE FORWARDED");
		expect(serialized).not.toContain("call-pruned");
		expect(serialized).not.toContain("advisor-inflight");
		expect(payload.messages?.at(-1)?.role).toBe("user");
		expect(result?.details).toMatchObject({ context: { enabled: true, pruneCoveredToolResults: 1 } });
	});

	it("prepends the tool inventory before the fitted branch", async () => {
		setAdvisorModel({ provider: "a", id: "m", contextWindow: 32_000, maxTokens: 4_096 } as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(resp({ text: "advice" }) as never);
		const { pi, captured } = createMockPi({
			getAllTools: vi.fn(
				() =>
					[
						{
							name: "bash",
							description: "run commands",
							parameters: { type: "object" },
							sourceInfo: { path: "/mock/bash" },
						},
					] as never,
			),
		});
		registerAdvisorTool(pi);
		const ctx = createMockCtx({ branch: buildSessionEntries([makeUserMessage("task")]) });
		await captured.tools.get("advisor")?.execute?.("tc", {}, undefined as never, undefined as never, ctx);

		const payload = vi.mocked(completeSimple).mock.calls[0]?.[1] as { messages?: Message[] };
		expect(payload.messages?.[0]?.role).toBe("user");
		expect(JSON.stringify(payload.messages?.[0])).toContain("Available Executor Tools");
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
