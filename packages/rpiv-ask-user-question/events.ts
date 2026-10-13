/**
 * Public event contract for @juicesharp/rpiv-ask-user-question.
 *
 * STABILITY POLICY — applies to every event in the `rpiv:*` namespace.
 *
 *   1. Channel names are immutable. Once shipped, never rename.
 *   2. Payload changes are append-only. Listeners MUST tolerate unknown
 *      fields. New fields ship as optional (`?:`).
 *   3. Breaking changes (rename, retype, remove a field; change emission
 *      semantics) require a NEW channel, e.g. `rpiv:ask-user:prompt.v2`,
 *      with dual-emit during a deprecation window.
 *   4. No `version` field inside payloads. Version via channel name only.
 *   5. Payloads must be JSON-safe: primitives, arrays, plain objects.
 *      No Set/Map/Date/class instances — payloads must survive JSON
 *      serialization when listeners forward them across process or
 *      network boundaries.
 *
 * Naming: `rpiv:<package-or-tool>:<phase>`, lowercase, hyphen-separated.
 * Aligns with Pi's `"my-extension:status"` example and UniPi's `unipi:*`.
 */

export const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt" as const;

export interface AskUserPromptEventPayload {
	questions: ReadonlyArray<AskUserPromptQuestion>;
	/**
	 * The tool call's id — always set. Names this questionnaire on
	 * `ASK_USER_BLOCKED_EVENT` and `ASK_USER_ANSWER_EVENT`.
	 */
	toolCallId?: string;
}

/**
 * Emitted while the questionnaire is awaiting user input (TUI `ui.custom` and
 * RPC dialog walker). Cleared with `{ active: false }` in `finally` so listeners
 * can distinguish blocked-on-human from working.
 */
export const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked" as const;

export interface AskUserBlockedEventPayload {
	/** True while input is awaited; false when the wait ends (answer, cancel, or error). */
	active: boolean;
	/**
	 * The tool call's id — always set. Several questionnaires can be open at once,
	 * so pair `active: false` with the prompt it closes by this id.
	 */
	toolCallId?: string;
}

export interface AskUserPromptQuestion {
	/**
	 * The full question text as the agent authored it, with line terminators
	 * normalized at tool entry (`\r\n` → `\n`, lone `\r` removed — #192). The
	 * same normalization applies to `header` and every option field below.
	 */
	question: string;
	/** The short chip/tag shown next to the question. */
	header: string;
	/** True iff the user may pick multiple options. Normalized from optional. */
	multiSelect: boolean;
	options: ReadonlyArray<AskUserPromptOption>;
}

export interface AskUserPromptOption {
	label: string;
	description: string;
	/** True iff the option carries rich preview content (content not shipped). */
	hasPreview: boolean;
}

/**
 * INBOUND — the only event in this contract the package listens for rather than
 * emits. Answers (or cancels) one open questionnaire without the TUI keystroke
 * path, so a program driving Pi from outside — a pane supervisor, a phone or web
 * bridge, a test harness — need not synthesize keys against a rendered dialog.
 *
 * `toolCallId` names the questionnaire: the id carried by its
 * `ASK_USER_PROMPT_EVENT`. It is accepted from the moment that prompt is emitted
 * (before the dialog is on screen) until the questionnaire closes; the first
 * answer wins, whether typed in the terminal or sent here.
 *
 * Validation is strict and all-or-nothing: every question answered, every index
 * in range, nothing duplicated — or nothing is applied and the dialog stays open.
 * A partially applied answer would reach the model indistinguishable from one
 * the user gave. Unknown fields are ignored (policy rule 2).
 *
 * Every attempt gets one verdict on `ASK_USER_ANSWER_RESULT_EVENT`; this payload
 * carries no callback because payloads must survive JSON serialization.
 */
export const ASK_USER_ANSWER_EVENT = "rpiv:ask-user:answer" as const;

export interface AskUserAnswerEventPayload {
	/** The questionnaire to answer — `toolCallId` from its prompt event. */
	toolCallId: string;
	/** Echoed back on the verdict so an emitter can pair it with this request. */
	requestId?: string;
	/** One entry per question. Omitted (or empty) only with `cancel`. */
	answers?: ReadonlyArray<AskUserAnswerEntry>;
	/** Note for the whole questionnaire — what `n` on the Submit tab attaches in the TUI. */
	globalNote?: string;
	/** Decline the questionnaire, as Esc does: the model is told the user declined. */
	cancel?: boolean;
}

/**
 * One question's answer. Single-select takes exactly one of `optionIndexes`
 * (one index) or `text`; multi-select takes either or both, like the TUI's
 * checked options plus its `Type something.` row.
 */
export interface AskUserAnswerEntry {
	/** 0-based index into the prompt's `questions`. */
	questionIndex: number;
	/** 0-based, distinct indices into the question's `options`. */
	optionIndexes?: readonly number[];
	/** Custom answer — what the `Type something.` row produces. Must not be blank. */
	text?: string;
	/** Note on this question — what the `n` key attaches in the TUI. */
	notes?: string;
}

/** Verdict for an `ASK_USER_ANSWER_EVENT`. One per attempt, accepted or not. */
export const ASK_USER_ANSWER_RESULT_EVENT = "rpiv:ask-user:answer-result" as const;

/**
 * Why an answer was refused — branch on this, not on `reason`:
 * - `not_found`: no open questionnaire has that `toolCallId` (never opened, or already closed).
 * - `invalid_payload`: a field is missing or has the wrong type.
 * - `invalid_answer`: well-formed, but does not fit the questions (missing, duplicated, out of range).
 * - `unsupported_host`: the questionnaire runs in an RPC host's own dialogs, which cannot be answered here.
 */
export type AskUserAnswerRejectCode = "not_found" | "invalid_payload" | "invalid_answer" | "unsupported_host";

export interface AskUserAnswerResultEventPayload {
	ok: boolean;
	/** Set when `ok` is false. */
	code?: AskUserAnswerRejectCode;
	/** Human-readable detail for logs. Wording may change — do not parse it. */
	reason?: string;
	/** Echoed from the request when it was a string. */
	requestId?: string;
	/** Echoed from the request when it was a string. */
	toolCallId?: string;
}
