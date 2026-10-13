/**
 * Context-budget engine for /btw: bounds how much prior side-question history
 * and cloned-primary-branch content ride into a fresh side call so the
 * assembled context stays within the model's window.
 *
 * Pure host-primitive consumers — no ExtensionContext/globalThis access. The
 * caller reads session state and passes plain data in; results are computed
 * value-for-value with reference-identical message elements on the fast path
 * (preserves byte-identical prompt prefix across /btw invocations → cache parity).
 */

import type { Api, Message, Model, UserMessage } from "@earendil-works/pi-ai";
import {
	calculateContextTokens,
	convertToLlm,
	estimateTokens,
	findCutPoint,
	getLastAssistantUsage,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { BtwTurn } from "./btw.js";

// ---------------------------------------------------------------------------
// Budget constants — the engine's tuning surface. Defined in this leaf module so
// the btw.ts ↔ btw-budget.ts dependency is type-only at runtime (btw.ts re-exports
// them for the package's public surface).
// ---------------------------------------------------------------------------
export const BTW_HISTORY_TOKEN_BUDGET = 8192; // cap /btw history (newest-suffix of BtwTurn[])
export const BTW_CONTEXT_RESERVE = 16384; // matches host DEFAULT_COMPACTION_SETTINGS.reserveTokens
export const BTW_NO_ANCHOR_SAFETY_FACTOR = 1.2; // no-anchor fallback overcount, applied HERE (host does not)

/**
 * Result of {@link capHistory}: the newest suffix of `/btw` turns admitted into
 * a fresh side-call context, plus accounting surfaced to the trim-notice overlay.
 */
export interface CappedHistory {
	/** Newest-suffix turns, reference-identical to the input `history` elements. */
	admitted: BtwTurn[];
	/** Sum of `estimateTokens` over BOTH messages of every admitted turn (chars/4 each). */
	estimate: number;
	/** Older turns dropped to stay within `budget` (=== `history.length - admitted.length`). */
	droppedTurns: number;
}

/**
 * Pure maximal-suffix walk over `/btw` history.
 *
 * Admits the MAXIMAL newest suffix of whole turns (user+assistant, atomic) whose
 * summed `estimateTokens` cost is `≤ budget`. Newer turns are never sacrificed
 * to admit older ones: the walk extends greedily from the newest backward, and
 * the first older turn that would overflow breaks it.
 *
 * Floor guarantee: `history.length >= 1` ⇒ `admitted.length >= 1`. If the newest
 * turn ALONE exceeds `budget`, it is still admitted (a side call carries no
 * history otherwise) and `estimate` carries its over-budget actual cost — never
 * clamped to the budget.
 *
 * `admitted` is `history.slice(k)`: reference-identical elements, no copy/mutate.
 * The caller (the build step) owns reading the session history; this function
 * touches no `ExtensionContext`/`globalThis`/`getSessionHistory`.
 */
export function capHistory(history: BtwTurn[], budget = BTW_HISTORY_TOKEN_BUDGET): CappedHistory {
	if (history.length === 0) return { admitted: [], estimate: 0, droppedTurns: 0 };

	// Seed with the newest turn — this IS the floor guarantee: even an over-budget
	// newest turn is admitted (estimate unclamped) so the side call always carries it.
	let estimate =
		estimateTokens(history[history.length - 1].userMessage) +
		estimateTokens(history[history.length - 1].assistantMessage);
	let k = history.length - 1;

	// Greedily extend backward over older turns while the running sum stays within budget.
	// All turns have positive cost, so the first overflow breaks the maximal suffix.
	for (let i = history.length - 2; i >= 0; i--) {
		const cost = estimateTokens(history[i].userMessage) + estimateTokens(history[i].assistantMessage);
		if (estimate + cost > budget) break;
		estimate += cost;
		k = i;
	}

	return {
		admitted: history.slice(k),
		estimate,
		droppedTurns: k,
	};
}

// ---------------------------------------------------------------------------
// Branch-fit engine — pure; no ctx/globalThis access.
// Value-imports the six host primitives (no re-implementation). Deliberately does
// NOT reuse the host's backward findTurnStartIndex for the forward turn-start scan
// (the host scans backward for compaction's summarize-prefix model; /btw cannot
// summarize, so it drops the prefix and keeps a suffix that opens on a turn-start).
// ---------------------------------------------------------------------------

export interface FitBranchInput {
	/** The main agent's context entries from the snapshot (compaction summary + kept +
	 *  newer; findCutPoint/getLastAssistantUsage contract). */
	entries: SessionEntry[];
	/** Cached main-agent context messages (`branchToContextMessages`) — the same context
	 *  the usage anchor measured. Returned by reference on the fast path (byte-identical prefix). */
	messages: Message[];
	model: Model<Api>;
	systemPrompt: string;
	question: UserMessage;
	/** capHistory estimate over admitted /btw turns (subtracted from the window). */
	admittedEstimate: number;
	/** Retry override: when set, skip the window formula and trim/stub to this
	 *  many branch tokens directly; the cached snapshot is NOT re-read. */
	keepBudget?: number;
}

export interface FitBranchResult {
	messages: Message[];
	branchWasTrimmed: boolean;
	stubbed: boolean;
	/** Budget fitBranch applied: window-computed on the default path, the passed-in
	 *  override on the retry path. Populated on BOTH paths so buildBtwMessages surfaces
	 *  it for the overflow-retry caller's Math.floor(built.keepBudget / 2). */
	keepBudget: number;
}

// Stub/truncation literals (research-grounded). BTW_STUB_TEXT is exported for the
// stub-content test assertion; BTW_TRUNCATE_MARKER_FMT stays private (test asserts the marker substring).
export const BTW_STUB_TEXT = "[tool result elided by /btw to fit the context window]";
const BTW_TRUNCATE_MARKER_FMT = (truncatedChars: number): string => `[... ${truncatedChars} characters truncated]`;

// Turn-start discriminator (message-level, NOT the host's entry-level isTurnStartEntry
// which excludes compaction). branchSummary/compactionSummary are included so a head
// compaction/branch summary can open the kept suffix after a cut (hybrid filter).
const TURN_START_ROLES: ReadonlySet<string> = new Set([
	"user",
	"bashExecution",
	"custom",
	"branchSummary",
	"compactionSummary",
]);

/** chars/4 heuristic mirror of estimateTokens for the system-prompt STRING (estimateTokens
 *  takes a message, not a raw string). Math.ceil matches the host's conservative direction. */
function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Skip guard: the window is usable only when the reserve fits. */
function isBudgetable(model: Model<Api>): boolean {
	return model.contextWindow > 0 && model.contextWindow > model.maxTokens + BTW_CONTEXT_RESERVE;
}

/** Sum estimateTokens over an LLM message array (real host primitive, chars/4 per message). */
function estimateMessagesTokens(messages: Message[]): number {
	let sum = 0;
	for (const m of messages) sum += estimateTokens(m);
	return sum;
}

/** Branch-usage estimate. Anchor = getLastAssistantUsage → calculateContextTokens
 *  (safe overcount: includes the main agent's system/tools that /btw omits) PLUS
 *  estimateTokens over every context message from entries AFTER the anchor — turns the
 *  provider has not metered (the user's latest turn, tool traffic behind an
 *  aborted/error assistant) still occupy the window and must count toward it.
 *  No anchor → sum(estimateTokens) × BTW_NO_ANCHOR_SAFETY_FACTOR (host applies no factor;
 *  btw-budget applies 1.2 itself). */
function estimateBranchTokens(entries: SessionEntry[]): number {
	const usage = getLastAssistantUsage(entries);
	if (usage) {
		// Locate the anchor entry by Usage-object identity: getLastAssistantUsage returns
		// the stored reference, so identity finds the anchor without re-implementing the
		// host's validity predicate (skip aborted/error/all-zero). Walk newest-first,
		// summing estimates until the anchor — those are exactly the post-anchor entries.
		let tail = 0;
		let anchorFound = false;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "message" && e.message.role === "assistant" && e.message.usage === usage) {
				anchorFound = true;
				break;
			}
			for (const m of sessionEntryToContextMessages(e)) tail += estimateTokens(m);
		}
		// Identity miss (a host returning a derived Usage object) would have made `tail`
		// span the whole branch and double-count the anchored prefix — drop it instead.
		return calculateContextTokens(usage) + (anchorFound ? tail : 0);
	}
	// No-anchor fallback: sum estimateTokens over every context-visible AgentMessage the
	// entries produce (estimateTokens accepts AgentMessage, so no cast is needed), × 1.2.
	let sum = 0;
	for (const e of entries) {
		for (const m of sessionEntryToContextMessages(e)) sum += estimateTokens(m);
	}
	return Math.ceil(sum * BTW_NO_ANCHOR_SAFETY_FACTOR);
}

/** Turn-start test on a raw entry, via the exported message conversion (message-level
 *  discriminator — includes compaction/branch summaries). */
function isTurnStartEntry(entry: SessionEntry): boolean {
	return sessionEntryToContextMessages(entry).some((m) => TURN_START_ROLES.has(m.role));
}

/** Forward scan from `fromIndex` to the first turn-start entry at or after it. Returns
 *  the index, or -1 if none exists (caller falls back to stubbing). Scanning forward
 *  past a mid-turn assistant also skips its trailing toolResults → atomicity:
 *  no toolCall without its toolResult and vice versa. */
function forwardScanToTurnStart(entries: SessionEntry[], fromIndex: number): number {
	for (let i = fromIndex; i < entries.length; i++) {
		if (isTurnStartEntry(entries[i])) return i;
	}
	return -1;
}

/** Trim: findCutPoint over RAW entries (its contract), then a FORWARD scan to a
 *  turn-start (NOT the host's backward findTurnStartIndex), then unfiltered conversion so
 *  a head compaction/branch summary survives (hybrid filter). Returns {messages:null} when
 *  no valid cut (firstKeptEntryIndex<=0) or no turn-start exists — caller stubs the full cache. */
function trimBranch(entries: SessionEntry[], keepRecentTokens: number): { messages: Message[] | null } {
	const cut = findCutPoint(entries, 0, entries.length, keepRecentTokens);
	if (cut.firstKeptEntryIndex <= 0) return { messages: null }; // no valid cut → stub the cache
	const startIdx = forwardScanToTurnStart(entries, cut.firstKeptEntryIndex);
	if (startIdx < 0) return { messages: null }; // no turn-start in the kept suffix → stub the cache
	const keptEntries = entries.slice(startIdx);
	// After a cut, convert entry by entry (UNFILTERED sessionEntryToContextMessages) so a
	// head compaction/branch summary survives, matching the main agent's post-compact
	// context. Pi >= 1.0 context edits are not re-applied to the kept suffix; what is sent
	// is exactly what is estimated, so the budget still holds.
	const trimmed = convertToLlm(keptEntries.flatMap((e) => sessionEntryToContextMessages(e)));
	return { messages: trimmed };
}

/** Phase 1 of {@link stubToFit}: oldest-first toolResult stubbing. Operates in-place
 *  on `result` (does NOT copy) — re-estimates before each slot via the termination guard
 *  and replaces over-budget `msg.role === "toolResult"` slots with the placeholder,
 *  preserving toolCallId/toolName/isError via spread (the paired ToolCall in the prior
 *  assistant stays). Returns `true` iff at least one slot was stubbed. */
function stubToolResultsToFit(result: Message[], budget: number): boolean {
	let stubbed = false;
	// Stub toolResult content oldest-first with the placeholder (preserves
	// toolCallId/toolName/isError via spread; the paired ToolCall in the prior assistant stays).
	for (let i = 0; i < result.length; i++) {
		if (estimateMessagesTokens(result) <= budget) break;
		const msg = result[i];
		if (msg.role === "toolResult") {
			result[i] = { ...msg, content: [{ type: "text", text: BTW_STUB_TEXT }] };
			stubbed = true;
		}
	}
	return stubbed;
}

/** Phase 2 of {@link stubToFit}: terminal truncation toward the token gap. Operates in-place
 *  on `result` (does NOT copy). One block per iteration, re-estimated each pass; a pass that
 *  fails to shrink the estimate breaks the loop — the truncation marker keeps every rewritten
 *  block at a floor length, so a budget below that floor (e.g. negative) would otherwise
 *  rewrite the same block forever; `priorEstimate` is seeded at +∞ so the first pass always
 *  proceeds. Returns `true` iff at least one block was truncated. */
function truncateToFit(result: Message[], budget: number): boolean {
	let stubbed = false;
	// Terminal fallback: truncate the largest text block toward the token gap
	// (chars ≈ tokens×4, the inverse of estimateTokens' chars/4) with a marker. One block per
	// iteration; re-estimate each pass. A pass that fails to shrink the estimate breaks the
	// loop: the truncation marker keeps every rewritten block at a floor length, so a budget
	// below that floor (e.g. negative) would otherwise rewrite the same block forever.
	let priorEstimate = Number.POSITIVE_INFINITY;
	while (estimateMessagesTokens(result) > budget) {
		const estimate = estimateMessagesTokens(result);
		if (estimate >= priorEstimate) break; // no progress — budget below the marker floor
		priorEstimate = estimate;
		const overTokens = estimate - budget;
		const removeChars = Math.max(1, Math.ceil(overTokens * 4));

		// Locate the largest text content block (string content OR a {type:"text"} part).
		let target = { mi: -1, ci: -1, len: 0, isString: false };
		for (let i = 0; i < result.length; i++) {
			const content = result[i].content;
			if (typeof content === "string") {
				if (content.length > target.len) target = { mi: i, ci: -1, len: content.length, isString: true };
				continue;
			}
			if (Array.isArray(content)) {
				for (let j = 0; j < content.length; j++) {
					const part = content[j];
					if (part && part.type === "text" && part.text.length > target.len) {
						target = { mi: i, ci: j, len: part.text.length, isString: false };
					}
				}
			}
		}
		if (target.mi < 0 || target.len === 0) break; // nothing left to truncate — minimal result

		// Reserve room for the marker itself so the rewritten block lands at ~(len - removeChars)
		// chars total; without this the marker's own length leaks back into the estimate.
		const markerReserve = BTW_TRUNCATE_MARKER_FMT(removeChars).length;
		const keepChars = Math.max(0, target.len - removeChars - markerReserve);
		const truncatedChars = target.len - keepChars;
		const marker = BTW_TRUNCATE_MARKER_FMT(truncatedChars);
		const msg = result[target.mi];
		// Rebuild with role narrowing so each spread yields a valid Message variant
		// (Message is a discriminated union — spreading the union and overriding `content`
		// directly does not typecheck). Top-level branches are pure msg.role checks so
		// narrowing flows into each arm; the user arm narrows string-vs-array content.
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				result[target.mi] = { ...msg, content: `${msg.content.slice(0, keepChars)}${marker}` };
			} else {
				const content = [...msg.content];
				const part = content[target.ci];
				if (part.type === "text") {
					content[target.ci] = { ...part, text: `${part.text.slice(0, keepChars)}${marker}` };
					result[target.mi] = { ...msg, content };
				}
			}
		} else if (msg.role === "system") {
			// Pi ≥ 1.1 passes system messages through convertToLlm; content is a string or text parts.
			if (typeof msg.content === "string") {
				result[target.mi] = { ...msg, content: `${msg.content.slice(0, keepChars)}${marker}` };
			} else {
				const content = [...msg.content];
				const part = content[target.ci];
				content[target.ci] = { ...part, text: `${part.text.slice(0, keepChars)}${marker}` };
				result[target.mi] = { ...msg, content };
			}
		} else if (msg.role === "assistant") {
			const content = [...msg.content];
			const part = content[target.ci];
			if (part.type === "text") {
				content[target.ci] = { ...part, text: `${part.text.slice(0, keepChars)}${marker}` };
				result[target.mi] = { ...msg, content };
			}
		} else {
			// toolResult (msg narrowed to ToolResultMessage)
			const content = [...msg.content];
			const part = content[target.ci];
			if (part.type === "text") {
				content[target.ci] = { ...part, text: `${part.text.slice(0, keepChars)}${marker}` };
				result[target.mi] = { ...msg, content };
			}
		}
		stubbed = true;
	}
	return stubbed;
}

/** Oversized-turn stubbing + terminal truncation. Operates on a SHALLOW copy
 *  (`messages.slice()`) — the copy lives HERE, in one place, and guards both phases —
 *  and replaces slots via object spread so the cached snapshot's array AND its message
 *  objects are never mutated. Phase 1 ({@link stubToolResultsToFit}) stubs toolResults
 *  oldest-first; phase 2 ({@link truncateToFit}) truncates the largest text block toward
 *  the token gap. Signature and return shape are unchanged. */
function stubToFit(messages: Message[], budget: number): { messages: Message[]; stubbed: boolean } {
	const result = messages.slice(); // shallow: new array, shared message objects — one place, guards both phases
	const stubbedTool = stubToolResultsToFit(result, budget);
	const stubbedTruncated = truncateToFit(result, budget);
	return { messages: result, stubbed: stubbedTool || stubbedTruncated };
}

/** Orchestrating pure branch-fit. Fast path returns the cached `messages` by reference
 *  (byte-identical prefix). Otherwise forward-scan trim, then stub/truncate. `keepBudget`
 *  is populated on every path. */
export function fitBranch(input: FitBranchInput): FitBranchResult {
	const { entries, messages, model, systemPrompt, question, admittedEstimate } = input;

	// --- Budget resolution ---
	let branchKeepBudget: number;
	if (input.keepBudget !== undefined) {
		// Retry path: skip the window formula AND the skip guard; trim/stub
		// directly to this many branch tokens. The cached snapshot is not re-read.
		branchKeepBudget = input.keepBudget;
	} else {
		const available = model.contextWindow - model.maxTokens - BTW_CONTEXT_RESERVE;
		const windowBudget = available - estimateTextTokens(systemPrompt) - estimateTokens(question) - admittedEstimate;
		if (!isBudgetable(model)) {
			// Skip guard: window unusable → fast-path the cached messages, no trim.
			// keepBudget is still populated (the window-derived value, possibly negative on an
			// unusable window) so the caller's read never sees undefined — see Notes / Deferred.
			return { messages, branchWasTrimmed: false, stubbed: false, keepBudget: windowBudget };
		}
		branchKeepBudget = windowBudget;
	}

	// --- Fast path: branch fits → return cached messages by reference (byte-identical prefix) ---
	const branchUsage = estimateBranchTokens(entries);
	if (branchUsage <= branchKeepBudget) {
		return { messages, branchWasTrimmed: false, stubbed: false, keepBudget: branchKeepBudget };
	}

	// --- Forward-scan trim ---
	const trim = trimBranch(entries, branchKeepBudget);
	if (trim.messages) {
		// Trimmed suffix fits → done (trimmed only).
		if (estimateMessagesTokens(trim.messages) <= branchKeepBudget) {
			return { messages: trim.messages, branchWasTrimmed: true, stubbed: false, keepBudget: branchKeepBudget };
		}
		// Still over after trimming → stub the TRIMMED suffix (branchWasTrimmed stays true).
		const stubbed = stubToFit(trim.messages, branchKeepBudget);
		return {
			messages: stubbed.messages,
			branchWasTrimmed: true,
			stubbed: stubbed.stubbed,
			keepBudget: branchKeepBudget,
		};
	}

	// --- No-cut-possible fallback: no valid cut or no turn-start → stub the full
	//     cached messages (branchWasTrimmed FALSE — findCutPoint found nothing to cut).
	//     When stubbing changed nothing (anchor-metered usage over budget but the raw
	//     estimates already fit), return the ORIGINAL cached array — best effort, and
	//     the reference-parity guarantee holds. ---
	const stubbed = stubToFit(messages, branchKeepBudget);
	return {
		messages: stubbed.stubbed ? stubbed.messages : messages,
		branchWasTrimmed: false,
		stubbed: stubbed.stubbed,
		keepBudget: branchKeepBudget,
	};
}
