/**
 * advisor tool + /advisor command — Advisor-strategy pattern.
 *
 * Lets the executor model consult a stronger advisor model (e.g. Opus) via an
 * in-process completeSimple() call with the full serialized conversation branch
 * as context. Advisor has no tools, never emits user-facing output, and returns
 * guidance (plan, correction, or stop signal) that the executor resumes with.
 *
 * Default state is OFF — the tool is registered at load but a before_agent_start
 * handler strips it from the active tool list each turn while no advisor model
 * is selected. /advisor opens a selector panel (ctx.ui.custom) to pick an
 * advisor model from ctx.modelRegistry.getAvailable() and toggles the tool in
 * via pi.setActiveTools(). Selection is in-memory and resets each session.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Api, Model, StopReason, Usage } from "@earendil-works/pi-ai";
import { completeSimple, getSupportedThinkingLevels, type Message, type ThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { configPath, loadJsonConfig, saveJsonConfig, validateGuidanceFields } from "@juicesharp/rpiv-config";
import { Type } from "typebox";
import { showAdvisorPicker, showEffortPicker } from "./advisor-ui.js";

// ---------------------------------------------------------------------------
// Constants — grouped by concern, flat named consts (no namespaced objects)
// ---------------------------------------------------------------------------

// Tool identity
export const ADVISOR_TOOL_NAME = "advisor";
const TOOL_LABEL = "Advisor";

// Persistence
const ADVISOR_CONFIG_PATH = configPath("rpiv-advisor", "advisor.json");

// Selector sentinels — double-underscore form is collision-proof against real provider:id keys
const NO_ADVISOR_VALUE = "__no_advisor__";
const OFF_VALUE = "__off__";

// Effort levels
const BASE_EFFORT_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high"];
const XHIGH_EFFORT_LEVEL: ThinkingLevel = "xhigh";
const EFFORT_ORDINAL: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_EFFORT: ThinkingLevel = "high";
const RECOMMENDED_EFFORT_SUFFIX = "  (recommended)";

// UI — labels used by command flow; panel prose/titles live in advisor-ui.ts
const CHECKMARK = " ✓";

// Messages (static)
const MSG_ADVISOR_DISABLED = "Advisor disabled";
const MSG_REQUIRES_INTERACTIVE = "/advisor requires interactive mode";
const MSG_ADVISOR_NUDGE = "Please advise on the executor's situation above.";
const MSG_PERSIST_FAILED = "Failed to save advisor selection — selection not persisted";

// Errors (static)
const ERR_NO_MODEL = "No advisor model is configured. The user can enable one with the /advisor command.";
const ERR_CALL_ABORTED = "Advisor call was cancelled before it completed.";
const ERR_EMPTY_RESPONSE = "Advisor returned no text content.";
const ERR_NO_MODEL_SELECTED = "no advisor model selected";
const ERR_EMPTY_RESPONSE_DETAIL = "empty response";
const ERR_ABORTED_DETAIL = "aborted";
const ERR_UNKNOWN = "unknown error";

// Errors/messages (parameterized)
const errMisconfigured = (label: string, err: string) => `Advisor (${label}) is misconfigured: ${err}`;
const errNoApiKey = (label: string) => `Advisor (${label}) has no API key available.`;
const errNoApiKeyDetail = (provider: string) => `no API key for ${provider}`;
const errCallFailed = (err: string | undefined) => `Advisor call failed: ${err ?? ERR_UNKNOWN}`;
const errCallThrew = (msg: string) => `Advisor call threw: ${msg}`;
const errSelectionNotFound = (choice: string) => `Advisor selection not found: ${choice}`;
const errModelUnavailable = (key: string) => `Previously configured advisor model ${key} is no longer available`;
const msgAdvisorEnabled = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor: ${label}${effort ? `, ${effort}` : ""}`;
const msgAdvisorRestored = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor restored: ${label}${effort ? `, ${effort}` : ""}`;
const msgAdvisorRestoredInactive = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor restored: ${label}${effort ? `, ${effort}` : ""} (inactive for current executor)`;
const msgAdvisorEnabledInactive = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor: ${label}${effort ? `, ${effort}` : ""} (inactive for current executor)`;
const msgConsulting = (label: string, effort: ThinkingLevel | undefined) =>
	`Consulting advisor (${label}${effort ? `, ${effort}` : ""})…`;

// ---------------------------------------------------------------------------
// Config file persistence (cross-session)
// ---------------------------------------------------------------------------

interface AdvisorConfig {
	modelKey?: string;
	effort?: ThinkingLevel;
	guidance?: GuidanceFields;
	disabledForModels?: Array<string | { model: string; minEffort?: ThinkingLevel }>;
}

export function loadAdvisorConfig(): AdvisorConfig {
	return loadJsonConfig<AdvisorConfig>(ADVISOR_CONFIG_PATH);
}

// validateGuidanceFields is now imported from @juicesharp/rpiv-config

function validateDisabledForModels(value: unknown): Array<string | { model: string; minEffort?: ThinkingLevel }> {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string | { model: string; minEffort?: ThinkingLevel } => {
		if (typeof entry === "string") return entry.length > 0;
		if (typeof entry !== "object" || entry === null) return false;
		const obj = entry as Record<string, unknown>;
		if (typeof obj.model !== "string" || obj.model.length === 0) return false;
		if (obj.minEffort !== undefined && !EFFORT_ORDINAL.includes(obj.minEffort as ThinkingLevel)) return false;
		return true;
	});
}

export function saveAdvisorConfig(key: string | undefined, effort: ThinkingLevel | undefined): boolean {
	const existing = loadAdvisorConfig();
	const config: AdvisorConfig = { ...existing };
	// Delete (rather than omit) to clear fields that may exist in the spread
	// from a prior read. JSON.parse always produces configurable properties,
	// so delete is safe in strict mode.
	if (key) config.modelKey = key;
	else delete config.modelKey;
	if (effort) config.effort = effort;
	else delete config.effort;
	return saveJsonConfig(ADVISOR_CONFIG_PATH, config);
}

function parseModelKey(key: string): { provider: string; modelId: string } | undefined {
	const idx = key.indexOf(":");
	if (idx < 1) return undefined;
	return { provider: key.slice(0, idx), modelId: key.slice(idx + 1) };
}

// ---------------------------------------------------------------------------
// System prompt — loaded once at module init from prompts/advisor-system.txt
// ---------------------------------------------------------------------------

export const ADVISOR_SYSTEM_PROMPT = readFileSync(
	fileURLToPath(new URL("./prompts/advisor-system.txt", import.meta.url)),
	"utf-8",
).trimEnd();

// ---------------------------------------------------------------------------
// Inventory state + serializer — stable tool-inventory Message for cache parity
//
// globalThis-keyed to survive module re-import on /new, /fork, /resume (mirrors
// rpiv-btw/btw.ts:37, 87-98). Single-slot cache — the Pi tool registry is
// process-scoped, so per-session keying would be redundant. Cache invalidates
// only when the set of registered tool names changes.
// ---------------------------------------------------------------------------

const ADVISOR_STATE_KEY = Symbol.for("rpiv-advisor");

interface AdvisorState {
	inventorySignature?: string;
	inventoryMessage?: Message;
}

function getAdvisorRuntimeState(): AdvisorState {
	const g = globalThis as unknown as { [k: symbol]: AdvisorState | undefined };
	let state = g[ADVISOR_STATE_KEY];
	if (!state) {
		state = {};
		g[ADVISOR_STATE_KEY] = state;
	}
	return state;
}

// Recursive key-sorted JSON serializer — matches JSON.stringify semantics
// (drops `undefined` in objects, emits `null` for `undefined` in arrays) but
// guarantees stable key ordering across V8 insertion-order variation. Required
// because nested TypeBox schemas may be authored in any order, and prompt
// caching is byte-sensitive.
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const entries: string[] = [];
	for (const k of Object.keys(obj).sort()) {
		const v = obj[k];
		if (v === undefined) continue;
		entries.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
	}
	return `{${entries.join(",")}}`;
}

function buildInventoryBlock(tools: ToolInfo[]): string {
	// Omit `sourceInfo` — its `path` field is install-location-dependent and
	// would bust cache parity across machines/reinstalls.
	return tools
		.map((t) => `### ${t.name}\n${t.description}\n\nParameters: ${stableStringify(t.parameters)}`)
		.join("\n\n---\n\n");
}

// Strip the executor's in-flight advisor() toolCall from the tail assistant
// message. That call is what invoked *us* — there is no matching toolResult
// yet, and providers (Anthropic, GLM/zai, OpenAI) reject payloads with orphan
// toolCalls. Name-targeted to leave any other trailing toolCalls visible.
export function stripInflightAdvisorCall(messages: Message[]): Message[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant") return messages;
	const filtered = last.content.filter((c) => !(c.type === "toolCall" && c.name === ADVISOR_TOOL_NAME));
	if (filtered.length === last.content.length) return messages;
	if (filtered.length === 0) return messages.slice(0, -1);
	return [...messages.slice(0, -1), { ...last, content: filtered }];
}

// Some providers (recent Anthropic Claude models) reject payloads ending on an
// assistant turn ("This model does not support assistant message prefill. The
// conversation must end with a user message."). After stripInflightAdvisorCall
// the tail can be assistant (e.g. the executor wrote thinking text before
// calling advisor). Append a minimal user-role nudge to guarantee user-tail.
export function ensureUserTailForAdvisor(messages: Message[]): Message[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant") return messages;
	const nudge: Message = {
		role: "user",
		content: [{ type: "text", text: MSG_ADVISOR_NUDGE }],
		timestamp: Date.now(),
	};
	return [...messages, nudge];
}

// Returns `undefined` when the registry is empty (no extensions loaded) so
// callers can skip prepending an empty block that would still cost a cache unit.
export function getInventoryMessage(tools: ToolInfo[]): Message | undefined {
	if (tools.length === 0) return undefined;
	const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const signature = sorted.map((t) => t.name).join("|");
	const state = getAdvisorRuntimeState();
	if (state.inventorySignature === signature && state.inventoryMessage) {
		return state.inventoryMessage;
	}
	const text = `## Available Executor Tools\n\n${buildInventoryBlock(sorted)}`;
	const message: Message = {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
	state.inventorySignature = signature;
	state.inventoryMessage = message;
	return message;
}

// ---------------------------------------------------------------------------
// Module state — in-memory, resets each session
// ---------------------------------------------------------------------------

let selectedAdvisor: Model<Api> | undefined;
let selectedAdvisorEffort: ThinkingLevel | undefined;

export function getAdvisorModel(): Model<Api> | undefined {
	return selectedAdvisor;
}

export function setAdvisorModel(model: Model<Api> | undefined): void {
	selectedAdvisor = model;
}

export function getAdvisorEffort(): ThinkingLevel | undefined {
	return selectedAdvisorEffort;
}

export function setAdvisorEffort(effort: ThinkingLevel | undefined): void {
	selectedAdvisorEffort = effort;
}

let disabledForModelsCache: Array<string | { model: string; minEffort?: ThinkingLevel }> = [];

export function setDisabledForModels(models: Array<string | { model: string; minEffort?: ThinkingLevel }>): void {
	disabledForModelsCache = models;
}

// ---------------------------------------------------------------------------
// Session restoration — called from index.ts session_start handler
// ---------------------------------------------------------------------------

/**
 * Module-local "already announced" latch. Pi fires `session_start` for every
 * session including programmatic spawns (workflow stages, batch ops, any
 * extension's `newSession` call). State mutation belongs on every fire;
 * the user-facing announcement does NOT — repeating it per stage in a
 * `/wf` run just spams the status line. The latch flips on the first
 * notify and stays set until the module is reloaded (`/reload`) or the
 * process restarts. Test-resettable via `__resetAdvisorAnnounced()`.
 *
 * This is the same shape as `restoredAdvisorState`'s own decision to
 * mutate state every call but notify once. We used to read a workflow-
 * branded `Symbol.for("@juicesharp/rpiv-workflow:child-session")` to
 * achieve the same effect — that coupled this package to rpiv-workflow's
 * internals for no real reason: every extension that wants "notify the
 * user once per process" has the same shape, and none of them need to
 * know who spawned the session.
 */
let restoreAnnounced = false;

/** Test reset — wired into test/setup.ts `beforeEach`. */
export function __resetAdvisorAnnounced(): void {
	restoreAnnounced = false;
}

export function restoreAdvisorState(ctx: ExtensionContext, pi: ExtensionAPI): void {
	const config = loadAdvisorConfig();

	setDisabledForModels(validateDisabledForModels(config.disabledForModels));

	if (!config.modelKey) return;

	const parsed = parseModelKey(config.modelKey);
	if (!parsed) return;

	const notifyOnce = (msg: string, level: "info" | "warning" | "error"): void => {
		if (!ctx.hasUI || restoreAnnounced) return;
		ctx.ui.notify(msg, level);
		restoreAnnounced = true;
	};

	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		notifyOnce(errModelUnavailable(config.modelKey), "warning");
		return;
	}

	setAdvisorModel(model);
	if (config.effort) {
		setAdvisorEffort(config.effort);
	}

	if (isExecutorBlocked(ctx, pi.getThinkingLevel())) {
		const advisorLabel = `${model.provider}:${model.id}`;
		notifyOnce(msgAdvisorRestoredInactive(advisorLabel, config.effort), "info");
		return;
	}

	const active = pi.getActiveTools();
	if (!active.includes(ADVISOR_TOOL_NAME)) {
		pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
	}

	notifyOnce(msgAdvisorRestored(`${model.provider}:${model.id}`, config.effort), "info");
}

// ---------------------------------------------------------------------------
// Core execute logic — curate context, call advisor, return structured result
// ---------------------------------------------------------------------------

export interface AdvisorDetails {
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}

function buildErrorResult(
	advisorLabel: string | undefined,
	userText: string,
	errorMessage: string,
): AgentToolResult<AdvisorDetails> {
	const effort = getAdvisorEffort();
	return {
		content: [{ type: "text", text: userText }],
		details: advisorLabel ? { advisorModel: advisorLabel, effort, errorMessage } : { effort, errorMessage },
	};
}

async function executeAdvisor(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
	const advisor = getAdvisorModel();
	if (!advisor) {
		return buildErrorResult(undefined, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
	}
	const advisorLabel = `${advisor.provider}:${advisor.id}`;
	const effort = getAdvisorEffort();

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
	if (!auth.ok) {
		return buildErrorResult(advisorLabel, errMisconfigured(advisorLabel, auth.error), auth.error);
	}
	if (!auth.apiKey) {
		return buildErrorResult(advisorLabel, errNoApiKey(advisorLabel), errNoApiKeyDetail(advisor.provider));
	}

	// Live-read every call — advisor runs mid-turn so any message_end snapshot
	// is always one turn stale. buildSessionContext() preserves Pi's resolved
	// LLM context, including compaction summaries and branch summaries, instead
	// of replaying raw pre-compaction branch messages. convertToLlm is
	// pass-through for user/assistant/toolResult (messages.js:111-114), so
	// element refs are stable across calls via the session store.
	const { messages: sessionMessages } = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	const branchMessages = ensureUserTailForAdvisor(stripInflightAdvisorCall(convertToLlm(sessionMessages)));
	const inventoryMessage = getInventoryMessage(pi.getAllTools());
	const messages: Message[] = inventoryMessage ? [inventoryMessage, ...branchMessages] : branchMessages;

	onUpdate?.({
		content: [{ type: "text", text: msgConsulting(advisorLabel, effort) }],
		details: { advisorModel: advisorLabel, effort },
	});

	try {
		const response = await completeSimple(
			advisor,
			// `tools: []` reaffirms the "never calls tools" contract even when
			// `messages` contains prior toolCall/toolResult blocks (btw.ts:235).
			{ systemPrompt: ADVISOR_SYSTEM_PROMPT, messages, tools: [] },
			{ apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: effort },
		);

		if (response.stopReason === "aborted") {
			return {
				content: [{ type: "text", text: ERR_CALL_ABORTED }],
				details: {
					advisorModel: advisorLabel,
					effort,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage ?? ERR_ABORTED_DETAIL,
				},
			};
		}

		if (response.stopReason === "error") {
			return {
				content: [{ type: "text", text: errCallFailed(response.errorMessage) }],
				details: {
					advisorModel: advisorLabel,
					effort,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage,
				},
			};
		}

		const advisorText = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!advisorText) {
			return {
				content: [{ type: "text", text: ERR_EMPTY_RESPONSE }],
				details: {
					advisorModel: advisorLabel,
					effort,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: ERR_EMPTY_RESPONSE_DETAIL,
				},
			};
		}

		return {
			content: [{ type: "text", text: advisorText }],
			details: {
				advisorModel: advisorLabel,
				effort,
				usage: response.usage,
				stopReason: response.stopReason,
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return buildErrorResult(advisorLabel, errCallThrew(message), message);
	}
}

// ---------------------------------------------------------------------------
// Tool registration — zero-param schema, curated description/snippet/guidelines
// ---------------------------------------------------------------------------

const AdvisorParams = Type.Object({});

const ADVISOR_DESCRIPTION =
	"Escalate to a stronger reviewer model for guidance. When you need " +
	"stronger judgment — a complex decision, an ambiguous failure, a problem " +
	"you're circling without progress — escalate to the advisor model for " +
	"guidance, then resume. Takes NO parameters — when you call advisor(), " +
	"your entire conversation history is automatically forwarded. The advisor " +
	"sees the task, every tool call you've made, every result you've seen.";

export const DEFAULT_PROMPT_SNIPPET =
	"Escalate to a stronger reviewer model for guidance when stuck, before substantive work, or before declaring done";

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Call `advisor` BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. Orientation (finding files, fetching a source, seeing what's there) is not substantive work; writing, editing, and declaring an answer are.",
	"Also call `advisor` when you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.",
	"Also call `advisor` when stuck — errors recurring, approach not converging, results that don't fit — or when considering a change of approach.",
	"On tasks longer than a few steps, call `advisor` at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling — the advisor adds most of its value on the first call, before the approach crystallizes.",
	"Give the advisor's advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim, adapt — a passing self-test is not evidence the advice is wrong, it's evidence your test doesn't check what the advice is checking.",
	"If you've already retrieved data pointing one way and the advisor points another, don't silently switch — surface the conflict in one more `advisor` call (\"I found X, you suggest Y, which constraint breaks the tie?\"). A reconcile call is cheaper than committing to the wrong branch.",
];

export function registerAdvisorTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadAdvisorConfig().guidance);
	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: TOOL_LABEL,
		description: ADVISOR_DESCRIPTION,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: AdvisorParams,

		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			return executeAdvisor(ctx, pi, signal, onUpdate);
		},
	});
}

// ---------------------------------------------------------------------------
// before_agent_start handler — strip advisor from active tools when disabled
// ---------------------------------------------------------------------------

export function registerAdvisorBeforeAgentStart(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		const advisor = getAdvisorModel();
		if (!advisor) {
			const active = pi.getActiveTools();
			if (active.includes(ADVISOR_TOOL_NAME)) {
				pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
			}
			return;
		}
		const blocked = isExecutorBlocked(ctx, pi.getThinkingLevel());
		const active = pi.getActiveTools();
		const hasTool = active.includes(ADVISOR_TOOL_NAME);
		if (blocked && hasTool) {
			pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
		} else if (!blocked && !hasTool) {
			pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
		}
	});
}

// ---------------------------------------------------------------------------
// model_select handler — mid-session model switches strip/re-add advisor
// ---------------------------------------------------------------------------

export function registerModelSelectHandler(pi: ExtensionAPI): void {
	pi.on("model_select", async (event, ctx) => {
		// session_start restore path is owned by restoreAdvisorState — it already
		// activates the tool and notifies. Skipping "restore" here prevents a
		// duplicate notification on initial model load.
		if (event.source === "restore") return;

		const advisor = getAdvisorModel();
		if (!advisor) return;

		const blocked = isModelBlocked(event.model, pi.getThinkingLevel());
		const active = pi.getActiveTools();
		const hasTool = active.includes(ADVISOR_TOOL_NAME);

		if (blocked && hasTool) {
			pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
			if (ctx.hasUI) {
				ctx.ui.notify(`Advisor disabled for ${modelKey(event.model)}`, "info");
			}
		} else if (!blocked && !hasTool) {
			pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
			if (ctx.hasUI) {
				ctx.ui.notify(msgAdvisorRestored(modelKey(advisor), getAdvisorEffort()), "info");
			}
		}
	});
}

// ---------------------------------------------------------------------------
// thinking_level_select handler — mid-session effort changes strip/re-add advisor
// ---------------------------------------------------------------------------

export function registerThinkingLevelSelectHandler(pi: ExtensionAPI): void {
	pi.on("thinking_level_select", async (event, ctx) => {
		const advisor = getAdvisorModel();
		if (!advisor) return;

		const blocked = isModelBlocked(ctx?.model, event.level);
		const active = pi.getActiveTools();
		const hasTool = active.includes(ADVISOR_TOOL_NAME);

		if (blocked && hasTool) {
			pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
			if (ctx.hasUI) {
				ctx.ui.notify(`Advisor disabled for ${modelKey(ctx.model!)}`, "info");
			}
		} else if (!blocked && !hasTool) {
			pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
			if (ctx.hasUI) {
				ctx.ui.notify(msgAdvisorRestored(modelKey(advisor), getAdvisorEffort()), "info");
			}
		}
	});
}

// ---------------------------------------------------------------------------
// /advisor slash command — opens selector panel for picking the advisor model
// ---------------------------------------------------------------------------

function modelKey(m: { provider: string; id: string }): string {
	return `${m.provider}:${m.id}`;
}

function isModelBlocked(model: Model<Api> | undefined, thinkingLevel?: string): boolean {
	if (!model) return false;
	const key = modelKey(model);
	for (const entry of disabledForModelsCache) {
		if (typeof entry === "string") {
			if (entry === key) return true;
		} else {
			if (entry.model !== key) continue;
			if (entry.minEffort === undefined) return true;
			const thresholdOrdinal = EFFORT_ORDINAL.indexOf(entry.minEffort);
			const executorOrdinal = EFFORT_ORDINAL.indexOf(thinkingLevel as ThinkingLevel);
			if (executorOrdinal >= thresholdOrdinal) return true;
		}
	}
	return false;
}

function isExecutorBlocked(ctx: ExtensionContext, thinkingLevel?: string): boolean {
	return isModelBlocked(ctx?.model, thinkingLevel);
}

export function registerAdvisorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("advisor", {
		description: "Configure the advisor model for the advisor-strategy pattern",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
				return;
			}

			const availableModels = ctx.modelRegistry.getAvailable();
			const current = getAdvisorModel();
			const currentKey = current ? modelKey(current) : undefined;

			const items: SelectItem[] = availableModels.map((m) => {
				const key = modelKey(m);
				const check = key === currentKey ? CHECKMARK : "";
				return { value: key, label: `${m.name}  (${m.provider})${check}` };
			});
			items.push({
				value: NO_ADVISOR_VALUE,
				label: currentKey === undefined ? `No advisor${CHECKMARK}` : "No advisor",
			});

			const choice = await showAdvisorPicker(ctx, items);
			if (!choice) {
				return;
			}

			const activeTools = pi.getActiveTools();
			const activeHas = activeTools.includes(ADVISOR_TOOL_NAME);

			if (choice === NO_ADVISOR_VALUE) {
				// Persist BEFORE applying in-memory state so a save failure can't
				// leave the model setter and the active-tools registry divergent
				// (review I2: early-return on failure skipped the tool-list update
				// and left "model=undefined + tool still registered" stranded).
				if (!saveAdvisorConfig(undefined, undefined)) {
					ctx.ui.notify(MSG_PERSIST_FAILED, "error");
					return;
				}
				setAdvisorModel(undefined);
				setAdvisorEffort(undefined);
				if (activeHas) {
					pi.setActiveTools(activeTools.filter((n) => n !== ADVISOR_TOOL_NAME));
				}
				ctx.ui.notify(MSG_ADVISOR_DISABLED, "info");
				return;
			}

			const picked = availableModels.find((m) => modelKey(m) === choice);
			if (!picked) {
				ctx.ui.notify(errSelectionNotFound(choice), "error");
				return;
			}

			// Effort picker — only for reasoning-capable models
			let effortChoice: ThinkingLevel | undefined;
			if (picked.reasoning) {
				const levels = getSupportedThinkingLevels(picked).includes("xhigh")
					? [...BASE_EFFORT_LEVELS, XHIGH_EFFORT_LEVEL]
					: BASE_EFFORT_LEVELS;

				const effortItems: SelectItem[] = [
					{ value: OFF_VALUE, label: "off" },
					...levels.map((level) => ({
						value: level,
						label: level === DEFAULT_EFFORT ? `${level}${RECOMMENDED_EFFORT_SUFFIX}` : level,
					})),
				];

				const effortResult = await showEffortPicker(ctx, effortItems, getAdvisorEffort(), DEFAULT_EFFORT);
				if (!effortResult) {
					return;
				}
				effortChoice = effortResult === OFF_VALUE ? undefined : (effortResult as ThinkingLevel);
			}

			// Persist BEFORE applying in-memory state — same rationale as the
			// disable branch above (review I2).
			if (!saveAdvisorConfig(modelKey(picked), effortChoice)) {
				ctx.ui.notify(MSG_PERSIST_FAILED, "error");
				return;
			}
			setAdvisorEffort(effortChoice);
			setAdvisorModel(picked);

			// Re-read after the effort-picker await — the snapshot taken before
			// `showEffortPicker` is stale once execution yields.
			const activeToolsNow = pi.getActiveTools();
			const activeHasNow = activeToolsNow.includes(ADVISOR_TOOL_NAME);
			const blocked = isExecutorBlocked(ctx, pi.getThinkingLevel());
			if (!activeHasNow && !blocked) {
				pi.setActiveTools([...activeToolsNow, ADVISOR_TOOL_NAME]);
			}
			if (blocked) {
				ctx.ui.notify(msgAdvisorEnabledInactive(modelKey(picked), effortChoice), "info");
			} else {
				ctx.ui.notify(msgAdvisorEnabled(modelKey(picked), effortChoice), "info");
			}
		},
	});
}
