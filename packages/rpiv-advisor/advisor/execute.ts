/**
 * execute — the advisor side-call. Curates the executor's branch (inventory
 * prefix + tail massaging), invokes the advisor model via completeSimple with
 * no tools, and returns a structured tool result. Every result branch (success
 * / abort / error / empty) and the pre-call error paths funnel through
 * buildAdvisorResult so the envelope is built in exactly one place.
 */

import type { Message, StopReason, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ensureUserTailForAdvisor, stripInflightAdvisorCall } from "./context.js";
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
	msgAdvisorFellBack,
	msgConsulting,
	msgConsultingFallback,
} from "./messages.js";
import { getRuntimeCompleteSimple, loadCompleteSimple } from "./pi-compat.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.js";
import { getAdvisorEffort, getAdvisorFallbacks, getAdvisorModel } from "./state.js";

interface AdvisorDetails {
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	// Set when a fallback model served (or attempted) the call: the label of the
	// originally-configured primary advisor it fell back from.
	fellBackFrom?: string;
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
	fellBackFrom?: string;
}): AgentToolResult<AdvisorDetails> {
	const details: AdvisorDetails = { effort: opts.effort };
	if (opts.advisorLabel !== undefined) details.advisorModel = opts.advisorLabel;
	if (opts.usage !== undefined) details.usage = opts.usage;
	if (opts.stopReason !== undefined) details.stopReason = opts.stopReason;
	if (opts.errorMessage !== undefined) details.errorMessage = opts.errorMessage;
	if (opts.fellBackFrom !== undefined) details.fellBackFrom = opts.fellBackFrom;
	return { content: [{ type: "text", text: opts.text }], details };
}

function buildErrorResult(
	advisorLabel: string | undefined,
	effort: ThinkingLevel | undefined,
	userText: string,
	errorMessage: string,
	fellBackFrom?: string,
): AgentToolResult<AdvisorDetails> {
	return buildAdvisorResult({ text: userText, effort, advisorLabel, errorMessage, fellBackFrom });
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
	const primary = getAdvisorModel();
	if (!primary) {
		return buildErrorResult(undefined, effort, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
	}
	// Ordered attempt chain: the configured advisor, then its fallback models.
	// A refusal reaches us as stopReason "error" (pi-ai's anthropic-messages
	// mapStopReason collapses Anthropic's "refusal" into "error"), so falling
	// back on "error" covers both classifier refusals and transient failures.
	const chain = [primary, ...getAdvisorFallbacks()];
	const primaryLabel = `${primary.provider}:${primary.id}`;

	// Live-read once — advisor runs mid-turn so any message_end snapshot is always
	// one turn stale. buildSessionContext() preserves Pi's resolved LLM context,
	// including compaction summaries and branch summaries, instead of replaying
	// raw pre-compaction branch messages. convertToLlm is pass-through for
	// user/assistant/toolResult (messages.js:111-114), so element refs are stable
	// across calls via the session store. The same request is re-sent to every
	// model in the chain.
	const { messages: sessionMessages } = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	const branchMessages = ensureUserTailForAdvisor(stripInflightAdvisorCall(convertToLlm(sessionMessages)));
	const inventoryMessage = getInventoryMessage(pi.getAllTools());
	const messages: Message[] = inventoryMessage ? [inventoryMessage, ...branchMessages] : branchMessages;

	// Prefer Pi's auth-aware runtime facade. Unlike the global compatibility
	// function, it runs request preparation and applies credential-derived fields
	// such as GitHub Copilot's OAuth-specific baseUrl. Do not pass the preflight
	// key/headers to this path: explicit overrides would bypass that resolution
	// and reintroduce the endpoint mismatch.
	const runtimeCompleteSimple = getRuntimeCompleteSimple(ctx.modelRegistry);
	const completeSimple = runtimeCompleteSimple ?? (await loadCompleteSimple());

	// Retained across the loop so that when every model fails we return the last
	// failure envelope rather than a generic error.
	let lastFailure: AgentToolResult<AdvisorDetails> | undefined;

	for (let i = 0; i < chain.length; i++) {
		const advisor = chain[i];
		const advisorLabel = `${advisor.provider}:${advisor.id}`;
		const isFallback = i > 0;
		const fellBackFrom = isFallback ? primaryLabel : undefined;
		const nextModel = chain[i + 1];
		const notifyFellBack = (): void => {
			if (!nextModel) return;
			onUpdate?.({
				content: [
					{ type: "text", text: msgAdvisorFellBack(advisorLabel, `${nextModel.provider}:${nextModel.id}`) },
				],
				details: { effort },
			});
		};

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
		if (!auth.ok) {
			lastFailure = buildErrorResult(
				advisorLabel,
				effort,
				errMisconfigured(advisorLabel, auth.error),
				auth.error,
				fellBackFrom,
			);
			if (nextModel) {
				notifyFellBack();
				continue;
			}
			return lastFailure;
		}
		if (!auth.apiKey) {
			lastFailure = buildErrorResult(
				advisorLabel,
				effort,
				errNoApiKey(advisorLabel),
				errNoApiKeyDetail(advisor.provider),
				fellBackFrom,
			);
			if (nextModel) {
				notifyFellBack();
				continue;
			}
			return lastFailure;
		}

		onUpdate?.({
			content: [
				{
					type: "text",
					text: isFallback ? msgConsultingFallback(advisorLabel, effort) : msgConsulting(advisorLabel, effort),
				},
			],
			details: { advisorModel: advisorLabel, effort, ...(fellBackFrom ? { fellBackFrom } : {}) },
		});

		try {
			const requestOptions = runtimeCompleteSimple
				? { signal, reasoning: effort }
				: { apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: effort };
			const response = await completeSimple(
				advisor,
				// `tools: []` reaffirms the "never calls tools" contract even when
				// `messages` contains prior toolCall/toolResult blocks (btw.ts:235).
				{ systemPrompt: ADVISOR_SYSTEM_PROMPT, messages, tools: [] },
				requestOptions,
			);

			if (response.stopReason === "aborted") {
				// User cancelled — an intentional abort must not burn fallback attempts.
				return buildAdvisorResult({
					text: ERR_CALL_ABORTED,
					effort,
					advisorLabel,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage ?? ERR_ABORTED_DETAIL,
					fellBackFrom,
				});
			}

			if (response.stopReason === "error") {
				lastFailure = buildAdvisorResult({
					text: errCallFailed(response.errorMessage),
					effort,
					advisorLabel,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage,
					fellBackFrom,
				});
				if (nextModel) {
					notifyFellBack();
					continue;
				}
				return lastFailure;
			}

			const advisorText = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			if (!advisorText) {
				return buildAdvisorResult({
					text: ERR_EMPTY_RESPONSE,
					effort,
					advisorLabel,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: ERR_EMPTY_RESPONSE_DETAIL,
					fellBackFrom,
				});
			}

			return buildAdvisorResult({
				text: advisorText,
				effort,
				advisorLabel,
				usage: response.usage,
				stopReason: response.stopReason,
				fellBackFrom,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			lastFailure = buildErrorResult(advisorLabel, effort, errCallThrew(message), message, fellBackFrom);
			if (nextModel) {
				notifyFellBack();
				continue;
			}
			return lastFailure;
		}
	}

	// Unreachable while the chain is non-empty (primary is always present), but
	// keeps the function total for the type checker and an empty-chain guard.
	return lastFailure ?? buildErrorResult(undefined, effort, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
}
