/**
 * execute — the advisor side-call. Curates the executor's branch (inventory
 * prefix + tail massaging), invokes the advisor model via completeSimple with
 * no tools, and returns a structured tool result. Every result branch (success
 * / abort / error / empty) and the pre-call error paths funnel through
 * buildAdvisorResult so the envelope is built in exactly one place.
 */

import type { AssistantMessage, Message, StopReason, TextContent, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	applyContextBudget,
	deriveAdvisorBudget,
	dropPruneCoveredToolResults,
	estimateMessageTokens,
	estimateTokens,
	repairToolPairing,
} from "./budget.js";
import { getAdvisorContextBudget } from "./config.js";
import { ensureUserTailForAdvisor, getPruneCoveredToolCallIds, stripInflightAdvisorCall } from "./context.js";
import { getInventoryMessage } from "./inventory.js";
import {
	ERR_ABORTED_DETAIL,
	ERR_CALL_ABORTED,
	ERR_EMPTY_RESPONSE,
	ERR_EMPTY_RESPONSE_DETAIL,
	ERR_NO_MODEL,
	ERR_NO_MODEL_SELECTED,
	errCallFailed,
	errCallThrew,
	errMisconfigured,
	errNoApiKey,
	errNoApiKeyDetail,
	MSG_ADVISOR_NUDGE,
	msgConsulting,
} from "./messages.js";
import { getRuntimeCompleteSimple, loadCompleteSimple } from "./pi-compat.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.js";
import { getAdvisorEffort, getAdvisorModel } from "./state.js";

interface AdvisorContextDetails {
	enabled: boolean;
	dropped: number;
	estimatedTokens: number;
	maxInputTokens: number;
	pruneCoveredToolResults: number;
}

interface AdvisorDetails {
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	context?: AdvisorContextDetails;
}

// Extract the advisor's text content from a completeSimple response: concatenate
// every text part, trim. Thinking/toolCall parts are ignored. Returns "" when the
// model returned no text content — the empty-response class R6.4 retries once
// before surfacing. Pure so both attempts share one extraction path.
function advisorTextFromResponse(response: AssistantMessage): string {
	return response.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

// Single result-envelope builder — every executeAdvisor branch and the pre-call
// error paths funnel through here. `effort` is snapshotted once at executeAdvisor
// entry and threaded through every call so the returned details.effort always
// matches the value sent as `reasoning` to completeSimple, even if module-level
// state is mutated during the await window.
function buildAdvisorResult(opts: {
	text: string;
	effort: ThinkingLevel | undefined;
	advisorLabel?: string;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	context?: AdvisorContextDetails;
}): AgentToolResult<AdvisorDetails> {
	const details: AdvisorDetails = { effort: opts.effort };
	if (opts.advisorLabel !== undefined) details.advisorModel = opts.advisorLabel;
	if (opts.usage !== undefined) details.usage = opts.usage;
	if (opts.stopReason !== undefined) details.stopReason = opts.stopReason;
	if (opts.context !== undefined) details.context = opts.context;
	if (opts.errorMessage !== undefined) details.errorMessage = opts.errorMessage;
	return { content: [{ type: "text", text: opts.text }], details };
}

function buildErrorResult(
	advisorLabel: string | undefined,
	effort: ThinkingLevel | undefined,
	userText: string,
	errorMessage: string,
	context?: AdvisorContextDetails,
): AgentToolResult<AdvisorDetails> {
	return buildAdvisorResult({ text: userText, effort, advisorLabel, errorMessage, context });
}

export async function executeAdvisor(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
	// Snapshot effort once at entry — every result envelope and the API call
	// itself use this same value so a concurrent setAdvisorEffort() during the
	// await window cannot desync details.effort from the `reasoning` actually sent.
	const effort = getAdvisorEffort();
	const advisor = getAdvisorModel();
	if (!advisor) {
		return buildErrorResult(undefined, effort, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
	}
	const advisorLabel = `${advisor.provider}:${advisor.id}`;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
	if (!auth.ok) {
		return buildErrorResult(advisorLabel, effort, errMisconfigured(advisorLabel, auth.error), auth.error);
	}
	// OAuth-backed providers resolve `{ ok: true }` with no literal apiKey — their
	// credentials are applied inside Pi's runtime facade. A missing key is only
	// fatal on legacy hosts without that facade, where the global completion
	// fallback needs the key passed explicitly.
	const runtimeCompleteSimple = getRuntimeCompleteSimple(ctx.modelRegistry);
	if (!auth.apiKey && !runtimeCompleteSimple) {
		return buildErrorResult(advisorLabel, effort, errNoApiKey(advisorLabel), errNoApiKeyDetail(advisor.provider));
	}

	// Read the active branch and resolved context at call time. Native Pi
	// compaction and branch summaries are retained; the local budget pass below
	// additionally removes stale tool output and caps the advisor payload.
	const entries = ctx.sessionManager.getEntries();
	const { messages: sessionMessages } = buildSessionContext(entries, ctx.sessionManager.getLeafId());
	const activeBranchEntries = ctx.sessionManager.getBranch();
	const inventoryMessage = getInventoryMessage(pi.getAllTools());
	const rawBranchMessages = convertToLlm(sessionMessages);
	const pruneCoveredIds = getPruneCoveredToolCallIds(activeBranchEntries);
	const strippedBranchMessages = stripInflightAdvisorCall(rawBranchMessages);
	const pruneAwareMessages = dropPruneCoveredToolResults(strippedBranchMessages, pruneCoveredIds);
	const contextBudget = getAdvisorContextBudget();
	const responseReserveTokens =
		Number.isFinite(advisor.maxTokens) && advisor.maxTokens > 0
			? Math.min(contextBudget.responseReserveTokens, advisor.maxTokens)
			: contextBudget.responseReserveTokens;
	const fixedPromptTokens =
		estimateTokens(ADVISOR_SYSTEM_PROMPT) +
		(inventoryMessage ? estimateMessageTokens(inventoryMessage) : 0) +
		estimateTokens(MSG_ADVISOR_NUDGE);
	const maxInputTokens = Math.max(
		0,
		deriveAdvisorBudget(advisor.contextWindow, responseReserveTokens) - fixedPromptTokens,
	);
	const fittedBranch = contextBudget.enabled
		? applyContextBudget(pruneAwareMessages, {
				maxInputTokens,
				keepFirst: contextBudget.keepFirst,
				keepLast: contextBudget.keepLast,
				toolResultMaxChars: contextBudget.toolResultMaxChars,
			})
		: {
				messages: pruneAwareMessages,
				dropped: 0,
				estimatedTokens: pruneAwareMessages.reduce((total, message) => total + estimateMessageTokens(message), 0),
			};
	const branchMessages = ensureUserTailForAdvisor(repairToolPairing(fittedBranch.messages));
	const messages: Message[] = inventoryMessage ? [inventoryMessage, ...branchMessages] : branchMessages;
	const contextDetails: AdvisorContextDetails = {
		enabled: contextBudget.enabled,
		dropped: fittedBranch.dropped,
		estimatedTokens: fittedBranch.estimatedTokens,
		maxInputTokens,
		pruneCoveredToolResults: pruneCoveredIds.size,
	};

	onUpdate?.({
		content: [{ type: "text", text: msgConsulting(advisorLabel, effort) }],
		details: { advisorModel: advisorLabel, effort },
	});

	try {
		// Prefer Pi's auth-aware runtime facade (resolved once above, before the
		// missing-key guard). Unlike the global compatibility function, it runs
		// request preparation and applies credential-derived fields such as GitHub
		// Copilot's OAuth-specific baseUrl. Do not pass the preflight key/headers
		// to this path: explicit overrides would bypass that resolution and
		// reintroduce the endpoint mismatch.
		const completeSimple = runtimeCompleteSimple ?? (await loadCompleteSimple());
		const requestOptions = runtimeCompleteSimple
			? { signal, reasoning: effort }
			: { apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: effort };

		// Single dispatch point — both attempts reuse the SAME `messages` and
		// `requestOptions`, so the retry cannot diverge from attempt 1. `tools: []`
		// reaffirms the "never calls tools" contract even when `messages` contains
		// prior toolCall/toolResult blocks (btw.ts:235).
		const callAdvisor = (): Promise<AssistantMessage> =>
			completeSimple(advisor, { systemPrompt: ADVISOR_SYSTEM_PROMPT, messages, tools: [] }, requestOptions);

		// Build the terminal envelope for an aborted/error stopReason, or return
		// undefined when the attempt produced a normal stop whose text (or lack of
		// text) the caller must still resolve. Aborted/error short-circuit and are
		// NEVER retried — they are not the empty-response class R6.4 targets.
		const stopReasonEnvelope = (r: AssistantMessage): AgentToolResult<AdvisorDetails> | undefined => {
			if (r.stopReason === "aborted") {
				return buildAdvisorResult({
					text: ERR_CALL_ABORTED,
					effort,
					advisorLabel,
					usage: r.usage,
					stopReason: r.stopReason,
					errorMessage: r.errorMessage ?? ERR_ABORTED_DETAIL,
					context: contextDetails,
				});
			}
			if (r.stopReason === "error") {
				return buildAdvisorResult({
					text: errCallFailed(r.errorMessage),
					effort,
					advisorLabel,
					usage: r.usage,
					stopReason: r.stopReason,
					errorMessage: r.errorMessage,
					context: contextDetails,
				});
			}
			return undefined;
		};

		let response = await callAdvisor();

		// Aborted/error short-circuit on the first attempt — no retry.
		const firstTerminal = stopReasonEnvelope(response);
		if (firstTerminal) return firstTerminal;

		let advisorText = advisorTextFromResponse(response);

		// R6.4: a transient empty advisor response (normal stop, no text) gets
		// exactly ONE retry with identical inputs before surfacing as a terminal
		// error. Bounded to a single second call — never a `while`/loop — so a
		// persistent-empty provider cannot hot-loop. The retry reuses the SAME
		// pre-computed `messages`/`requestOptions` (no re-derivation that could
		// diverge from attempt 1), then applies the same three-way route.
		if (!advisorText) {
			response = await callAdvisor();

			const retryTerminal = stopReasonEnvelope(response);
			if (retryTerminal) return retryTerminal;

			advisorText = advisorTextFromResponse(response);
			if (!advisorText) {
				return buildAdvisorResult({
					text: ERR_EMPTY_RESPONSE,
					effort,
					advisorLabel,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: ERR_EMPTY_RESPONSE_DETAIL,
					context: contextDetails,
				});
			}
		}

		return buildAdvisorResult({
			text: advisorText,
			effort,
			advisorLabel,
			usage: response.usage,
			stopReason: response.stopReason,
			context: contextDetails,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return buildErrorResult(advisorLabel, effort, errCallThrew(message), message, contextDetails);
	}
}
