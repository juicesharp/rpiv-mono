import type { QuestionParams } from "./types.js";

/**
 * Normalize line terminators in one model-supplied text field (#192).
 *
 * Some models serialize a bare carriage return inside tool-call string
 * arguments at token boundaries where the text was meant to be contiguous
 * (`GEMBA\r_LOG\r_FILE` for `GEMBA_LOG_FILE`). A raw CR is a cursor-control
 * byte, not text: pi-tui ≤0.80 writes it straight into the row, so the
 * terminal returns to column 0 and later text overwrites the pointer and
 * number; pi-tui ≥0.84 splits `wrapTextWithAnsi` on `\r`, so one option
 * fragments into stacked rows. Both symptoms have the same fix at our
 * boundary:
 *
 * - `\r\n` → `\n` keeps genuine multi-line content (preview markdown) intact.
 * - a lone `\r` is deleted — never a space (phantom gaps inside words) and
 *   never `\n` (reintroduces the vertical fragmentation). This matches
 *   pi-coding-agent's own display normalization (`normalizeDisplayText`).
 */
export function normalizeLineTerminators(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

/**
 * Copy `obj`, normalizing the listed keys that hold strings. Keys absent from
 * `obj` (e.g. an omitted `preview`) stay absent so `"preview" in option`
 * checks and `hasPreview` derivations are unchanged.
 */
function normalizeStringFields<T extends object>(obj: T, keys: readonly (keyof T)[]): T {
	const out = { ...obj };
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "string") out[key] = normalizeLineTerminators(value) as T[typeof key];
	}
	return out;
}

/**
 * Return a copy of the tool params with every user-facing string field
 * (`question`, `header`, `options[].label`, `options[].description`,
 * `options[].preview`) line-terminator-normalized. Runs once at tool entry,
 * BEFORE `validateQuestionnaire`, so the reserved-label and duplicate-label
 * guards compare the text the user will actually see (`"Other\r"` must not
 * slip past `reserved_label`), and so the TUI, the RPC dialog walker, the
 * envelope echo, and the `rpiv:ask-user:prompt` payload all carry the same
 * clean text. Pure: the input object is never mutated.
 */
export function normalizeQuestionParams(params: QuestionParams): QuestionParams {
	return {
		...params,
		questions: params.questions.map((q) => ({
			...normalizeStringFields(q, ["question", "header"]),
			options: q.options.map((o) => normalizeStringFields(o, ["label", "description", "preview"])),
		})),
	};
}

/**
 * Pi's `prepareArguments` hook: undo double-encoded tool arguments before schema
 * validation (#244). Some tool-call parsers (vLLM/LiteLLM-served GLM/Qwen-class
 * models) intermittently emit nested structures as JSON strings — `questions` itself,
 * or its elements (`questions.0: must be object`). Only a string at an array/object
 * position is decoded, and only when it parses to the expected shape; anything else is
 * passed through untouched so validation still reports the real problem. The same
 * applies one level down to `options`. Well-formed arguments are returned as-is.
 */
export function prepareQuestionArguments(args: unknown): QuestionParams {
	if (!isRecord(args)) return args as QuestionParams;
	const questions = decodeArray(args.questions);
	if (!Array.isArray(questions)) return args as QuestionParams;
	const decoded = questions.map((q) => {
		const question = decodeObject(q);
		if (!isRecord(question)) return question;
		const options = decodeArray(question.options);
		return Array.isArray(options) ? { ...question, options: options.map(decodeObject) } : question;
	});
	return { ...args, questions: decoded } as unknown as QuestionParams;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON string holding an array → that array; anything else unchanged. */
function decodeArray(value: unknown): unknown {
	const parsed = typeof value === "string" ? parseJson(value) : value;
	return Array.isArray(parsed) ? parsed : value;
}

/** A JSON string holding an object → that object; anything else unchanged. */
function decodeObject(value: unknown): unknown {
	const parsed = typeof value === "string" ? parseJson(value) : value;
	return isRecord(parsed) ? parsed : value;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
