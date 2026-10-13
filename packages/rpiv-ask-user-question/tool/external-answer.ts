import type { AskUserAnswerRejectCode } from "../events.ts";
import type { QuestionAnswer, QuestionData, QuestionnaireResult } from "./types.ts";

export type ExternalAnswerOutcome =
	| { ok: true; result: QuestionnaireResult }
	| { ok: false; code: AskUserAnswerRejectCode; reason: string };

const reject = (code: AskUserAnswerRejectCode, reason: string): ExternalAnswerOutcome => ({ ok: false, code, reason });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A note as the TUI stores it: trimmed, and absent when blank (`notesExitHandler`). */
function noteOf(v: string | undefined): string | undefined {
	const trimmed = v?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Turn an inbound `rpiv:ask-user:answer` payload (`AskUserAnswerEventPayload`, still
 * untrusted) into the `QuestionnaireResult` the dialog would have produced. Pure of
 * `(questions, payload)`. Answers are shaped as the reducer shapes them — preview
 * attached to a picked single-select option, multi-select labels in authored order
 * with custom text in `answer`, notes trimmed — so the envelope and `details` are the
 * same whether the user typed or a program answered.
 *
 * Strict by design: the contract can be relaxed later without breaking emitters,
 * never tightened. `invalid_payload` is a wrong shape or type, `invalid_answer` a
 * well-formed answer that does not fit these questions.
 */
export function resolveExternalAnswer(
	questions: readonly QuestionData[],
	payload: Record<string, unknown>,
): ExternalAnswerOutcome {
	const { answers, globalNote, cancel } = payload;
	if (cancel !== undefined && typeof cancel !== "boolean")
		return reject("invalid_payload", "cancel must be a boolean");
	if (globalNote !== undefined && typeof globalNote !== "string") {
		return reject("invalid_payload", "globalNote must be a string");
	}
	const note = noteOf(globalNote);
	const withNote = note ? { globalNote: note } : {};

	if (cancel === true) {
		if (answers !== undefined && !(Array.isArray(answers) && answers.length === 0)) {
			return reject("invalid_payload", "cancel takes no answers");
		}
		return { ok: true, result: { answers: [], cancelled: true, ...withNote } };
	}
	if (!Array.isArray(answers)) return reject("invalid_payload", "answers must be an array");

	const byQuestion = new Map<number, Record<string, unknown>>();
	for (const entry of answers) {
		if (!isRecord(entry)) return reject("invalid_payload", "each answer must be an object");
		const index = entry.questionIndex;
		if (!Number.isInteger(index)) return reject("invalid_payload", "questionIndex must be an integer");
		const i = index as number;
		if (i < 0 || i >= questions.length) {
			return reject("invalid_answer", `questionIndex ${i} out of range (0..${questions.length - 1})`);
		}
		if (byQuestion.has(i)) return reject("invalid_answer", `question ${i} answered twice`);
		byQuestion.set(i, entry);
	}

	const resolved: QuestionAnswer[] = [];
	for (let i = 0; i < questions.length; i++) {
		const entry = byQuestion.get(i);
		if (!entry) return reject("invalid_answer", `no answer for question ${i} ("${questions[i]!.header}")`);
		const answer = resolveEntry(questions[i]!, i, entry);
		if (!answer.ok) return answer;
		resolved.push(answer.answer);
	}
	return { ok: true, result: { answers: resolved, cancelled: false, ...withNote } };
}

function resolveEntry(
	q: QuestionData,
	i: number,
	entry: Record<string, unknown>,
): { ok: true; answer: QuestionAnswer } | Extract<ExternalAnswerOutcome, { ok: false }> {
	const { optionIndexes, text, notes } = entry;
	if (optionIndexes !== undefined && (!Array.isArray(optionIndexes) || !optionIndexes.every(Number.isInteger))) {
		return {
			ok: false,
			code: "invalid_payload",
			reason: `question ${i}: optionIndexes must be an array of integers`,
		};
	}
	if (text !== undefined && typeof text !== "string") {
		return { ok: false, code: "invalid_payload", reason: `question ${i}: text must be a string` };
	}
	if (notes !== undefined && typeof notes !== "string") {
		return { ok: false, code: "invalid_payload", reason: `question ${i}: notes must be a string` };
	}

	const invalid = (reason: string) => ({
		ok: false as const,
		code: "invalid_answer" as const,
		reason: `question ${i}: ${reason}`,
	});
	const picked = (optionIndexes ?? []) as number[];
	const out = picked.find((n) => n < 0 || n >= q.options.length);
	if (out !== undefined) return invalid(`option index ${out} out of range (0..${q.options.length - 1})`);
	if (new Set(picked).size !== picked.length) return invalid("option index repeated");
	if (text !== undefined && text.trim().length === 0) return invalid("text is blank");
	if (picked.length === 0 && text === undefined) return invalid("needs optionIndexes or text");

	const base = { questionIndex: i, question: q.question };
	const note = noteOf(notes as string | undefined);
	const withNote = note ? { notes: note } : {};

	if (q.multiSelect) {
		const selected = q.options.filter((_o, n) => picked.includes(n)).map((o) => o.label);
		return {
			ok: true,
			answer: { ...base, kind: "multi", answer: (text as string | undefined) ?? null, selected, ...withNote },
		};
	}
	if (picked.length > 0 && text !== undefined) return invalid("single-select takes optionIndexes or text, not both");
	if (picked.length > 1) return invalid(`single-select takes one option, got ${picked.length}`);
	if (text !== undefined)
		return { ok: true, answer: { ...base, kind: "custom", answer: text as string, ...withNote } };
	const option = q.options[picked[0]!]!;
	const withPreview = option.preview && option.preview.length > 0 ? { preview: option.preview } : {};
	return { ok: true, answer: { ...base, kind: "option", answer: option.label, ...withPreview, ...withNote } };
}
