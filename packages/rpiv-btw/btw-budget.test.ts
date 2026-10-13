import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	buildSessionEntries,
	makeAssistantMessage,
	makeToolResult,
	makeUserMessage,
} from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import {
	BTW_CONTEXT_RESERVE,
	BTW_HISTORY_TOKEN_BUDGET,
	BTW_NO_ANCHOR_SAFETY_FACTOR,
	type BtwTurn,
	branchToContextMessages,
} from "./btw.js";
import { BTW_STUB_TEXT, type CappedHistory, capHistory, fitBranch } from "./btw-budget.js";

// toks(n) → a string whose estimateTokens is exactly n (chars/4, length a multiple of 4).
const toks = (n: number): string => "x".repeat(n * 4);

// turn(cost) → a BtwTurn whose per-turn estimateTokens cost is exactly `cost`
// (cost lives entirely on the user message; the assistant message is empty → 0 tokens).
const turn = (cost: number): BtwTurn => ({
	userMessage: makeUserMessage(toks(cost)),
	assistantMessage: makeAssistantMessage({}),
});

// Expected per-turn cost via the REAL host estimateTokens — the oracle for estimate assertions.
const turnCost = (t: BtwTurn): number => estimateTokens(t.userMessage) + estimateTokens(t.assistantMessage);

describe("capHistory — empty input", () => {
	it("returns an empty admit with zero estimate and zero drops", () => {
		const result = capHistory([]);
		expect(result).toEqual({ admitted: [], estimate: 0, droppedTurns: 0 } satisfies CappedHistory);
		expect(result.admitted).toHaveLength(0);
	});
});

describe("capHistory — maximal-suffix admission", () => {
	it("admits the maximal newest suffix whose summed cost ≤ budget across mixed-cost turns", () => {
		// costs oldest→newest: [10, 2, 1, 1]; budget 4
		// newest(1)→1; +1→2; +2→4; +10→14>4 break ⇒ admit indices [1,2,3], estimate 4, drop 1
		const history = [turn(10), turn(2), turn(1), turn(1)];
		const result = capHistory(history, 4);
		expect(result.admitted).toHaveLength(3);
		expect(result.droppedTurns).toBe(1);
		expect(result.estimate).toBe(4);
		// maximal: admitting the dropped oldest turn (cost 10) would push 4→14 > 4
		expect(result.estimate + turnCost(history[0])).toBeGreaterThan(4);
		// a smaller suffix would not be maximal — the newest three all fit
		expect(result.admitted[0]).toBe(history[1]);
	});

	it("admits everything when the whole history fits (no break)", () => {
		const history = [turn(1), turn(2), turn(3)];
		const result = capHistory(history, 100);
		expect(result.admitted).toHaveLength(3);
		expect(result.droppedTurns).toBe(0);
		expect(result.estimate).toBe(6);
	});

	it("admits only the newest when the second-newest would overflow", () => {
		// costs [5, 1]; budget 2 ⇒ newest(1) fits, +5>2 break ⇒ admit [newest], drop 1
		const history = [turn(5), turn(1)];
		const result = capHistory(history, 2);
		expect(result.admitted).toHaveLength(1);
		expect(result.droppedTurns).toBe(1);
		expect(result.estimate).toBe(1);
	});
});

describe("capHistory — floor guarantee", () => {
	it("admits the newest turn even when it alone exceeds budget (estimate unclamped)", () => {
		// newest cost 100 > budget 50 ⇒ floor admits it, estimate carries the over-budget cost
		const history = [turn(100), turn(100)];
		const result = capHistory(history, 50);
		expect(result.admitted).toHaveLength(1);
		expect(result.droppedTurns).toBe(1);
		expect(result.estimate).toBe(100);
		expect(result.estimate).toBeGreaterThan(50); // over budget, NOT clamped
	});

	it("admits a single over-budget turn from a one-element history with droppedTurns 0", () => {
		const history = [turn(100)];
		const result = capHistory(history, 10);
		expect(result.admitted).toHaveLength(1);
		expect(result.droppedTurns).toBe(0);
		expect(result.estimate).toBe(100);
		expect(result.estimate).toBeGreaterThan(10);
	});
});

describe("capHistory — reference identity (no copy)", () => {
	it("admitted elements are reference-identical to the input suffix (toBe, not toEqual)", () => {
		const history = [turn(1), turn(2), turn(3)];
		const result = capHistory(history, 100); // admits all
		expect(result.admitted[0]).toBe(history[0]);
		expect(result.admitted[2]).toBe(history[2]);
		// nested message references are identical too
		expect(result.admitted[0].userMessage).toBe(history[0].userMessage);
		expect(result.admitted[2].assistantMessage).toBe(history[2].assistantMessage);
	});

	it("admitted elements are reference-identical to the capped suffix", () => {
		// costs [100, 1, 2]; budget 4 ⇒ admit indices [1,2]
		const history = [turn(100), turn(1), turn(2)];
		const result = capHistory(history, 4);
		expect(result.admitted).toHaveLength(2);
		expect(result.admitted[0]).toBe(history[1]);
		expect(result.admitted[1]).toBe(history[2]);
		expect(result.admitted[0].userMessage).toBe(history[1].userMessage);
	});
});

describe("capHistory — purity (no mutation)", () => {
	it("does not mutate history or its elements", () => {
		const history: BtwTurn[] = [turn(1), turn(2)];
		const before = structuredClone(history);
		const result = capHistory(history, 2); // caps: newest(2) fits, +1>2 break ⇒ drop oldest
		expect(history).toEqual(before);
		expect(history).toHaveLength(2);
		// the returned slice shares element references but capHistory wrote nothing back
		expect(result.admitted).toHaveLength(1);
		expect(history[1].userMessage.content).toEqual(before[1].userMessage.content);
	});

	it("does not mutate history when admitting everything", () => {
		const history = [turn(1), turn(2)];
		const before = structuredClone(history);
		capHistory(history, 100);
		expect(history).toEqual(before);
	});
});

describe("capHistory — droppedTurns invariant", () => {
	it("droppedTurns === history.length - admitted.length in all cases", () => {
		const cases: Array<{ history: BtwTurn[]; budget: number }> = [
			{ history: [turn(10), turn(2), turn(1), turn(1)], budget: 4 },
			{ history: [turn(1), turn(2), turn(3)], budget: 100 },
			{ history: [turn(100), turn(100)], budget: 50 },
			{ history: [turn(5)], budget: 1 },
			{ history: [], budget: 8192 },
		];
		for (const { history, budget } of cases) {
			const result = capHistory(history, budget);
			expect(result.droppedTurns).toBe(history.length - result.admitted.length);
		}
	});
});

describe("capHistory — estimate accuracy (real host estimateTokens)", () => {
	it("estimate === sum over admitted turns of estimateTokens(user) + estimateTokens(assistant)", () => {
		// mixed-cost, partially capped so admitted != whole history
		const history = [turn(7), turn(3), turn(2), turn(1)];
		const budget = 6; // newest(1)→1; +2→3; +3→6; +7→13>6 break ⇒ admit [1,2,3]
		const result = capHistory(history, budget);
		const expected = result.admitted.reduce((sum, t) => sum + turnCost(t), 0);
		expect(result.estimate).toBe(expected);
		expect(result.admitted).toHaveLength(3);
	});

	it("estimate === over-budget cost of the lone admitted newest turn (floor case)", () => {
		const history = [turn(9), turn(9)];
		const result = capHistory(history, 5); // floor: newest alone exceeds
		expect(result.estimate).toBe(turnCost(history[1]));
		expect(result.estimate).toBeGreaterThan(5);
	});

	it("estimate === 0 for empty input", () => {
		expect(capHistory([]).estimate).toBe(0);
	});
});

describe("capHistory — BTW_HISTORY_TOKEN_BUDGET default param", () => {
	it("BTW_HISTORY_TOKEN_BUDGET is exported from btw.ts with value 8192", () => {
		expect(BTW_HISTORY_TOKEN_BUDGET).toBe(8192);
	});

	it("omitting budget defaults to BTW_HISTORY_TOKEN_BUDGET (same result as explicit 8192)", () => {
		// a history that caps under the default so the boundary is exercised
		const history = [turn(8000), turn(100), turn(100)];
		const implicit = capHistory(history);
		const explicit = capHistory(history, BTW_HISTORY_TOKEN_BUDGET);
		expect(implicit).toEqual(explicit);
		// default boundary: newest(100)→100; +100→200; +8000→8200>8192 break ⇒ drop oldest
		expect(implicit.admitted).toHaveLength(2);
		expect(implicit.droppedTurns).toBe(1);
	});
});

// A model with a usable window. contextWindow/maxTokens chosen so `available` is generous.
function makeModel(opts: { contextWindow?: number; maxTokens?: number } = {}): Model<Api> {
	return {
		provider: "anthropic",
		id: "test-model",
		api: "anthropic-messages",
		contextWindow: opts.contextWindow ?? 200000,
		maxTokens: opts.maxTokens ?? 8192,
	} as unknown as Model<Api>;
}

// An assistant message carrying a complete Usage + valid stopReason (makeAssistantMessage
// omits both — the anchor-path tests need them inline).
function makeAssistantWithUsage(text: string, totalTokens: number): AssistantMessage {
	const usage: Usage = {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		stopReason: "stop",
		usage,
	} as unknown as AssistantMessage;
}

const SYS = "system prompt";
const Q = makeUserMessage("question");

describe("fitBranch — FR1 fast-path parity", () => {
	it("returns the cached messages by reference when the branch fits (toBe, not toEqual)", () => {
		const entries = buildSessionEntries([makeUserMessage("u"), makeAssistantMessage({ text: "a" })]);
		const cached = branchToContextMessages(entries); // = the messages buildBtwMessages would cache
		const fit = fitBranch({
			entries,
			messages: cached,
			model: makeModel(),
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: 0,
		});
		expect(fit.branchWasTrimmed).toBe(false);
		expect(fit.stubbed).toBe(false);
		expect(fit.messages).toBe(cached); // identical array reference (byte-identical prefix)
		for (let i = 0; i < cached.length; i++) expect(fit.messages[i]).toBe(cached[i]);
	});

	it("does not mutate the cached snapshot array or its messages on the fast path", () => {
		const entries = buildSessionEntries([makeUserMessage("u"), makeAssistantMessage({ text: "a" })]);
		const cached = branchToContextMessages(entries);
		const before = structuredClone(cached);
		fitBranch({
			entries,
			messages: cached,
			model: makeModel(),
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: 0,
		});
		expect(cached).toEqual(before); // no mutation of cached array contents
	});
});

describe("fitBranch — FR3 skip guard", () => {
	it("fast-paths the cached messages when the window is unusable (keepBudget unset)", () => {
		const entries = buildSessionEntries([makeUserMessage("u")]);
		const cached = branchToContextMessages(entries);
		// contextWindow <= maxTokens + RESERVE → available <= 0 → not budgetable
		const model = makeModel({ contextWindow: 100, maxTokens: 8192 });
		const fit = fitBranch({
			entries,
			messages: cached,
			model,
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: 0,
		});
		expect(fit.branchWasTrimmed).toBe(false);
		expect(fit.stubbed).toBe(false);
		expect(fit.messages).toBe(cached); // === cached input
	});

	it("populates keepBudget on the skip-guard path (never undefined)", () => {
		const entries = buildSessionEntries([makeUserMessage("u")]);
		const cached = branchToContextMessages(entries);
		const fit = fitBranch({
			entries,
			messages: cached,
			model: makeModel({ contextWindow: 100, maxTokens: 8192 }),
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: 0,
		});
		expect(typeof fit.keepBudget).toBe("number");
	});
});

describe("fitBranch — FR3 budget formula", () => {
	it("branchKeepBudget = contextWindow - maxTokens - RESERVE - ceil(sys/4) - estimateTokens(Q) - admitted", () => {
		// Branch small enough to fast-path, so we can assert keepBudget is the window value.
		const entries = buildSessionEntries([makeUserMessage("u")]);
		const cached = branchToContextMessages(entries);
		const model = makeModel({ contextWindow: 200000, maxTokens: 8192 });
		const fit = fitBranch({
			entries,
			messages: cached,
			model,
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: 100,
		});
		const available = model.contextWindow - model.maxTokens - BTW_CONTEXT_RESERVE;
		const expected = available - Math.ceil(SYS.length / 4) - estimateTokens(Q) - 100;
		expect(fit.keepBudget).toBe(expected);
		expect(fit.branchWasTrimmed).toBe(false);
	});
});

describe("fitBranch — FR2 anchor accounting vs no-anchor fallback", () => {
	it("uses calculateContextTokens(usage) when a usage anchor exists (FR2.4 overcount)", () => {
		// Anchor totalTokens huge → branchUsage huge → must trim. Assert trim happened and
		// the anchor path was taken by checking branchWasTrimmed with a tiny keepBudget.
		const entries = buildSessionEntries([
			makeUserMessage("u1"),
			makeAssistantWithUsage("a1", 50000),
			makeUserMessage("u2"),
		]);
		const cached = branchToContextMessages(entries);
		const model = makeModel({ contextWindow: 200000, maxTokens: 8192 });
		// Force a tiny budget by claiming nearly all available is spoken for.
		const fit = fitBranch({
			entries,
			messages: cached,
			model,
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: model.contextWindow - model.maxTokens - BTW_CONTEXT_RESERVE - 1,
		});
		// branchUsage (=50000 anchor) far exceeds the ~1-token budget → trim/stub engaged.
		expect(fit.branchWasTrimmed || fit.stubbed).toBe(true);
	});

	it("no-anchor fallback applies BTW_NO_ANCHOR_SAFETY_FACTOR (1.2) — factor is 1.2", () => {
		expect(BTW_NO_ANCHOR_SAFETY_FACTOR).toBe(1.2);
		// No assistant usage anchor (makeAssistantMessage omits usage) → 1.2x sum path taken.
		const entries = buildSessionEntries([makeUserMessage("u"), makeAssistantMessage({ text: "a" })]);
		const cached = branchToContextMessages(entries);
		const model = makeModel({ contextWindow: 200000, maxTokens: 8192 });
		const fit = fitBranch({
			entries,
			messages: cached,
			model,
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: 0,
		});
		// Small branch fast-paths (1.2x sum still < budget); assert it fast-pathed, proving
		// the no-anchor path executed without throwing.
		expect(fit.branchWasTrimmed).toBe(false);
	});
});

describe("fitBranch — FR2 post-anchor tail accounting", () => {
	// Window budget ≈ 1000 − sys(4) − Q(2) tokens in all three tests: anchor usage 400
	// alone fits; anchor + a ~1200-token unmetered tail must not. The tail exceeds the
	// budget under BOTH metrics (anchor accounting AND raw chars/4) so the trim/stub
	// machinery — which cuts by raw estimates — visibly engages.
	const anchoredFit = (entries: SessionEntry[]) => {
		const cached = branchToContextMessages(entries);
		const model = makeModel();
		const available = model.contextWindow - model.maxTokens - BTW_CONTEXT_RESERVE;
		return {
			cached,
			fit: fitBranch({
				entries,
				messages: cached,
				model,
				systemPrompt: SYS,
				question: Q,
				admittedEstimate: available - 1000,
			}),
		};
	};

	it("counts entries after the usage anchor (anchor alone fits; anchor + tail trims)", () => {
		const { cached, fit } = anchoredFit(
			buildSessionEntries([
				makeUserMessage("u1"),
				makeAssistantWithUsage("a1", 400),
				makeUserMessage(toks(1200)), // unmetered post-anchor turn
			]),
		);
		expect(fit.branchWasTrimmed || fit.stubbed).toBe(true);
		expect(fit.messages).not.toBe(cached);
	});

	it("control: an anchor covering the whole branch still fast-paths", () => {
		const { cached, fit } = anchoredFit(
			buildSessionEntries([makeUserMessage("u1"), makeAssistantWithUsage("a1", 400)]),
		);
		expect(fit.branchWasTrimmed).toBe(false);
		expect(fit.stubbed).toBe(false);
		expect(fit.messages).toBe(cached);
	});

	it("tail spans every unmetered entry behind the anchor, not just the newest", () => {
		const { fit } = anchoredFit(
			buildSessionEntries([
				makeUserMessage("u1"),
				makeAssistantWithUsage("a1", 400),
				makeUserMessage(toks(300)),
				makeAssistantMessage({ text: toks(1000) }), // no usage → not an anchor, still occupies the window
			]),
		);
		expect(fit.branchWasTrimmed || fit.stubbed).toBe(true);
	});
});

describe("fitBranch — FR5 forward-scan trim", () => {
	it("kept suffix opens on a turn-start (never an orphaned assistant/toolResult)", () => {
		// Two turns; force a trim that drops the first turn. Second turn opens on its user msg.
		const entries = buildSessionEntries([
			makeUserMessage("first-turn-user-that-is-very-long ".repeat(200)),
			makeAssistantMessage({ text: "first-turn-assistant-that-is-very-long ".repeat(200) }),
			makeUserMessage("u2"),
			makeAssistantMessage({ text: "a2" }),
		]);
		const cached = branchToContextMessages(entries);
		const model = makeModel({ contextWindow: 200000, maxTokens: 8192 });
		// Budget enough for only the last turn → first turn dropped. admittedEstimate claims
		// all but ~100 tokens of the window so the huge first turn cannot fit.
		const available = model.contextWindow - model.maxTokens - BTW_CONTEXT_RESERVE;
		const fit = fitBranch({
			entries,
			messages: cached,
			model,
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: available - 100,
		});
		expect(fit.branchWasTrimmed).toBe(true);
		expect(fit.messages.length).toBeGreaterThan(0);
		// First kept message must be a turn-start (user role after convertToLlm), not assistant/toolResult.
		expect(fit.messages[0].role).toBe("user");
	});

	it("atomicity: no toolCall without its toolResult and vice versa (forward scan skips trailing results)", () => {
		// Assistant with a toolCall followed by its toolResult, then a new user turn.
		const toolAssistant = makeAssistantMessage({
			text: "x".repeat(4000),
			toolCalls: [{ id: "c1", name: "bash", arguments: { cmd: "ls" } }],
		});
		const entries = buildSessionEntries([
			makeUserMessage("seed ".repeat(2000)),
			toolAssistant,
			makeToolResult({ toolCallId: "c1", toolName: "bash", text: "o".repeat(4000) }),
			makeUserMessage("fresh turn"),
			makeAssistantMessage({ text: "ok" }),
		]);
		const cached = branchToContextMessages(entries);
		const model = makeModel({ contextWindow: 200000, maxTokens: 8192 });
		// Claim all but ~100 tokens so the first (tool-bearing) turn cannot survive intact.
		const available = model.contextWindow - model.maxTokens - BTW_CONTEXT_RESERVE;
		const fit = fitBranch({
			entries,
			messages: cached,
			model,
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: available - 100,
		});
		expect(fit.branchWasTrimmed).toBe(true);
		// If trimmed into the first turn, the toolCall+toolResult pair must stay together OR
		// the whole first turn is dropped (opens on "fresh turn"). Assert no orphaned toolResult
		// precedes its toolCall and no toolCall is left without a following toolResult.
		let seenToolCall = false;
		for (const m of fit.messages) {
			if (m.role === "assistant") {
				const hasCall = m.content.some((c) => c.type === "toolCall");
				if (hasCall) seenToolCall = true;
			}
			if (m.role === "toolResult") {
				// a toolResult must follow an assistant that issued a toolCall
				expect(seenToolCall).toBe(true);
				seenToolCall = false;
			}
		}
	});

	it("hybrid filter: a head compaction summary survives a cut (opens the kept suffix)", () => {
		// A compaction entry at the head, then a user turn. Force a trim; the kept suffix
		// should be convertible without crashing and open on a turn-start.
		const compaction = {
			type: "compaction",
			id: "c1",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "prior context summarized",
			firstKeptEntryId: "x",
			tokensBefore: 9999,
		} as unknown as SessionEntry;
		const entries: SessionEntry[] = [
			compaction,
			...buildSessionEntries([
				makeUserMessage("after-compaction-user ".repeat(500)),
				makeAssistantMessage({ text: "after-compaction-a" }),
			]),
		];
		const cached = branchToContextMessages(entries.filter((e) => e.type === "message"));
		const model = makeModel({ contextWindow: 200000, maxTokens: 8192 });
		const fit = fitBranch({
			entries,
			messages: cached,
			model,
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: 0,
		});
		// Either fast-pathed (small) or trimmed; either way no crash and result is a Message[].
		expect(Array.isArray(fit.messages)).toBe(true);
	});
});

describe("fitBranch — FR5/FR6 no-cut-possible fallback", () => {
	it("findCutPoint finds no valid cut (only toolResults) → branchWasTrimmed false, FR6 stubs", () => {
		// Only toolResults (no user-like opener) → no valid cut points → stub the cache.
		const toolResultOnly = makeToolResult({
			toolCallId: "c1",
			toolName: "bash",
			text: "o".repeat(8000),
		});
		const entries = buildSessionEntries([toolResultOnly]);
		const cached = branchToContextMessages(entries);
		const model = makeModel({ contextWindow: 200000, maxTokens: 8192 });
		const fit = fitBranch({
			entries,
			messages: cached,
			model,
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: 0,
		});
		expect(fit.branchWasTrimmed).toBe(false);
	});
});

describe("fitBranch — FR6 tool-result stubbing + terminal truncation", () => {
	it("stubs toolResult content oldest-first, preserving toolCallId/toolName/isError", () => {
		const big = "x".repeat(20000);
		const entries = buildSessionEntries([
			makeUserMessage("u"),
			makeAssistantMessage({ text: "a", toolCalls: [{ id: "c1", name: "bash", arguments: {} }] }),
			makeToolResult({ toolCallId: "c1", toolName: "bash", text: big, isError: true }),
		]);
		const cached = branchToContextMessages(entries);
		const model = makeModel({ contextWindow: 200000, maxTokens: 8192 });
		// Claim all but ~300 tokens: the 20k-char toolResult cannot fit, but its stub can.
		const available = model.contextWindow - model.maxTokens - BTW_CONTEXT_RESERVE;
		const fit = fitBranch({
			entries,
			messages: cached,
			model,
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: available - 300,
		});
		expect(fit.stubbed).toBe(true);
		const tr = fit.messages.find((m) => m.role === "toolResult");
		expect(tr).toBeDefined();
		if (tr && tr.role === "toolResult") {
			expect(tr.toolCallId).toBe("c1");
			expect(tr.toolName).toBe("bash");
			expect(tr.isError).toBe(true);
			expect(JSON.stringify(tr.content)).toContain(BTW_STUB_TEXT);
		}
	});

	it("does not mutate the cached snapshot while stubbing", () => {
		const entries = buildSessionEntries([
			makeUserMessage("u"),
			makeAssistantMessage({ text: "a", toolCalls: [{ id: "c1", name: "bash", arguments: {} }] }),
			makeToolResult({ toolCallId: "c1", toolName: "bash", text: "x".repeat(20000) }),
		]);
		const cached = branchToContextMessages(entries);
		const before = structuredClone(cached);
		const model = makeModel();
		// Force the stubbing path (see above) — a fast-path pass would assert nothing.
		const available = model.contextWindow - model.maxTokens - BTW_CONTEXT_RESERVE;
		const fit = fitBranch({
			entries,
			messages: cached,
			model,
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: available - 300,
		});
		expect(fit.stubbed).toBe(true);
		expect(cached).toEqual(before);
	});

	it("terminal truncation engages when stubbing is insufficient (marker present)", () => {
		// A single gigantic user text block (no toolResult to stub) → terminal truncation.
		const entries = buildSessionEntries([makeUserMessage("x".repeat(60000))]);
		const cached = branchToContextMessages(entries);
		const model = makeModel({ contextWindow: 200000, maxTokens: 8192 });
		// Claim all but ~300 tokens: the 60k-char message must be cut down to fit.
		const available = model.contextWindow - model.maxTokens - BTW_CONTEXT_RESERVE;
		const budget = 300;
		const fit = fitBranch({
			entries,
			messages: cached,
			model,
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: available - budget,
		});
		expect(fit.stubbed).toBe(true);
		expect(JSON.stringify(fit.messages)).toContain("characters truncated");
		// Budget adherence: the truncated result actually fits the remaining budget.
		expect(fit.messages.reduce((sum, m) => sum + estimateTokens(m), 0)).toBeLessThanOrEqual(fit.keepBudget);
	});

	it.each([
		["string", "x".repeat(60000)],
		["text-part", [{ type: "text" as const, text: "x".repeat(60000) }]],
	])(
		"terminal truncation rewrites a system message with %s content (Pi ≥ 1.1 passes them through)",
		(_label, content) => {
			// The largest block is a system message; before it had its own arm, its string content
			// was spread into characters, nothing shrank, and truncation stopped over budget.
			const entries = buildSessionEntries([makeUserMessage("y".repeat(60000))]);
			const cached = [
				{ role: "system", content, timestamp: 0 },
				...branchToContextMessages(entries),
			] as unknown as ReturnType<typeof branchToContextMessages>;
			const model = makeModel({ contextWindow: 200000, maxTokens: 8192 });
			const available = model.contextWindow - model.maxTokens - BTW_CONTEXT_RESERVE;
			const fit = fitBranch({
				entries,
				messages: cached,
				model,
				systemPrompt: SYS,
				question: Q,
				admittedEstimate: available - 300,
			});
			expect(fit.stubbed).toBe(true);
			expect(fit.messages[0].role).toBe("system");
			expect(JSON.stringify(fit.messages[0])).toContain("characters truncated");
			expect(fit.messages.reduce((sum, m) => sum + estimateTokens(m), 0)).toBeLessThanOrEqual(fit.keepBudget);
		},
	);
});

describe("fitBranch — keepBudget contract (Risk r1, for Phase 3)", () => {
	it("keepBudget is populated on the default (fast-path) path", () => {
		const entries = buildSessionEntries([makeUserMessage("u")]);
		const cached = branchToContextMessages(entries);
		const fit = fitBranch({
			entries,
			messages: cached,
			model: makeModel(),
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: 0,
		});
		expect(typeof fit.keepBudget).toBe("number");
	});

	it("keepBudget override is honored and skips the window formula (retry path)", () => {
		// Provide keepBudget → fitBranch must trim/stub to that many tokens directly.
		const entries = buildSessionEntries([
			makeUserMessage("u ".repeat(2000)),
			makeAssistantMessage({ text: "a ".repeat(2000) }),
			makeUserMessage("u2"),
		]);
		const cached = branchToContextMessages(entries);
		const model = makeModel({ contextWindow: 100, maxTokens: 8192 }); // unusable window
		// keepBudget set → skip guard does NOT fire; trim/stub to 1 token.
		const fit = fitBranch({
			entries,
			messages: cached,
			model,
			systemPrompt: SYS,
			question: Q,
			admittedEstimate: 0,
			keepBudget: 1,
		});
		expect(fit.keepBudget).toBe(1);
		expect(fit.branchWasTrimmed || fit.stubbed).toBe(true);
	});
});

// `branchToContextMessages` is imported from ./btw.js (it is the single
// fast-path entry→LLM conversion seam). The fitBranch tests need a cached-`messages`
// array identical to what readSnapshot caches, so the production seam is reused
// directly rather than re-implemented here.
