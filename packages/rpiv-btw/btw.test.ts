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

import { type AssistantMessage, completeSimple, type UserMessage } from "@mariozechner/pi-ai";
import {
	assistantMessageText,
	BTW_STATE_KEY,
	BTW_SYSTEM_PROMPT,
	CROSS_SESSION_HINT_LIMIT,
	clearSessionHistory,
	executeBtw,
	invalidateSnapshot,
	registerBtwCommand,
	registerInvalidationHooks,
	registerMessageEndSnapshot,
	userMessageText,
} from "./btw.js";

function makeCompletionResponse(input: {
	text?: string;
	stopReason?: "done" | "aborted" | "error" | "toolUse";
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: input.text ? [{ type: "text", text: input.text }] : [],
		timestamp: Date.now(),
		stopReason: input.stopReason ?? "done",
		errorMessage: input.errorMessage,
	} as unknown as AssistantMessage;
}

beforeEach(() => {
	vi.mocked(completeSimple).mockReset();
	delete (globalThis as Record<symbol, unknown>)[BTW_STATE_KEY];
});

describe("userMessageText", () => {
	it("returns string content as-is", () => {
		const msg = { role: "user", content: "hi", timestamp: 0 } as unknown as UserMessage;
		expect(userMessageText(msg)).toBe("hi");
	});
	it("joins text parts from array content", () => {
		expect(
			userMessageText({
				role: "user",
				content: [
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
				timestamp: 0,
			} as unknown as UserMessage),
		).toBe("a\nb");
	});
	it("ignores non-text parts", () => {
		expect(
			userMessageText({
				role: "user",
				content: [
					{ type: "text", text: "a" },
					{ type: "image", data: "..." } as unknown as { type: "text"; text: string },
				],
				timestamp: 0,
			} as unknown as UserMessage),
		).toBe("a");
	});
});

describe("assistantMessageText", () => {
	it("joins text parts only, skips toolCalls", () => {
		const msg = makeAssistantMessage({
			text: "hello",
			toolCalls: [{ id: "c1", name: "web_search", arguments: {} }],
		});
		expect(assistantMessageText(msg)).toBe("hello");
	});
	it("returns empty string for content without text parts", () => {
		const msg = makeAssistantMessage({
			toolCalls: [{ id: "c1", name: "t", arguments: {} }],
		});
		expect(assistantMessageText(msg)).toBe("");
	});
});

describe("BTW_SYSTEM_PROMPT + BTW_STATE_KEY + CROSS_SESSION_HINT_LIMIT", () => {
	it("BTW_SYSTEM_PROMPT is a non-empty string loaded from prompts dir", () => {
		expect(typeof BTW_SYSTEM_PROMPT).toBe("string");
		expect(BTW_SYSTEM_PROMPT.length).toBeGreaterThan(0);
	});
	it("BTW_STATE_KEY is the shared Symbol.for('rpiv-btw')", () => {
		expect(BTW_STATE_KEY).toBe(Symbol.for("rpiv-btw"));
	});
	it("CROSS_SESSION_HINT_LIMIT is 10", () => {
		expect(CROSS_SESSION_HINT_LIMIT).toBe(10);
	});
});

describe("clearSessionHistory + invalidateSnapshot", () => {
	it("clearSessionHistory resets per-session history list", async () => {
		const ctx = createMockCtx();
		vi.mocked(completeSimple).mockResolvedValueOnce(makeCompletionResponse({ text: "answer" }) as never);
		ctx.model = { provider: "anthropic", id: "sonnet-4.6" } as never;
		await executeBtw("q", ctx, new AbortController());
		clearSessionHistory(ctx);
		const state = (globalThis as Record<symbol, { histories: Map<string, unknown[]> }>)[BTW_STATE_KEY];
		expect(state.histories.get("/tmp/test-session.jsonl")).toEqual([]);
	});
	it("invalidateSnapshot deletes the session's snapshot entry", () => {
		const ctx = createMockCtx();
		(globalThis as Record<symbol, { snapshots: Map<string, unknown> }>)[BTW_STATE_KEY] = {
			histories: new Map(),
			snapshots: new Map([["/tmp/test-session.jsonl", { messages: [] }]]),
		} as never;
		invalidateSnapshot(ctx);
		const state = (globalThis as Record<symbol, { snapshots: Map<string, unknown> }>)[BTW_STATE_KEY];
		expect(state.snapshots.has("/tmp/test-session.jsonl")).toBe(false);
	});
});

describe("executeBtw — ok path", () => {
	it("returns ok=true with answer + userMessage + assistantMessage", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		vi.mocked(completeSimple).mockResolvedValueOnce(makeCompletionResponse({ text: "answer text" }) as never);
		const r = await executeBtw("question", ctx, new AbortController());
		expect(r.ok).toBe(true);
		expect(r.answer).toBe("answer text");
		expect(r.userMessage?.content).toEqual([{ type: "text", text: "question" }]);
		expect(r.assistantMessage).toBeDefined();
	});
});

describe("executeBtw — error branches", () => {
	it("returns error when no model", async () => {
		const ctx = createMockCtx();
		ctx.model = undefined;
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r).toMatchObject({ ok: false, error: "/btw requires an active model" });
	});
	it("returns error when getApiKeyAndHeaders is not ok", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		ctx.modelRegistry = {
			...ctx.modelRegistry,
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: false, error: "bad creds" })),
		} as never;
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r.ok).toBe(false);
		expect(r.error).toContain("misconfigured");
		expect(r.error).toContain("bad creds");
	});
	it("returns error when apiKey absent", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		ctx.modelRegistry = {
			...ctx.modelRegistry,
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "", headers: {} })),
		} as never;
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r.ok).toBe(false);
		expect(r.error).toContain("no API key");
	});
	it("returns aborted when stopReason=aborted", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		vi.mocked(completeSimple).mockResolvedValueOnce(makeCompletionResponse({ stopReason: "aborted" }) as never);
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r).toMatchObject({ ok: false, aborted: true });
	});
	it("returns error when stopReason=error", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		vi.mocked(completeSimple).mockResolvedValueOnce(
			makeCompletionResponse({ stopReason: "error", errorMessage: "remote 500" }) as never,
		);
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r.ok).toBe(false);
		expect(r.error).toContain("remote 500");
	});
	it("returns error when response has no text content", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		vi.mocked(completeSimple).mockResolvedValueOnce(makeCompletionResponse({ stopReason: "done" }) as never);
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r.ok).toBe(false);
		expect(r.error).toContain("no text content");
	});
	it("translates controller.signal.aborted on thrown error to aborted=true", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		const controller = new AbortController();
		controller.abort();
		vi.mocked(completeSimple).mockRejectedValueOnce(new Error("abort"));
		const r = await executeBtw("q", ctx, controller);
		expect(r).toMatchObject({ ok: false, aborted: true });
	});
	it("wraps unknown throws as errCallThrew", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		vi.mocked(completeSimple).mockRejectedValueOnce(new Error("boom"));
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r.ok).toBe(false);
		expect(r.error).toContain("call threw");
		expect(r.error).toContain("boom");
	});
});

describe("executeBtw — cross-session hint", () => {
	it("appends cross-session question list to systemPrompt", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;

		vi.mocked(completeSimple).mockResolvedValueOnce(makeCompletionResponse({ text: "first" }) as never);
		await executeBtw("first-question", ctx, new AbortController());

		vi.mocked(completeSimple).mockImplementationOnce((async (_model: unknown, req: { systemPrompt: string }) => {
			expect(req.systemPrompt).toContain("## Recent /btw questions across sessions");
			expect(req.systemPrompt).toContain("first-question");
			return makeCompletionResponse({ text: "second" });
		}) as never);
		await executeBtw("second-question", ctx, new AbortController());
	});
	it("caps cross-session list to CROSS_SESSION_HINT_LIMIT=10", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		for (let i = 0; i < 12; i++) {
			vi.mocked(completeSimple).mockResolvedValueOnce(makeCompletionResponse({ text: `a${i}` }) as never);
			await executeBtw(`q${i}`, ctx, new AbortController());
		}
		vi.mocked(completeSimple).mockImplementationOnce((async (_m: unknown, req: { systemPrompt: string }) => {
			const lines = req.systemPrompt.match(/^\d+\. /gm) ?? [];
			expect(lines.length).toBe(10);
			expect(req.systemPrompt).toContain("q11");
			expect(req.systemPrompt).not.toContain("q0.");
			return makeCompletionResponse({ text: "ok" });
		}) as never);
		await executeBtw("final", ctx, new AbortController());
	});
});

describe("executeBtw — branch threading", () => {
	it("prepends live branch messages when no snapshot exists", async () => {
		const ctx = createMockCtx({
			branch: buildSessionEntries([makeUserMessage("earlier user turn")]),
		});
		ctx.model = { provider: "a", id: "m" } as never;
		vi.mocked(completeSimple).mockImplementationOnce((async (_m: unknown, req: { messages: unknown[] }) => {
			expect(req.messages[0]).toMatchObject({
				role: "user",
				content: [{ type: "text", text: "earlier user turn" }],
			});
			return makeCompletionResponse({ text: "ok" });
		}) as never);
		await executeBtw("q", ctx, new AbortController());
	});
});

describe("registerMessageEndSnapshot", () => {
	it("writes a snapshot on non-toolUse assistant message_end", async () => {
		const { pi, captured } = createMockPi();
		registerMessageEndSnapshot(pi);
		const handler = captured.events.get("message_end")?.[0];
		expect(handler).toBeDefined();
		const ctx = createMockCtx({
			branch: buildSessionEntries([makeUserMessage("u1"), makeAssistantMessage({ text: "a1" })]),
		});
		await handler?.({ message: makeAssistantMessage({ text: "a1" }) } as never, ctx as never);
		const state = (globalThis as Record<symbol, { snapshots: Map<string, unknown> }>)[BTW_STATE_KEY];
		expect(state.snapshots.has("/tmp/test-session.jsonl")).toBe(true);
	});
	it("skips snapshot when stopReason=toolUse", async () => {
		const { pi, captured } = createMockPi();
		registerMessageEndSnapshot(pi);
		const handler = captured.events.get("message_end")?.[0];
		const msg = { ...makeAssistantMessage({ text: "x" }), stopReason: "toolUse" };
		const ctx = createMockCtx();
		await handler?.({ message: msg } as never, ctx as never);
		const state = (globalThis as unknown as Record<symbol, { snapshots?: Map<string, unknown> } | undefined>)[
			BTW_STATE_KEY
		];
		expect(state?.snapshots?.has("/tmp/test-session.jsonl") ?? false).toBe(false);
	});
	it("skips snapshot for user role", async () => {
		const { pi, captured } = createMockPi();
		registerMessageEndSnapshot(pi);
		const handler = captured.events.get("message_end")?.[0];
		await handler?.({ message: makeUserMessage("u") } as never, createMockCtx() as never);
		const state = (globalThis as unknown as Record<symbol, { snapshots?: Map<string, unknown> } | undefined>)[
			BTW_STATE_KEY
		];
		expect(state?.snapshots?.has("/tmp/test-session.jsonl") ?? false).toBe(false);
	});
});

describe("registerInvalidationHooks", () => {
	it("wires session_compact + session_tree", () => {
		const { pi, captured } = createMockPi();
		registerInvalidationHooks(pi);
		expect(captured.events.has("session_compact")).toBe(true);
		expect(captured.events.has("session_tree")).toBe(true);
	});
	it("handlers clear the snapshot for the session", async () => {
		const { pi, captured } = createMockPi();
		registerInvalidationHooks(pi);
		(globalThis as Record<symbol, { snapshots: Map<string, unknown> }>)[BTW_STATE_KEY] = {
			histories: new Map(),
			snapshots: new Map([["/tmp/test-session.jsonl", { messages: [] }]]),
		} as never;
		const compactHandler = captured.events.get("session_compact")?.[0];
		await compactHandler?.({} as never, createMockCtx() as never);
		const state = (globalThis as Record<symbol, { snapshots: Map<string, unknown> }>)[BTW_STATE_KEY];
		expect(state.snapshots.has("/tmp/test-session.jsonl")).toBe(false);
	});
});

describe("registerBtwCommand", () => {
	it("registers /btw with handler", () => {
		const { pi, captured } = createMockPi();
		registerBtwCommand(pi);
		expect(captured.commands.has("btw")).toBe(true);
		const cmd = captured.commands.get("btw");
		expect(cmd?.description).toContain("side question");
		expect(typeof cmd?.handler).toBe("function");
	});
});
