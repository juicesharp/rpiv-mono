/**
 * /btw clones the main agent's CONTEXT, not the raw branch (#274) — real
 * `SessionManager` sessions, no session mocks.
 *
 * After a compaction the branch still carries every summarized entry, while the
 * usage anchor `fitBranch` budgets against (the provider's last metered request)
 * describes only the compacted context. Cloning the branch let the fast path
 * judge "fits" and then send the whole uncompacted history — many times the
 * window. Each test builds a real session, records the main agent's context the
 * way Pi builds its requests (`buildSessionContext`), and asserts /btw sends
 * exactly that context plus the question.
 */

import {
	type AssistantMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
	type Model,
	normalizeContext,
	type Usage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	type ExtensionContext,
	estimateTokens,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import { buildBtwMessages, registerMessageEndSnapshot } from "./btw.js";

const WINDOW = 200_000;
const MAX_OUTPUT = 32_000;
const model = {
	provider: "test",
	id: "m",
	api: "openai-completions",
	contextWindow: WINDOW,
	maxTokens: MAX_OUTPUT,
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<"openai-completions">;

/** ~`chars` of text tagged so a turn's content is recognisable in the sent context. */
const text = (tag: string, chars: number) => `${tag} `.repeat(Math.ceil(chars / (tag.length + 1))).slice(0, chars);

const usage = (input: number): Usage =>
	({
		input,
		output: 500,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 500,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}) as Usage;

const user = (body: string): UserMessage => ({ role: "user", content: [{ type: "text", text: body }], timestamp: 0 });

/** The main agent's request context — what Pi sends, and what the provider's usage meters. */
const mainContext = (sm: SessionManager): Message[] =>
	convertToLlm(buildSessionContext(sm.getEntries(), sm.getLeafId()).messages);
const tokens = (messages: Message[]) => messages.reduce((sum, m) => sum + estimateTokens(m), 0);

/** Append an assistant turn whose usage is the metered size of the main agent's current request. */
function appendAssistant(sm: SessionManager, body: string): void {
	const metered = tokens(mainContext(sm)) + 2_000; // + the main agent's system prompt and tools
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: body }],
		usage: usage(metered),
		stopReason: "stop",
		api: "openai-completions",
		provider: "test",
		model: "m",
		timestamp: 0,
	} as AssistantMessage);
}

/**
 * 300 turns of ~1k tokens each side (~600k tokens on the branch), compacted at
 * turn 290 keeping turns 280+ — the main agent's context is ~43k tokens.
 */
function compactedSession(): SessionManager {
	const sm = SessionManager.inMemory("/tmp");
	let firstKeptId = "";
	for (let t = 1; t <= 300; t++) {
		const id = sm.appendMessage(user(text(`turn${t}-user`, 4_000)));
		if (t === 280) firstKeptId = id;
		if (t === 290) sm.appendCompaction(text("summary", 2_000), firstKeptId, 560_000);
		appendAssistant(sm, text(`turn${t}-assistant`, 4_000));
	}
	return sm;
}

const ctxFor = (sm: SessionManager) => ({ model, sessionManager: sm, hasUI: false }) as unknown as ExtensionContext;
const question = user("side question?");

describe("/btw sends the main agent's context, not the raw branch (#274)", () => {
	it("after compaction: sends the compacted context + question, within the window", () => {
		const sm = compactedSession();
		expect(
			tokens(convertToLlm(sm.getBranch().flatMap((e) => (e.type === "message" ? [e.message] : [])))),
		).toBeGreaterThan(WINDOW); // the raw branch alone is far over the window

		const built = buildBtwMessages(ctxFor(sm), question);

		expect(built.messages).toEqual([...mainContext(sm), question]);
		expect(built.branchWasTrimmed).toBe(false); // the compacted context fits — nothing to trim
		expect(tokens(built.messages)).toBeLessThan(WINDOW - MAX_OUTPUT);
		const sent = JSON.stringify(built.messages);
		expect(sent).not.toContain("turn1-user"); // summarized away
		expect(sent).toContain("turn280-user"); // first kept turn
		expect(sent).toContain("summary"); // the compaction summary rides along
	});

	it("the message_end snapshot holds the main agent's context too", async () => {
		const sm = compactedSession();
		const { pi, captured } = createMockPi();
		registerMessageEndSnapshot(pi);
		const [onMessageEnd] = captured.events.get("message_end") ?? [];
		const last = sm.getBranch().at(-1);
		await onMessageEnd?.({ message: last?.type === "message" ? last.message : undefined }, ctxFor(sm));

		// Append after the snapshot: a cached snapshot must be what gets sent, not a live read.
		sm.appendMessage(user(text("after-snapshot", 400)));
		const built = buildBtwMessages(ctxFor(sm), question);

		expect(JSON.stringify(built.messages)).not.toContain("after-snapshot");
		expect(JSON.stringify(built.messages)).not.toContain("turn1-user");
		expect(tokens(built.messages)).toBeLessThan(WINDOW - MAX_OUTPUT);
	});

	// Context edits (and the projection that applies them) exist from Pi 1.0.
	it.skipIf(!("appendContextEdit" in SessionManager.prototype))(
		"applies context edits the way the main agent's request does (Pi >= 1.0 projection)",
		() => {
			const sm = SessionManager.inMemory("/tmp");
			sm.appendMessage(user("start"));
			const bulkyId = sm.appendMessage(user(text("bulky-output", 40_000)));
			sm.appendContextEdit(bulkyId, null); // omitted from the main agent's context
			appendAssistant(sm, "ok");

			const built = buildBtwMessages(ctxFor(sm), question);

			expect(built.messages).toEqual([...mainContext(sm), question]);
			expect(JSON.stringify(built.messages)).not.toContain("bulky-output");
		},
	);

	// Pi >= 1.0 records the main agent's prompt + tool loadout as transcript system messages.
	it("drops the main agent's tool declarations but keeps its prompt text (#295)", () => {
		const sm = SessionManager.inMemory("/tmp");
		const tool = { name: "bash", description: "run a command", parameters: { type: "object", properties: {} } };
		sm.appendMessage({ role: "system", content: "MAIN PROMPT", toolsAdded: [tool], timestamp: 0 } as Message);
		sm.appendMessage(user("question 1"));
		appendAssistant(sm, "answer 1");
		expect(getCurrentTools(mainContext(sm)).map((t) => t.name)).toEqual(["bash"]); // premise

		const built = buildBtwMessages(ctxFor(sm), question);
		const request = normalizeContext({ systemPrompt: built.systemPrompt, messages: built.messages, tools: [] });

		expect(getCurrentTools(request.messages)).toEqual([]);
		expect(getCurrentSystemPrompt(request.messages)).toContain("MAIN PROMPT");
	});

	it("without compaction the context is the whole conversation, sent unchanged", () => {
		const sm = SessionManager.inMemory("/tmp");
		for (let t = 1; t <= 3; t++) {
			sm.appendMessage(user(`question ${t}`));
			appendAssistant(sm, `answer ${t}`);
		}
		const built = buildBtwMessages(ctxFor(sm), question);
		expect(built.messages).toEqual([...mainContext(sm), question]);
		expect(built.messages).toHaveLength(7);
	});
});
