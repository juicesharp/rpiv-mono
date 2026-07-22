import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { loadConfig, resolveCollapseKey, validateGuidanceFields } from "./config.js";
import { ASK_USER_PROMPT_EVENT, type AskUserPromptEventPayload } from "./events.js";
// Static import is fine — rpc-fallback pulls only types + the i18n bridge,
// none of the ~560ms TUI render graph that QuestionnaireSession lazy-loads.
import { hasDialogUI, runRpcQuestionnaire } from "./rpc-fallback.js";
import { displayLabel } from "./state/i18n-bridge.js";
import { sentinelsToAppend } from "./state/row-intent.js";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.js";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionData,
	type QuestionnaireError,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
} from "./tool/types.js";
import { validateQuestionnaire } from "./tool/validate-questionnaire.js";
import type { WrappingSelectItem } from "./view/components/wrapping-select.js";

function emitAskUserPromptEvent(pi: ExtensionAPI, params: QuestionParams): void {
	const payload: AskUserPromptEventPayload = {
		questions: params.questions.map((q) => ({
			question: q.question,
			header: q.header,
			multiSelect: q.multiSelect ?? false,
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
				hasPreview: typeof o.preview === "string" && o.preview.length > 0,
			})),
		})),
	};
	pi.events.emit(ASK_USER_PROMPT_EVENT, payload);
}

/** Canonical tool name — single source of truth shared with the reconcile module. */
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

const ERROR_NO_CUSTOM_UI =
	"Error: this client cannot render the questionnaire (custom UI is unavailable, e.g. RPC/ACP hosts such as Zed or Paseo). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.";

const ERROR_SESSION_LOAD_FAILED =
	"Error: the questionnaire UI failed to load — the host's installed dependencies were likely replaced or removed on disk while Pi was running (e.g. a package-manager install touched the store). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user that restoring this tool requires repairing the install if needed and restarting Pi.";

const ERROR_STALE_MODULE_CACHE =
	"Error: the questionnaire UI cannot load — the host's module cache went stale after an earlier failed load (typically dependencies replaced on disk mid-session). This is unrecoverable within the current Pi process. The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user to restart Pi to restore this tool.";

/** Delay before the background session-graph pre-warm; mirrors rpiv-workflow's /wf prewarm. */
export const PREWARM_DELAY_MS = 2000;

type SessionModule = typeof import("./state/questionnaire-session.js");

type SessionLoad =
	| { ok: true; module: SessionModule }
	| { ok: false; error: Extract<QuestionnaireError, "session_load_failed" | "stale_module_cache">; message: string };

/**
 * Lazy-load the ~560ms QuestionnaireSession view/TUI render graph, guarding
 * the two failure shapes of issue #107. Pi's jiti loader registers a module in
 * its graph cache BEFORE evaluating the body and does not evict it when
 * evaluation throws (jiti 2.7.0), so one failed load — e.g. `pnpm install
 * --force` replacing the store entry mid-session — leaves every later import
 * of this specifier resolving to a namespace without the class. That state is
 * unrecoverable in-process (cache-busting specifiers fail jiti resolution);
 * both branches therefore return an LLM-facing envelope that names the restart
 * requirement instead of leaking a bare "not a constructor" TypeError.
 */
export async function loadQuestionnaireSession(): Promise<SessionLoad> {
	let mod: SessionModule;
	try {
		mod = await import("./state/questionnaire-session.js");
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		return { ok: false, error: "session_load_failed", message: `${ERROR_SESSION_LOAD_FAILED} (cause: ${cause})` };
	}
	if (typeof mod.QuestionnaireSession !== "function") {
		const keys = JSON.stringify(Object.keys(mod));
		return {
			ok: false,
			error: "stale_module_cache",
			message: `${ERROR_STALE_MODULE_CACHE} (resolved namespace keys: ${keys})`,
		};
	}
	return { ok: true, module: mod };
}

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	for (const kind of sentinelsToAppend(question)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}

export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
	`Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.`,
	`Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. The "Type something." row is appended to every question; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column. If you recommend a specific option, make that the first option and append "(Recommended)" to its label.`,
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "Ask User Question",
		description: `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. The "Type something." row is available on every question, including when options carry a \`preview\`; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = params as unknown as QuestionParams;
			if (!ctx.hasUI) return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });

			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}

			// Emit event for external listeners (e.g., notification plugins)
			emitAskUserPromptEvent(pi, typed);

			// RPC hosts (VSCode pendant, ACP clients like Zed/Paseo — issue #78):
			// ui.custom() cannot render there, but the select/input dialog
			// sub-protocol works. Hosts that advertise ctx.mode (pi ≥0.79) route to
			// the sequential dialog walker up front, skipping the TUI render-graph
			// import entirely; RPC builds that predate ctx.mode are caught by the
			// custom()-resolved-undefined backstop below. See ./rpc-fallback.ts.
			if ((ctx as { mode?: string }).mode === "rpc" && hasDialogUI(ctx.ui)) {
				return buildQuestionnaireResponse(await runRpcQuestionnaire(ctx.ui, typed), typed);
			}

			const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));

			// Lazy — QuestionnaireSession pulls the ~560ms view/TUI render graph;
			// load it only when the tool runs, not at extension registration.
			const sessionLoad = await loadQuestionnaireSession();
			if (!sessionLoad.ok) {
				return buildToolResult(sessionLoad.message, { answers: [], cancelled: true, error: sessionLoad.error });
			}
			const { QuestionnaireSession } = sessionLoad.module;
			// Resolve the collapse/expand key spec from config. Default is `ctrl+]`; users
			// with non-US layouts (e.g. Latin American, where `]` is shifted) can override
			// via the `collapseKey` config field. `resolveCollapseKey` also accepts the
			// sentinel value `"off"` to disable the shortcut entirely.
			const collapseKey = resolveCollapseKey(loadConfig());

			// Capture the overlay handle so the session can call `setHidden()` when the
			// user toggles collapse, and register a raw terminal input listener for the
			// same key so the toggle still works while the overlay is hidden (pi-tui does
			// not route input to a hidden overlay's `component.handleInput`).
			const sessionRef: {
				current: import("./state/questionnaire-session.js").QuestionnaireSession | null;
			} = { current: null };
			const overlayHandleRef: { current: import("@earendil-works/pi-tui").OverlayHandle | undefined } = {
				current: undefined,
			};
			let hasAnnouncedHide = false;
			let removeOverlayInputListener: (() => void) | undefined;

			if (collapseKey !== "off" && typeof ctx.ui.onTerminalInput === "function") {
				removeOverlayInputListener = ctx.ui.onTerminalInput((data) => {
					const handle = overlayHandleRef.current;
					if (!handle) return undefined;
					// Only act while the questionnaire is hidden (its handleInput is
					// unreachable) or actually focused. When some other overlay is on
					// top (e.g. `/btw`), leave the keystroke to that overlay instead of
					// toggling the questionnaire from underneath it.
					if (!handle.isHidden() && !handle.isFocused()) return undefined;
					if (!matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])) return undefined;
					sessionRef.current?.toggleCollapsedExternal();
					if (handle.isHidden() && !hasAnnouncedHide) {
						hasAnnouncedHide = true;
						ctx.ui.notify?.(`ask_user_question hidden — press ${collapseKey} to reopen`, "info");
					}
					return { consume: true };
				});
			}

			try {
				const result = await ctx.ui.custom<QuestionnaireResult>(
					(tui, theme, _kb, done) => {
						const session = new QuestionnaireSession({
							tui,
							theme,
							params: typed,
							itemsByTab,
							done,
							collapseKey,
						});
						sessionRef.current = session;
						return session.component;
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "bottom-center",
							width: "100%",
							maxHeight: "100%",
							margin: { left: 0, right: 0, bottom: 0 },
						},
						onHandle: (handle) => {
							overlayHandleRef.current = handle;
							sessionRef.current?.setOverlayHandle(handle);
						},
					},
				);

				// A TUI questionnaire ALWAYS resolves a QuestionnaireResult (cancel
				// included — state-reducer emits `{ answers, cancelled }`), so
				// `undefined` uniquely means "host cannot render", never "user
				// declined". RPC builds that predate ctx.mode land here: run the
				// dialog walker when the host has the primitives; otherwise tell the
				// model the user never saw the questions.
				if (result === undefined) {
					if (hasDialogUI(ctx.ui)) {
						return buildQuestionnaireResponse(await runRpcQuestionnaire(ctx.ui, typed), typed);
					}
					return buildToolResult(ERROR_NO_CUSTOM_UI, { answers: [], cancelled: true, error: "no_custom_ui" });
				}

				return buildQuestionnaireResponse(result, typed);
			} finally {
				removeOverlayInputListener?.();
			}
		},
	});

	// Pre-warm the lazy session graph once startup settles (#107). A graph
	// evaluated while the paths Pi resolved at boot still exist stays in memory
	// for the process lifetime, so later on-disk dependency churn (e.g. `pnpm
	// install --force` replacing the store mid-session) can no longer poison
	// jiti's graph cache. Swallowed failure is safe: the first real call
	// re-imports and surfaces it through loadQuestionnaireSession's structured
	// envelope. unref keeps the timer from holding a non-TUI embedder's process
	// open.
	const timer = setTimeout(() => void loadQuestionnaireSession().catch(() => undefined), PREWARM_DELAY_MS);
	timer.unref?.();
}

export { buildQuestionnaireResponse, buildToolResult };
