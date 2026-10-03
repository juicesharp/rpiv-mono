import {
	DEFAULT_LIMITS,
	MIN_OPTIONS,
	type QuestionnaireError,
	type QuestionnaireLimits,
	type QuestionParams,
	RESERVED_LABELS,
} from "./types.js";

function tooManyQuestionsMessage(limits: QuestionnaireLimits): string {
	return `Error: At most ${limits.maxQuestions} questions are allowed per invocation`;
}

function tooFewOptionsMessage(): string {
	return `Error: Each question requires at least ${MIN_OPTIONS} options`;
}

export const ERROR_NO_QUESTIONS = "Error: At least one question is required";
export const ERROR_TOO_MANY_QUESTIONS = tooManyQuestionsMessage(DEFAULT_LIMITS);
export const ERROR_DUPLICATE_QUESTION = "Error: Question text must be unique within an invocation";
export const ERROR_TOO_FEW_OPTIONS = tooFewOptionsMessage();
export const ERROR_RESERVED_LABEL = `Error: Option label is reserved (${RESERVED_LABELS.join(", ")})`;
export const ERROR_DUPLICATE_OPTION_LABEL = "Error: Option labels must be unique within a question";

const RESERVED_LABEL_SET: ReadonlySet<string> = new Set(RESERVED_LABELS);

export type ValidationResult = { ok: true } | { ok: false; error: QuestionnaireError; message: string };

/**
 * Pure runtime validator for `QuestionParams`. Covers every guard except
 * `no_ui` (which depends on `ctx.hasUI` and stays inline at the call site).
 * `reserved_label` MUST short-circuit before `duplicate_option_label`.
 */
export function validateQuestionnaire(
	typed: QuestionParams,
	limits: QuestionnaireLimits = DEFAULT_LIMITS,
): ValidationResult {
	if (typed.questions.length === 0) {
		return { ok: false, error: "no_questions", message: ERROR_NO_QUESTIONS };
	}
	if (typed.questions.length > limits.maxQuestions) {
		return { ok: false, error: "too_many_questions", message: tooManyQuestionsMessage(limits) };
	}

	const seenQuestions = new Set<string>();
	for (const q of typed.questions) {
		if (seenQuestions.has(q.question)) {
			return { ok: false, error: "duplicate_question", message: ERROR_DUPLICATE_QUESTION };
		}
		seenQuestions.add(q.question);
	}

	for (const q of typed.questions) {
		if (q.options.length < MIN_OPTIONS) {
			return { ok: false, error: "empty_options", message: tooFewOptionsMessage() };
		}
		const seenLabels = new Set<string>();
		for (const o of q.options) {
			if (RESERVED_LABEL_SET.has(o.label)) {
				return { ok: false, error: "reserved_label", message: ERROR_RESERVED_LABEL };
			}
			if (seenLabels.has(o.label)) {
				return {
					ok: false,
					error: "duplicate_option_label",
					message: ERROR_DUPLICATE_OPTION_LABEL,
				};
			}
			seenLabels.add(o.label);
		}
	}

	return { ok: true };
}
