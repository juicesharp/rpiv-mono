import type {
	ChoiceQuestion,
	NoulQuestion,
	Questions,
	RequestOptions,
	SystemOneRequest,
	SystemOneResult,
} from "@typesafe-ai/sdk";
import type { ResolvedJevConfig } from "./config.js";
import type {
	JevAutoAnswerDetails,
	JevQuestionEvaluation,
	QuestionAnswer,
	QuestionnaireResult,
	QuestionParams,
} from "./tool/types.js";

type JevQuestion = ChoiceQuestion<Record<string, string>> | NoulQuestion;
type JevQuestions = Record<string, JevQuestion>;

export interface JevClient {
	systemOne(request: SystemOneRequest<Questions>, options?: RequestOptions): Promise<SystemOneResult<Questions>>;
}

export type JevAutoAnswerOutcome =
	| { ok: true; result: QuestionnaireResult }
	| {
			ok: false;
			error: "auto_answer_state_required" | "auto_answer_failed" | "auto_answer_uncertain";
			message: string;
	  };

function choiceQuestionId(questionIndex: number): string {
	return `question_${questionIndex}`;
}

function multiOptionQuestionId(questionIndex: number, optionIndex: number): string {
	return `question_${questionIndex}_option_${optionIndex}`;
}

function optionKey(optionIndex: number): string {
	return `option_${optionIndex}`;
}

/** Build one batched request: Choice per single-select, Noul per multi-select option. */
export function buildJevQuestions(params: QuestionParams): JevQuestions {
	const questions: JevQuestions = {};
	for (let questionIndex = 0; questionIndex < params.questions.length; questionIndex++) {
		const question = params.questions[questionIndex];
		if (!question) continue;
		if (!question.multiSelect) {
			questions[choiceQuestionId(questionIndex)] = {
				type: "choice",
				instructions: `Which option best answers this question? ${question.question}`,
				criteria: Object.fromEntries(
					question.options.map((option, optionIndex) => [
						optionKey(optionIndex),
						`${option.label}: ${option.description}`,
					]),
				),
			};
			continue;
		}

		for (let optionIndex = 0; optionIndex < question.options.length; optionIndex++) {
			const option = question.options[optionIndex];
			if (!option) continue;
			questions[multiOptionQuestionId(questionIndex, optionIndex)] = {
				type: "noul",
				instructions: `For the question "${question.question}", should "${option.label}" be selected as one of the answers?`,
				criteria: {
					true: `Select it: ${option.description}`,
					false: "Do not select this option.",
				},
			};
		}
	}
	return questions;
}

function noulCertainty(probability: number): number {
	return Math.abs(probability - 0.5) * 2;
}

function mapJevResponse(
	params: QuestionParams,
	response: SystemOneResult<Questions>,
	minConfidence: number,
): JevAutoAnswerOutcome {
	const answers: QuestionAnswer[] = [];
	const evaluations: JevQuestionEvaluation[] = [];

	for (let questionIndex = 0; questionIndex < params.questions.length; questionIndex++) {
		const question = params.questions[questionIndex];
		if (!question) continue;
		if (!question.multiSelect) {
			const responseAnswer = response.answers[choiceQuestionId(questionIndex)];
			if (responseAnswer?.type !== "choice") {
				return { ok: false, error: "auto_answer_failed", message: `Jev omitted question ${questionIndex + 1}.` };
			}
			const selectedIndex = Number(responseAnswer.choice.replace(/^option_/, ""));
			const selectedOption = question.options[selectedIndex];
			if (!Number.isInteger(selectedIndex) || !selectedOption) {
				return {
					ok: false,
					error: "auto_answer_failed",
					message: `Jev returned an unknown option for question ${questionIndex + 1}.`,
				};
			}
			if (responseAnswer.confidence < minConfidence) {
				return {
					ok: false,
					error: "auto_answer_uncertain",
					message: `Jev confidence for question ${questionIndex + 1} was ${responseAnswer.confidence.toFixed(2)}, below ${minConfidence.toFixed(2)}.`,
				};
			}
			const probabilities = Object.fromEntries(
				question.options.map((option, optionIndex) => [
					option.label,
					responseAnswer.probabilities[optionKey(optionIndex)] ?? 0,
				]),
			);
			evaluations.push({ questionIndex, confidence: responseAnswer.confidence, probabilities });
			answers.push({
				questionIndex,
				question: question.question,
				kind: "option",
				answer: selectedOption.label,
				...(selectedOption.preview ? { preview: selectedOption.preview } : {}),
			});
			continue;
		}

		const selected: string[] = [];
		const probabilities: Record<string, number> = {};
		let minimumCertainty = 1;
		for (let optionIndex = 0; optionIndex < question.options.length; optionIndex++) {
			const option = question.options[optionIndex];
			if (!option) continue;
			const responseAnswer = response.answers[multiOptionQuestionId(questionIndex, optionIndex)];
			if (responseAnswer?.type !== "noul") {
				return {
					ok: false,
					error: "auto_answer_failed",
					message: `Jev omitted an option for question ${questionIndex + 1}.`,
				};
			}
			probabilities[option.label] = responseAnswer.noul;
			minimumCertainty = Math.min(minimumCertainty, noulCertainty(responseAnswer.noul));
			if (responseAnswer.noul >= 0.5) selected.push(option.label);
		}
		if (minimumCertainty < minConfidence) {
			return {
				ok: false,
				error: "auto_answer_uncertain",
				message: `Jev certainty for question ${questionIndex + 1} was ${minimumCertainty.toFixed(2)}, below ${minConfidence.toFixed(2)}.`,
			};
		}
		evaluations.push({ questionIndex, confidence: minimumCertainty, probabilities });
		answers.push({ questionIndex, question: question.question, kind: "multi", answer: null, selected });
	}

	const autoAnswer: JevAutoAnswerDetails = {
		provider: "typesafe",
		model: response.model,
		evaluations,
		usage: response.usage,
	};
	return { ok: true, result: { answers, cancelled: false, autoAnswer } };
}

async function createDefaultClient(config: ResolvedJevConfig): Promise<JevClient> {
	const { TypeSafeClient } = await import("@typesafe-ai/sdk");
	return new TypeSafeClient({ defaultModel: config.model });
}

/** Run Jev only when explicit state exists; callers own UI/non-UI fallback policy. */
export async function autoAnswerWithJev(
	params: QuestionParams,
	config: ResolvedJevConfig,
	signal?: AbortSignal,
	clientFactory: (config: ResolvedJevConfig) => Promise<JevClient> = createDefaultClient,
): Promise<JevAutoAnswerOutcome> {
	if (!params.state || params.state.trim().length === 0) {
		return {
			ok: false,
			error: "auto_answer_state_required",
			message: "Jev auto-answer requires explicit state in the tool call.",
		};
	}

	try {
		const client = await clientFactory(config);
		const response = await client.systemOne(
			{ state: params.state, model: config.model, questions: buildJevQuestions(params) },
			{ signal },
		);
		return mapJevResponse(params, response, config.minConfidence);
	} catch (error) {
		if (signal?.aborted) throw error;
		const cause = error instanceof Error ? error.message : String(error);
		return { ok: false, error: "auto_answer_failed", message: `Jev auto-answer failed: ${cause}` };
	}
}
