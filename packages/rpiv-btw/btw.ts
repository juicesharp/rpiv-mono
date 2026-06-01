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
import {
	type AssistantMessage,
	completeSimple,
	type Message,
	type StopReason,
	type UserMessage,
} from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { showBtwOverlay } from "./btw-ui.js";

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Real messages — no fabrication. userMessage is built at call time; assistantMessage
// is the unmodified completeSimple response. Stable object references across calls →
// byte-identical prompt prefix on subsequent /btw invocations (cache parity).
export interface BtwTurn {
	userMessage: UserMessage;
	assistantMessage: AssistantMessage;
}

interface BtwState {
	histories: Map<string, BtwTurn[]>;
	snapshots: Map<string, { messages: Message[] }>;
}

function branchToMessages(branch: SessionEntry[]): Message[] {
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

function getSnapshot(ctx: ExtensionContext): { messages: Message[] } | undefined {
	return getState().snapshots.get(getSessionFile(ctx));
}

function setSnapshot(ctx: ExtensionContext, snapshot: { messages: Message[] }): void {
	getState().snapshots.set(getSessionFile(ctx), snapshot);
}

export function invalidateSnapshot(ctx: ExtensionContext): void {
	getState().snapshots.delete(getSessionFile(ctx));
}

// Extract text from a UserMessage's content.
export function userMessageText(msg: UserMessage): string {
	if (typeof msg.content === "string") return msg.content;
	return msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

// Extract text from an AssistantMessage's content (text parts only).
export function assistantMessageText(msg: AssistantMessage): string {
	return msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
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
	| { ok: true; answer: string; userMessage: UserMessage; assistantMessage: AssistantMessage; stopReason: StopReason }
	| { ok: false; error: string; stopReason?: StopReason }
	| { ok: false; aborted: true; stopReason: StopReason };

function readBranchMessages(ctx: ExtensionContext): Message[] {
	const cached = getSnapshot(ctx);
	if (cached) return cached.messages;
	// Cold start (no message_end fired yet) — fall back to live read
	const branch = ctx.sessionManager.getBranch() as SessionEntry[];
	return branchToMessages(branch);
}

function buildBtwMessages(ctx: ExtensionContext, userMessage: UserMessage): Message[] {
	const branchMessages = readBranchMessages(ctx);
	const history = getSessionHistory(ctx);
	// Reusing stored real UserMessage/AssistantMessage object references across calls
	// preserves byte-identical prompt prefix (cache parity).
	const historyMessages: Message[] = history.flatMap((h) => [h.userMessage, h.assistantMessage]);
	return [...branchMessages, ...historyMessages, userMessage];
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
		return { ok: false, error: MSG_NO_MODEL };
	}
	const modelLabel = `${model.provider}:${model.id}`;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { ok: false, error: errMisconfigured(modelLabel, auth.error) };
	}
	if (!auth.apiKey) {
		return { ok: false, error: errNoApiKey(modelLabel) };
	}

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: question }],
		timestamp: Date.now(),
	};
	const messages = buildBtwMessages(ctx, userMessage);
	const systemPrompt = buildSystemPrompt();

	try {
		const response = await completeSimple(
			model,
			{ systemPrompt, messages, tools: [] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: controller.signal, // own AbortController, NOT ctx.signal (Decision 8)
			},
		);

		if (response.stopReason === "aborted") {
			return { ok: false, aborted: true, stopReason: response.stopReason };
		}
		if (response.stopReason === "error") {
			return {
				ok: false,
				error: errCallFailed(response.errorMessage),
				stopReason: response.stopReason,
			};
		}

		const answerText = assistantMessageText(response).trim();
		if (!answerText) {
			return { ok: false, error: ERR_EMPTY_RESPONSE, stopReason: response.stopReason };
		}

		return {
			ok: true,
			answer: answerText,
			userMessage,
			assistantMessage: response,
			stopReason: response.stopReason,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (controller.signal.aborted) {
			return { ok: false, aborted: true, stopReason: "aborted" as const };
		}
		return { ok: false, error: errCallThrew(message) };
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
		setSnapshot(ctx, { messages: branchToMessages(branch) });
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

	if (result.ok) {
		overlayCtl.setAnswer(result.answer);
		pushSessionTurn(ctx, {
			userMessage: result.userMessage,
			assistantMessage: result.assistantMessage,
		});
		// No disk persistence — process-scoped only (Decision 4)
	} else if ("aborted" in result) {
		// User Esc'd — overlay already dismissed via done(); no further action
	} else {
		overlayCtl.setError(result.error);
	}

	await overlayPromise;
}
