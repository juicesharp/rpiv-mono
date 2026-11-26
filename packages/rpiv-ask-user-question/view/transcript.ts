import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { t } from "../state/i18n-bridge.ts";
import { NO_INPUT_PLACEHOLDER } from "../tool/format-answer.ts";
import { prepareQuestionArguments } from "../tool/normalize-params.ts";
import {
	isQuestionnaireResult,
	type QuestionAnswer,
	type QuestionnaireResult,
	type QuestionParams,
} from "../tool/types.ts";
import { stripFenceMarkers } from "./components/preview/preview-box-renderer.ts";

const INDENT = "  ";
const COLUMN_GAP = "  ";
const RECOMMENDED_SUFFIX = /\s*\(Recommended\)$/;

type ToolResultView = { content: ReadonlyArray<{ type: string; text?: string }>; details?: unknown };

/** The part of a recorded question the transcript draws. */
type RecordedQuestion = { header: string; question: string | undefined };

/**
 * The questions as the session recorded them. Pi decodes a provider's double-encoded
 * `questions` before the tool runs (#244), but a replayed session hands the renderers
 * the raw recorded arguments, so they are decoded again here. A shape that is still
 * not an array draws as no questions, and an element that is not a question keeps its
 * slot (answers point at questions by index) with an empty header, so a malformed
 * transcript cannot throw out of the render path.
 */
function recordedQuestions(args: unknown): RecordedQuestion[] {
	const questions: unknown = prepareQuestionArguments(args ?? {})?.questions;
	if (!Array.isArray(questions)) return [];
	return questions.map((q) => {
		const fields = typeof q === "object" && q !== null ? (q as Record<string, unknown>) : {};
		return {
			header: typeof fields.header === "string" ? fields.header : "",
			question: typeof fields.question === "string" ? fields.question : undefined,
		};
	});
}

/**
 * Lines laid out at render time, so wrapping and truncation follow the terminal width.
 * Every line is clamped to the width: Pi stops the whole TUI on a line wider than the
 * terminal, so no receipt branch may hand it one.
 */
class WidthLines implements Component {
	constructor(private readonly layout: (width: number) => string[]) {}
	render(width: number): string[] {
		return this.layout(width).map((line) => truncateToWidth(line, width, "…"));
	}
	invalidate(): void {}
}

/** `Ask Format · Migration`: the headers name the questions. */
export function renderAskCall(args: QuestionParams | undefined, theme: Theme): Component {
	const headers = recordedQuestions(args)
		.map((q) => q.header)
		.filter(Boolean);
	const title = theme.fg("toolTitle", theme.bold("Ask"));
	const text = headers.length > 0 ? `${title} ${theme.fg("accent", headers.join(" · "))}` : title;
	return new WidthLines(() => [text]);
}

/**
 * The transcript receipt: one `✓ answer` line for a single question, an aligned
 * header/answer table for several. A failure shows `✗` with the first line of the
 * model-facing message; a declined questionnaire shows a dimmed `✗ no answer`.
 */
export function renderAskResult(
	result: ToolResultView,
	args: QuestionParams | undefined,
	theme: Theme,
	options: { expanded: boolean; isError: boolean },
): Component {
	const details = isQuestionnaireResult(result.details) ? result.details : undefined;
	if (options.isError || details?.error) {
		return new WidthLines(() => [theme.fg("error", `✗ ${firstTextLine(result)}`)]);
	}
	if (!details) return new WidthLines(() => [theme.fg("success", "✓")]);
	if (details.cancelled) {
		return new WidthLines(() => [theme.fg("dim", `✗ ${t("transcript.no_answer", "no answer")}`)]);
	}
	const questions = recordedQuestions(args);
	return new WidthLines((width) =>
		questions.length > 1
			? tableLines(details, questions, theme, options.expanded, width)
			: singleLines(details, questions[0]?.question, theme, options.expanded, width),
	);
}

function singleLines(
	details: QuestionnaireResult,
	questionText: string | undefined,
	theme: Theme,
	expanded: boolean,
	width: number,
): string[] {
	const answer = details.answers[0];
	const lines = hanging(`${theme.fg("success", "✓")} `, answerText(answer, theme), width);
	lines.push(...detailLines(answer, expanded ? questionText : undefined, INDENT, theme, width));
	return [...lines, ...globalNoteLines(details, theme, width)];
}

function tableLines(
	details: QuestionnaireResult,
	questions: readonly RecordedQuestion[],
	theme: Theme,
	expanded: boolean,
	width: number,
): string[] {
	const headerWidth = Math.max(...questions.map((q) => visibleWidth(q.header)));
	const answerIndent = " ".repeat(INDENT.length + headerWidth + COLUMN_GAP.length);
	const lines = questions.flatMap((q, i) => {
		const answer = details.answers.find((a) => a.questionIndex === i);
		const header = q.header + " ".repeat(headerWidth - visibleWidth(q.header));
		const row = hanging(`${INDENT}${theme.fg("muted", header)}${COLUMN_GAP}`, answerText(answer, theme), width);
		return [...row, ...detailLines(answer, expanded ? q.question : undefined, answerIndent, theme, width)];
	});
	return [...lines, ...globalNoteLines(details, theme, width)];
}

/** Under an answer: the question text and chosen preview when expanded, then the answer's note. */
function detailLines(
	answer: QuestionAnswer | undefined,
	questionText: string | undefined,
	indent: string,
	theme: Theme,
	width: number,
): string[] {
	const lines: string[] = [];
	if (questionText) lines.push(...hanging(indent, theme.fg("dim", questionText), width));
	if (questionText && answer?.preview) {
		for (const line of stripFenceMarkers(answer.preview.split("\n"))) {
			lines.push(truncateToWidth(`${indent}${theme.fg("dim", `│ ${line}`)}`, width, "…"));
		}
	}
	if (answer?.notes) lines.push(...hanging(indent, theme.fg("dim", `✎ ${answer.notes}`), width));
	return lines;
}

function globalNoteLines(details: QuestionnaireResult, theme: Theme, width: number): string[] {
	return details.globalNote ? hanging(INDENT, theme.fg("dim", `✎ ${details.globalNote}`), width) : [];
}

function answerText(answer: QuestionAnswer | undefined, theme: Theme): string {
	if (!answer) return theme.fg("dim", t("transcript.not_answered", "not answered"));
	const typed = answer.answer ? `"${answer.answer}"` : undefined;
	const picks =
		answer.kind === "option"
			? [label(answer.answer ?? "")]
			: answer.kind === "custom"
				? [typed]
				: [...(answer.selected ?? []).map(label), typed];
	return theme.fg("toolOutput", picks.filter(Boolean).join(", ") || NO_INPUT_PLACEHOLDER);
}

function label(text: string): string {
	return text.replace(RECOMMENDED_SUFFIX, "");
}

/** `prefix` then `text` wrapped to the width left after it; continuation lines align under the text. */
function hanging(prefix: string, text: string, width: number): string[] {
	const indent = visibleWidth(prefix);
	return wrapTextWithAnsi(text, Math.max(1, width - indent)).map(
		(line, i) => (i === 0 ? prefix : " ".repeat(indent)) + line,
	);
}

function firstTextLine(result: ToolResultView): string {
	const text = result.content.find((c) => c.type === "text")?.text ?? "";
	return text.split("\n")[0] ?? "";
}
