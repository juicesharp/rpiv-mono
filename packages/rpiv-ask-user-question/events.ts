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
 * emits. Answers the questionnaire currently awaiting input, bypassing the TUI
 * keystroke path entirely, so a program driving Pi from outside (a pane
 * supervisor, a test harness) does not have to synthesize arrow keys and count
 * rows against a rendered overlay.
 *
 * Ignored when no questionnaire is active. Answers are all-or-nothing: every
 * question must be present and every option index in range, or nothing is
 * submitted — a partially applied answer would reach the model indistinguishable
 * from one the user gave.
 *
 * Emitters get the verdict back on `ASK_USER_ANSWER_RESULT_EVENT`; this payload
 * carries no callback because the stability policy above requires payloads to
 * survive JSON serialization.
 */
export const ASK_USER_ANSWER_EVENT = "rpiv:ask-user:answer" as const;

export interface AskUserAnswerEventPayload {
	answers: ReadonlyArray<ExternalAnswerEntry>;
	/** Echoed back on the result event so an emitter can pair verdict to request. */
	requestId?: string;
}

/**
 * One question's answer. Supply exactly one of `optionIndexes` or `text`:
 * indices pick authored options (single-select takes exactly one), `text` is the
 * custom answer the `Type something.` row would have produced.
 */
export interface ExternalAnswerEntry {
	questionIndex: number;
	/** 0-based indices into the question's authored `options` array. */
	optionIndexes?: readonly number[];
	/** Custom free-text answer. Mutually exclusive with `optionIndexes`. */
	text?: string;
	/** Optional note, equivalent to what the `n` key attaches in the TUI. */
	notes?: string;
}

/** Verdict for an `ASK_USER_ANSWER_EVENT`. Always emitted, accepted or not. */
export const ASK_USER_ANSWER_RESULT_EVENT = "rpiv:ask-user:answer-result" as const;

export interface AskUserAnswerResultEventPayload {
	ok: boolean;
	/** Why the answer was rejected. Absent when `ok` is true. */
	reason?: string;
	requestId?: string;
}
