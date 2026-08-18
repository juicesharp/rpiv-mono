/**
 * @juicesharp/rpiv-btw — /btw side-question slash command.
 *
 * Asks the same primary model a one-off side question using the cloned primary
 * conversation as context. Answer is rendered ephemerally in a bottom-slot
 * overlay (never enters main agent's messages). History persists per-session-file
 * via globalThis-keyed storage; process-scoped only (no disk persistence).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Message, StopReason, UserMessage } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type CappedHistory, capHistory, type FitBranchResult, fitBranch } from "./btw-budget.js";
import { assistantMessageText, type BtwTurn, userMessageText } from "./btw-messages.js";
import { showBtwOverlay } from "./btw-ui.js";
import { getRuntimeCompleteSimple, loadCompleteSimple, loadIsContextOverflow } from "./pi-compat.js";

// ---------------------------------------------------------------------------
// Constants — flat named consts, grouped by concern (advisor pattern, b9428e9)
// ---------------------------------------------------------------------------

// Identity
export const BTW_COMMAND_NAME = "btw";

// Storage — globalThis-keyed survives module re-import on /new, /fork, /resume.
// Lost on Pi process exit (intentional — no disk persistence).
export const BTW_STATE_KEY = Symbol.for("rpiv-btw");

// Cross-session pattern hint: how many recent question-strings to inject
export const CROSS_SESSION_HINT_LIMIT = 10;

// Messages (static)
const MSG_REQUIRES_INTERACTIVE = "/btw requires interactive mode";
const MSG_USAGE = "Usage: /btw <question>";
const MSG_NO_MODEL = "/btw requires an active model";

// Errors (static)
const ERR_EMPTY_RESPONSE = "/btw returned no text content.";

// Errors (parameterized)
const errMisconfigured = (label: string, err: string) => `/btw model (${label}) is misconfigured: ${err}`;
const errNoApiKey = (label: string) => `/btw model (${label}) has no API key available.`;
const errCallFailed = (err: string | undefined) => `/btw call failed: ${err ?? "unknown error"}`;
const errCallThrew = (msg: string) => `/btw call threw: ${msg}`;

// Budget (context-budgeting) constants — defined in btw-budget.ts (the leaf budget
// module; keeps the module cycle type-only at runtime), re-exported here so the
// package surface is unchanged.
export { BTW_CONTEXT_RESERVE, BTW_HISTORY_TOKEN_BUDGET, BTW_NO_ANCHOR_SAFETY_FACTOR } from "./btw-budget.js";
// BtwTurn + the message-text extractors live in the cycle-break leaf
// (packages/rpiv-btw/btw-messages.ts); re-exported here so the package surface is
// unchanged (packages/rpiv-btw/btw.test.ts / btw-ui.test.ts / btw-budget.test.ts still
// import them from "./btw.js"). Import-then-re-export (not `export … from`) because
// btw.ts consumes all three internally (userMessageText at :166,
// assistantMessageText at :341, BtwTurn in BtwState/getSessionHistory/pushSessionTurn).
export { assistantMessageText, type BtwTurn, userMessageText };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BtwState {
	histories: Map<string, BtwTurn[]>;
	snapshots: Map<string, { messages: Message[]; entries: SessionEntry[] }>;
}

export function branchToMessages(branch: SessionEntry[]): Message[] {
	const agentMessages = branch
		.filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
		.map((e) => e.message);
	return convertToLlm(agentMessages);
}

// ---------------------------------------------------------------------------
// System prompt — loaded once at module init from prompts/btw-system.txt
// ---------------------------------------------------------------------------

export const BTW_SYSTEM_PROMPT = readFileSync(
	fileURLToPath(new URL("./prompts/btw-system.txt", import.meta.url)),
	"utf-8",
).trimEnd();

// ---------------------------------------------------------------------------
// Storage — globalThis-keyed, survives module re-import on /new, /fork, /resume.
// Standard Node.js `globalThis + Symbol.for()` idiom for cross-import-graph
// singleton state (used by OpenTelemetry, etc.); lost on process exit.
// ---------------------------------------------------------------------------

function getState(): BtwState {
	const g = globalThis as unknown as { [k: symbol]: BtwState | undefined };
	let state = g[BTW_STATE_KEY];
	if (!state) {
		state = {
			histories: new Map(),
			snapshots: new Map(),
		};
		g[BTW_STATE_KEY] = state;
	}
	return state;
}

function getSessionFile(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? `memory:${ctx.sessionManager.getSessionId()}`;
}

function getSessionHistory(ctx: ExtensionContext): BtwTurn[] {
	const key = getSessionFile(ctx);
	const state = getState();
	let turns = state.histories.get(key);
	if (!turns) {
		turns = [];
		state.histories.set(key, turns);
	}
	return turns;
}

function pushSessionTurn(ctx: ExtensionContext, turn: BtwTurn): void {
	getSessionHistory(ctx).push(turn);
}

export function clearSessionHistory(ctx: ExtensionContext): void {
	getState().histories.set(getSessionFile(ctx), []);
}

function getSnapshot(ctx: ExtensionContext): { messages: Message[]; entries: SessionEntry[] } | undefined {
	return getState().snapshots.get(getSessionFile(ctx));
}

function setSnapshot(ctx: ExtensionContext, snapshot: { messages: Message[]; entries: SessionEntry[] }): void {
	getState().snapshots.set(getSessionFile(ctx), snapshot);
}

export function invalidateSnapshot(ctx: ExtensionContext): void {
	getState().snapshots.delete(getSessionFile(ctx));
}

// Cross-session pattern hint — last N question-strings across ALL sessions.
function getCrossSessionHint(): string {
	const allTurns: { q: string; ts: number }[] = [];
	for (const turns of getState().histories.values()) {
		for (const t of turns) {
			allTurns.push({ q: userMessageText(t.userMessage), ts: t.userMessage.timestamp });
		}
	}
	if (allTurns.length === 0) return "";
	const recent = allTurns.sort((a, b) => a.ts - b.ts).slice(-CROSS_SESSION_HINT_LIMIT);
	const lines = recent.map((t, i) => `${i + 1}. ${t.q.replace(/\s+/g, " ").slice(0, 200)}`);
	return `\n\n## Recent /btw questions across sessions (oldest first)\n\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Executor — auth, message threading, completeSimple, four StopReason branches
// Modeled after rpiv-advisor/advisor.ts:225-336
// ---------------------------------------------------------------------------

export type BtwExecResult =
	| {
			kind: "success";
			answer: string;
			userMessage: UserMessage;
			assistantMessage: AssistantMessage;
			stopReason: StopReason;
			trimmed?: boolean;
	  }
	| { kind: "error"; error: string; stopReason?: StopReason }
	| { kind: "aborted"; stopReason: StopReason };

function readBranchSnapshot(ctx: ExtensionContext): { messages: Message[]; entries: SessionEntry[] } {
	const cached = getSnapshot(ctx);
	if (cached) return cached;
	// Cold start (no message_end fired yet) — fall back to a single live read.
	const branch = ctx.sessionManager.getBranch() as SessionEntry[];
	return { messages: branchToMessages(branch), entries: branch };
}

export interface BtwBuiltContext {
	messages: Message[];
	systemPrompt: string;
	droppedTurns: number;
	branchWasTrimmed: boolean;
	stubbed: boolean;
	keepBudget: number; // halved by the overflow-retry caller to tighten the branch budget
}

export function buildBtwMessages(
	ctx: ExtensionContext,
	userMessage: UserMessage,
	keepBudget?: number,
): BtwBuiltContext {
	// ctx.model is non-null here — executeBtw returns early on !model before calling.
	const model = ctx.model!;
	const history = getSessionHistory(ctx);
	const { messages, entries } = readBranchSnapshot(ctx);
	const systemPrompt = buildSystemPrompt();
	const fitInput = { entries, messages, model, systemPrompt, question: userMessage };

	let capped: CappedHistory;
	let fit: FitBranchResult;
	if (keepBudget === undefined) {
		// Fast-path parity: attempt the FULL history first (an Infinity budget admits
		// every turn) — when the whole request fits the window, the build is
		// byte-identical to the pre-budgeting assembly and the history cap never engages.
		capped = capHistory(history, Number.POSITIVE_INFINITY);
		fit = fitBranch({ ...fitInput, admittedEstimate: capped.estimate });
		if (fit.branchWasTrimmed || fit.stubbed) {
			// Over budget with full history → apply the history cap BEFORE branch
			// trimming, then re-fit the branch against the freed window. When the cap
			// drops nothing the inputs are identical — keep the first fit.
			const recapped = capHistory(history);
			if (recapped.droppedTurns > 0) {
				capped = recapped;
				fit = fitBranch({ ...fitInput, admittedEstimate: recapped.estimate });
			}
		}
	} else {
		// Overflow retry: the sent request has already proven too large — take the
		// capped history and trim/stub the branch straight to the halved budget.
		capped = capHistory(history);
		fit = fitBranch({ ...fitInput, admittedEstimate: capped.estimate, keepBudget });
	}
	const assembled: Message[] = [
		...fit.messages,
		...capped.admitted.flatMap((t) => [t.userMessage, t.assistantMessage]),
		userMessage,
	];
	return {
		messages: assembled,
		systemPrompt,
		droppedTurns: capped.droppedTurns,
		branchWasTrimmed: fit.branchWasTrimmed,
		stubbed: fit.stubbed,
		keepBudget: fit.keepBudget,
	};
}

function buildSystemPrompt(): string {
	return BTW_SYSTEM_PROMPT + getCrossSessionHint();
}

export async function executeBtw(
	question: string,
	ctx: ExtensionContext,
	controller: AbortController,
): Promise<BtwExecResult> {
	const model = ctx.model;
	if (!model) {
		return { kind: "error", error: MSG_NO_MODEL };
	}
	const modelLabel = `${model.provider}:${model.id}`;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { kind: "error", error: errMisconfigured(modelLabel, auth.error) };
	}
	// OAuth-backed providers resolve `{ ok: true }` with no literal apiKey — their
	// credentials are applied inside Pi's runtime facade. A missing key is only
	// fatal on legacy hosts without that facade, where the global completion
	// fallback needs the key passed explicitly.
	const runtimeCompleteSimple = getRuntimeCompleteSimple(ctx.modelRegistry);
	if (!auth.apiKey && !runtimeCompleteSimple) {
		return { kind: "error", error: errNoApiKey(modelLabel) };
	}

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: question }],
		timestamp: Date.now(),
	};
	// `let` because the overflow retry reassigns `built` with a halved budget;
	// buildBtwMessages returns BtwBuiltContext { messages, systemPrompt,
	// droppedTurns, branchWasTrimmed, stubbed, keepBudget }.
	let built = buildBtwMessages(ctx, userMessage);

	try {
		// Prefer Pi's auth-aware runtime facade (resolved once above, before the
		// missing-key guard). Unlike the global compatibility function, it runs
		// request preparation and applies credential-derived fields — OAuth
		// tokens, GitHub Copilot's OAuth-specific baseUrl. Do not pass the
		// preflight key/headers to that path: explicit overrides would bypass
		// that resolution.
		const completeSimple = runtimeCompleteSimple ?? (await loadCompleteSimple());
		const requestOptions = runtimeCompleteSimple
			? { signal: controller.signal } // own AbortController, NOT ctx.signal (Decision 8)
			: { apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal };
		const overflowFn = await loadIsContextOverflow();
		let retried = false;
		const callCompleteSimple = async (
			built: BtwBuiltContext,
		): Promise<{ kind: "aborted"; stopReason: StopReason } | { kind: "completed"; response: AssistantMessage }> => {
			const response = await completeSimple(
				model,
				{ systemPrompt: built.systemPrompt, messages: built.messages, tools: [] },
				requestOptions,
			);
			if (response.stopReason === "aborted") {
				return { kind: "aborted", stopReason: response.stopReason };
			}
			return { kind: "completed", response };
		};
		let outcome = await callCompleteSimple(built);
		if (outcome.kind === "aborted") return outcome;
		let response = outcome.response;
		// Overflow gate — exactly one retry. On the first response the host flags
		// as context overflow (any stopReason), rebuild the branch context with a
		// halved keepBudget and re-call once. A flag bounds it to one retry; the
		// recall's throw and the loader's rethrow both land in the surrounding
		// catch. /btw's fresh side call retries all three overflow stopReasons
		// (error/stop/length), a deliberate divergence from the host's
		// stopReason-based willRetry.
		if (overflowFn && !retried && overflowFn(response, model.contextWindow)) {
			retried = true;
			built = buildBtwMessages(ctx, userMessage, Math.floor(built.keepBudget / 2));
			outcome = await callCompleteSimple(built);
			if (outcome.kind === "aborted") return outcome;
			response = outcome.response;
		}
		if (response.stopReason === "error") {
			return {
				kind: "error",
				error: errCallFailed(response.errorMessage),
				stopReason: response.stopReason,
			};
		}

		const answerText = assistantMessageText(response).trim();
		if (!answerText) {
			return { kind: "error", error: ERR_EMPTY_RESPONSE, stopReason: response.stopReason };
		}

		return {
			kind: "success",
			answer: answerText,
			userMessage,
			assistantMessage: response,
			stopReason: response.stopReason,
			trimmed: built.droppedTurns > 0 || built.branchWasTrimmed || built.stubbed,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (controller.signal.aborted) {
			return { kind: "aborted", stopReason: "aborted" as const };
		}
		return { kind: "error", error: errCallThrew(message) };
	}
}

// ---------------------------------------------------------------------------
// Registrars — 3 hooks total: command + message_end snapshot + compact/tree invalidate
// ---------------------------------------------------------------------------

export function registerMessageEndSnapshot(pi: ExtensionAPI): void {
	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		if ((msg as AssistantMessage).stopReason === "toolUse") return;
		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		setSnapshot(ctx, { messages: branchToMessages(branch), entries: branch });
	});
}

export function registerInvalidationHooks(pi: ExtensionAPI): void {
	pi.on("session_compact", async (_e, ctx) => safeInvalidateSnapshot(ctx));
	pi.on("session_tree", async (_e, ctx) => safeInvalidateSnapshot(ctx));
}

// Auto-compaction races session disposal: pi-core invalidates the extension
// runner while still emitting session_compact, so `ctx` may be a dead proxy
// whose getters throw the stale error. The compacting session is being
// discarded — there is no snapshot worth invalidating — so swallow only the
// stale error. Any other error is a real bug and must propagate.
function safeInvalidateSnapshot(ctx: ExtensionContext): void {
	try {
		invalidateSnapshot(ctx);
	} catch (e) {
		if (!isStaleCtxError(e)) throw e;
	}
}

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

export function registerBtwCommand(pi: ExtensionAPI): void {
	pi.registerCommand(BTW_COMMAND_NAME, {
		description: "Ask a side question without polluting the main conversation",
		handler: (args: string, ctx: ExtensionCommandContext) => handleBtwCommand(pi, args, ctx),
	});
}

async function handleBtwCommand(_pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
		return;
	}
	const question = args.trim();
	if (!question) {
		ctx.ui.notify(MSG_USAGE, "warning");
		return;
	}
	if (!ctx.model) {
		ctx.ui.notify(MSG_NO_MODEL, "error");
		return;
	}

	const controller = new AbortController();
	const historySnapshot = [...getSessionHistory(ctx)];

	const { overlayPromise, controllerReady } = showBtwOverlay({
		ctx,
		question,
		history: historySnapshot,
		controller,
		onClearHistory: () => clearSessionHistory(ctx),
	});

	const overlayCtl = await controllerReady;
	const result = await executeBtw(question, ctx, controller);

	switch (result.kind) {
		case "success": {
			overlayCtl.setAnswer(result.answer);
			if (result.trimmed) overlayCtl.setTrimmed(); // success-only: TS narrows result here
			pushSessionTurn(ctx, {
				userMessage: result.userMessage,
				assistantMessage: result.assistantMessage,
			});
			// No disk persistence — process-scoped only (Decision 4)
			break;
		}
		case "aborted": {
			// User Esc'd — overlay already dismissed via done(); no further action
			break;
		}
		case "error": {
			overlayCtl.setError(result.error);
			break;
		}
	}

	await overlayPromise;
}
