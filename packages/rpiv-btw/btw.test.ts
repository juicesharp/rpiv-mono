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

// Mock the loader so the overflow gate is controllable independently of the
// real isContextOverflow regex behavior. loadCompleteSimple is routed to the
// shared completeSimple spy (above) so existing mockResolvedValueOnce chains
// keep working; loadIsContextOverflow defaults to undefined (legacy host, no
// retry) and is overridden per-test in the overflow-retry suite.
// getRuntimeCompleteSimple stays REAL: mock hosts have no `runtime` slot, so
// tests default to the legacy path, and runtime-facade tests opt in by
// defining a `runtime` slot on ctx.modelRegistry.
vi.mock("./pi-compat.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./pi-compat.js")>();
	return {
		getRuntimeCompleteSimple: actual.getRuntimeCompleteSimple,
		loadCompleteSimple: vi.fn(),
		loadIsContextOverflow: vi.fn(),
	};
});

import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	assistantMessageText,
	BTW_STATE_KEY,
	BTW_SYSTEM_PROMPT,
	type BtwTurn,
	buildBtwMessages,
	CROSS_SESSION_HINT_LIMIT,
	clearSessionHistory,
	executeBtw,
	invalidateSnapshot,
	registerBtwCommand,
	registerInvalidationHooks,
	registerMessageEndSnapshot,
	userMessageText,
} from "./btw.js";
import { loadCompleteSimple, loadIsContextOverflow } from "./pi-compat.js";

// Pins the substring `isStaleCtxError` matches in pi-core's invalidated-proxy error.
const STALE_CTX_MESSAGE = "This extension ctx is stale after session replacement or reload.";

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
	vi.mocked(loadCompleteSimple).mockReset();
	vi.mocked(loadIsContextOverflow).mockReset();
	// Route the loader to the shared completeSimple spy so existing
	// mockResolvedValueOnce(makeCompletionResponse(...)) chains keep working.
	vi.mocked(loadCompleteSimple).mockResolvedValue(completeSimple as never);
	// Default: legacy host (isContextOverflow absent) → no retry. Per-test
	// overrides set a real overflowFn to exercise the gate.
	vi.mocked(loadIsContextOverflow).mockResolvedValue(undefined);
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
		expect(r.kind).toBe("success");
		if (r.kind !== "success") throw new Error("unexpected");
		expect(r.answer).toBe("answer text");
		expect(r.userMessage.content).toEqual([{ type: "text", text: "question" }]);
		expect(r.assistantMessage).toBeDefined();
	});
});

describe("executeBtw — error branches", () => {
	it("returns error when no model", async () => {
		const ctx = createMockCtx();
		ctx.model = undefined;
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r).toMatchObject({ kind: "error", error: "/btw requires an active model" });
	});
	it("returns error when getApiKeyAndHeaders is not ok", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		ctx.modelRegistry = {
			...ctx.modelRegistry,
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: false, error: "bad creds" })),
		} as never;
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r.kind).toBe("error");
		if (r.kind !== "error") throw new Error("unexpected");
		expect(r.error).toContain("misconfigured");
		expect(r.error).toContain("bad creds");
	});
	it("returns error when apiKey absent and the host has no runtime facade", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		ctx.modelRegistry = {
			...ctx.modelRegistry,
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "", headers: {} })),
		} as never;
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r.kind).toBe("error");
		if (r.kind !== "error") throw new Error("unexpected");
		expect(r.error).toContain("no API key");
	});
	it("proceeds via the runtime facade when OAuth auth resolves ok without an apiKey", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		const runtime = {
			completeSimple: vi.fn((..._args: unknown[]) =>
				Promise.resolve(makeCompletionResponse({ text: "oauth answer" })),
			),
		};
		// OAuth-backed providers (e.g. kimi-coding) resolve ok with no literal key;
		// credentials are applied inside Pi's runtime facade. Pi keeps ModelRuntime
		// behind ModelRegistry's runtime-private slot — keep it non-enumerable to
		// mirror that host shape.
		ctx.modelRegistry = {
			...ctx.modelRegistry,
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true })),
		} as never;
		Object.defineProperty(ctx.modelRegistry, "runtime", { value: runtime });
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r.kind).toBe("success");
		expect(completeSimple).not.toHaveBeenCalled();
		expect(runtime.completeSimple).toHaveBeenCalledTimes(1);
		const options = runtime.completeSimple.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
		expect(options).not.toHaveProperty("apiKey");
		expect(options).not.toHaveProperty("headers");
		expect(options).toHaveProperty("signal");
	});
	it("prefers the runtime facade over the legacy path even when an apiKey exists", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		const runtime = {
			completeSimple: vi.fn((..._args: unknown[]) =>
				Promise.resolve(makeCompletionResponse({ text: "runtime answer" })),
			),
		};
		Object.defineProperty(ctx.modelRegistry, "runtime", { value: runtime });
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r.kind).toBe("success");
		expect(completeSimple).not.toHaveBeenCalled();
		const options = runtime.completeSimple.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
		expect(options).not.toHaveProperty("apiKey");
	});
	it("returns aborted when stopReason=aborted", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		vi.mocked(completeSimple).mockResolvedValueOnce(makeCompletionResponse({ stopReason: "aborted" }) as never);
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r).toMatchObject({ kind: "aborted" });
	});
	it("returns error when stopReason=error", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		vi.mocked(completeSimple).mockResolvedValueOnce(
			makeCompletionResponse({ stopReason: "error", errorMessage: "remote 500" }) as never,
		);
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r.kind).toBe("error");
		if (r.kind !== "error") throw new Error("unexpected");
		expect(r.error).toContain("remote 500");
	});
	it("returns error when response has no text content", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		vi.mocked(completeSimple).mockResolvedValueOnce(makeCompletionResponse({ stopReason: "done" }) as never);
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r.kind).toBe("error");
		if (r.kind !== "error") throw new Error("unexpected");
		expect(r.error).toContain("no text content");
	});
	it("translates controller.signal.aborted on thrown error to aborted=true", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		const controller = new AbortController();
		controller.abort();
		vi.mocked(completeSimple).mockRejectedValueOnce(new Error("abort"));
		const r = await executeBtw("q", ctx, controller);
		expect(r).toMatchObject({ kind: "aborted" });
	});
	it("wraps unknown throws as errCallThrew", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m" } as never;
		vi.mocked(completeSimple).mockRejectedValueOnce(new Error("boom"));
		const r = await executeBtw("q", ctx, new AbortController());
		expect(r.kind).toBe("error");
		if (r.kind !== "error") throw new Error("unexpected");
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

describe("buildBtwMessages — history cap engagement", () => {
	// createMockCtx's session file key — matches the clearSessionHistory test above.
	const SESSION_FILE = "/tmp/test-session.jsonl";
	const histToks = (n: number): string => "x".repeat(n * 4);
	// Turn of ~`cost` estimated tokens (tag adds a negligible handful of chars) whose
	// text carries `tag` so presence/absence is assertable on the assembled messages.
	const histTurn = (cost: number, tag: string): BtwTurn => ({
		userMessage: makeUserMessage(`${tag} ${histToks(cost)}`),
		assistantMessage: makeAssistantMessage({}),
	});
	// Three ~3000-token turns ≈ 9000 total: over the 8192 cap by exactly one oldest turn.
	const threeTurns = (): BtwTurn[] => [histTurn(3000, "h-old"), histTurn(3000, "h-mid"), histTurn(3000, "h-new")];
	function seedHistory(turns: BtwTurn[]): void {
		(globalThis as Record<symbol, unknown>)[BTW_STATE_KEY] = {
			histories: new Map([[SESSION_FILE, turns]]),
			snapshots: new Map(),
		};
	}

	it("keeps the FULL history past the 8192 cap when the whole request fits the window", () => {
		seedHistory(threeTurns());
		const ctx = createMockCtx({ branch: buildSessionEntries([makeUserMessage("branch-turn")]) });
		ctx.model = { provider: "a", id: "m", contextWindow: 200000, maxTokens: 8192 } as never;
		const built = buildBtwMessages(ctx, makeUserMessage("q"));
		expect(built.droppedTurns).toBe(0);
		expect(JSON.stringify(built.messages)).toContain("h-old");
		// 1 branch message + 3×2 history messages + the question — nothing capped away.
		expect(built.messages).toHaveLength(8);
	});

	it("caps history (drops the oldest turn) once the full-history request is over budget", () => {
		seedHistory(threeTurns());
		// Branch ≈ 4800 estimated tokens (1.2× no-anchor factor). available = 30000 − 1000 −
		// 16384 = 12616: full history (~9000) leaves ~3400 — branch cannot fit; capped
		// history (~6000) frees ~6400 — branch fits without trimming.
		const ctx = createMockCtx({ branch: buildSessionEntries([makeUserMessage(histToks(4000))]) });
		ctx.model = { provider: "a", id: "m", contextWindow: 30000, maxTokens: 1000 } as never;
		const built = buildBtwMessages(ctx, makeUserMessage("q"));
		expect(built.droppedTurns).toBe(1);
		const text = JSON.stringify(built.messages);
		expect(text).not.toContain("h-old");
		expect(text).toContain("h-mid");
		expect(text).toContain("h-new");
	});

	it("overflow-retry path (explicit keepBudget) always uses the capped history", () => {
		seedHistory(threeTurns());
		const ctx = createMockCtx({ branch: buildSessionEntries([makeUserMessage("branch-turn")]) });
		ctx.model = { provider: "a", id: "m", contextWindow: 200000, maxTokens: 8192 } as never;
		// Same window as the parity test above — only the explicit keepBudget differs.
		const built = buildBtwMessages(ctx, makeUserMessage("q"), 50);
		expect(built.droppedTurns).toBe(1);
		expect(built.keepBudget).toBe(50);
	});
});

describe("executeBtw — overflow retry", () => {
	it("retries exactly once on first-call overflow, then succeeds with the retry's answer", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m", contextWindow: 8192 } as never;
		const overflowFn = vi.fn(() => true);
		vi.mocked(loadIsContextOverflow).mockResolvedValue(overflowFn as never);
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(
				makeCompletionResponse({ stopReason: "error", errorMessage: "prompt is too long" }) as never,
			)
			.mockResolvedValueOnce(makeCompletionResponse({ text: "retry answer" }) as never);

		const r = await executeBtw("q", ctx, new AbortController());

		expect(r.kind).toBe("success");
		if (r.kind !== "success") throw new Error("unexpected");
		expect(r.answer).toBe("retry answer");
		expect(completeSimple).toHaveBeenCalledTimes(2);
		// The retry rebuilt the context: the second call received a freshly built
		// messages array (buildBtwMessages returns a new spread each call).
		const calls = vi.mocked(completeSimple).mock.calls as Array<[unknown, { messages: unknown[] }, unknown]>;
		expect(calls[1][1].messages).not.toBe(calls[0][1].messages);
	});

	it("does not retry when the first call is aborted (aborted arm, single call)", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m", contextWindow: 8192 } as never;
		const overflowFn = vi.fn(() => true);
		vi.mocked(loadIsContextOverflow).mockResolvedValue(overflowFn as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(makeCompletionResponse({ stopReason: "aborted" }) as never);

		const r = await executeBtw("q", ctx, new AbortController());

		expect(r).toMatchObject({ kind: "aborted" });
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(overflowFn).not.toHaveBeenCalled();
	});

	it("returns the aborted arm when the retry itself is aborted", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m", contextWindow: 8192 } as never;
		vi.mocked(loadIsContextOverflow).mockResolvedValue(vi.fn(() => true) as never);
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(
				makeCompletionResponse({ stopReason: "error", errorMessage: "prompt is too long" }) as never,
			)
			.mockResolvedValueOnce(makeCompletionResponse({ stopReason: "aborted" }) as never);

		const r = await executeBtw("q", ctx, new AbortController());

		expect(r).toMatchObject({ kind: "aborted" });
		expect(completeSimple).toHaveBeenCalledTimes(2);
	});

	it("falls through to the error arm when the retry also overflows (no third call)", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m", contextWindow: 8192 } as never;
		vi.mocked(loadIsContextOverflow).mockResolvedValue(vi.fn(() => true) as never);
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(
				makeCompletionResponse({ stopReason: "error", errorMessage: "prompt is too long" }) as never,
			)
			.mockResolvedValueOnce(
				makeCompletionResponse({ stopReason: "error", errorMessage: "prompt is too long" }) as never,
			);

		const r = await executeBtw("q", ctx, new AbortController());

		expect(r.kind).toBe("error");
		if (r.kind !== "error") throw new Error("unexpected");
		expect(r.error).toContain("call failed");
		expect(completeSimple).toHaveBeenCalledTimes(2);
	});

	it("does not retry on a non-overflow error (overflowFn returns false)", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m", contextWindow: 8192 } as never;
		vi.mocked(loadIsContextOverflow).mockResolvedValue(vi.fn(() => false) as never);
		vi.mocked(completeSimple).mockResolvedValueOnce(
			makeCompletionResponse({ stopReason: "error", errorMessage: "remote 500" }) as never,
		);

		const r = await executeBtw("q", ctx, new AbortController());

		expect(r.kind).toBe("error");
		if (r.kind !== "error") throw new Error("unexpected");
		expect(r.error).toContain("remote 500");
		expect(completeSimple).toHaveBeenCalledTimes(1);
	});

	it("does not retry on a legacy host where isContextOverflow is absent (undefined)", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "a", id: "m", contextWindow: 8192 } as never;
		vi.mocked(loadIsContextOverflow).mockResolvedValue(undefined);
		// Even an overflow-looking error does not trigger a retry.
		vi.mocked(completeSimple).mockResolvedValueOnce(
			makeCompletionResponse({ stopReason: "error", errorMessage: "prompt is too long" }) as never,
		);

		const r = await executeBtw("q", ctx, new AbortController());

		expect(r.kind).toBe("error");
		if (r.kind !== "error") throw new Error("unexpected");
		expect(r.error).toContain("call failed");
		expect(completeSimple).toHaveBeenCalledTimes(1);
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
	it("swallows a stale-ctx error (session is being discarded)", async () => {
		const { pi, captured } = createMockPi();
		registerInvalidationHooks(pi);
		// invalidateSnapshot reads ctx.sessionManager first — make it throw stale.
		const staleCtx = {
			get sessionManager(): never {
				throw new Error(STALE_CTX_MESSAGE);
			},
		};
		const compactHandler = captured.events.get("session_compact")?.[0];
		await expect(compactHandler?.({} as never, staleCtx as never)).resolves.toBeUndefined();
	});
	it("propagates a non-stale error", async () => {
		const { pi, captured } = createMockPi();
		registerInvalidationHooks(pi);
		const boomCtx = {
			get sessionManager(): never {
				throw new Error("boom: real bug");
			},
		};
		const treeHandler = captured.events.get("session_tree")?.[0];
		await expect(treeHandler?.({} as never, boomCtx as never)).rejects.toThrow("boom");
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
