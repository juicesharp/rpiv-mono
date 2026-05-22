import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, validateGuidanceFields } from "./config.js";
import { displayLabel } from "./state/i18n-bridge.js";
import { QuestionnaireSession } from "./state/questionnaire-session.js";
import { sentinelsToAppend } from "./state/row-intent.js";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.js";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionData,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
} from "./tool/types.js";
import { validateQuestionnaire } from "./tool/validate-questionnaire.js";
import type { WrappingSelectItem } from "./view/components/wrapping-select.js";

/**
 * Event name emitted before the questionnaire is shown to the user.
 * Listeners (e.g., notification plugins) can use this to alert the
 * user that a question awaits their input.
 */
const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt" as const;

/** Payload for the `rpiv:ask-user:prompt` event emitted before showing the questionnaire. */
export interface AskUserPromptEventPayload {
	/** First question text. Appends "(+N more)" when multiple questions. */
	question: string;
	/** Comma-separated option labels from the first question. */
	context: string;
	/** Total options across all questions. */
	optionCount: number;
	/** Whether any question is multi-select. */
	allowMultiple: boolean;
	/** Always true — "Type something." is always available. */
	allowFreeform: boolean;
}

function emitAskUserPromptEvent(pi: ExtensionAPI, params: QuestionParams): void {
	const firstQ = params.questions[0];
	const questionText =
		params.questions.length > 1 ? `${firstQ.question} (+${params.questions.length - 1} more)` : firstQ.question;

	const payload: AskUserPromptEventPayload = {
		question: questionText,
		context: firstQ.options.map((o) => o.label).join(", "),
		optionCount: params.questions.reduce((sum, q) => sum + q.options.length, 0),
		allowMultiple: params.questions.some((q) => q.multiSelect),
		allowFreeform: true,
	};

	try {
		pi.events.emit(ASK_USER_PROMPT_EVENT, payload);
	} catch {
		// Non-blocking: no listeners or event bus error is harmless.
	}
}

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	const hasAnyPreview = question.options.some((o) => typeof o.preview === "string" && o.preview.length > 0);
	for (const kind of sentinelsToAppend(question, hasAnyPreview)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}

export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
	`Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer ("Type something." row is appended automatically to single-select questions) or pick "Chat about this" to abandon the questionnaire.`,
	`Set multiSelect: true when multiple answers are valid; this suppresses the "Type something." row. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. NOTE: any non-empty preview on a single-select question ALSO suppresses the "Type something." row (no room in the side-by-side layout); "Chat about this" remains the escape hatch. If you recommend a specific option, make it the first option and append "(Recommended)" to its label.`,
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description: `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users will always be able to type a custom answer ("Type something." row is appended automatically to every single-select question) or pick "Chat about this" to abandon the questionnaire and continue in free-form conversation. Do NOT author "Other" / "Type something." / "Chat about this" labels yourself — duplicates are rejected at runtime.
- Use multiSelect: true to allow multiple answers to be selected for a question. The "Type something." row is suppressed on multi-select questions, and is ALSO suppressed on single-select questions where any option carries a \`preview\` (the side-by-side layout has no room for inline custom text — "Chat about this" remains as the free-form escape hatch).
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

			const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));

			const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				const session = new QuestionnaireSession({
					tui,
					theme,
					params: typed,
					itemsByTab,
					done,
				});
				return session.component;
			});

			return buildQuestionnaireResponse(result, typed);
		},
	});
}

export { buildQuestionnaireResponse, buildToolResult };
