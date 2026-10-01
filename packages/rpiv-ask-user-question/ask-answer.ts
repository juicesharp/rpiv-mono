/**
 * Programmatic answer channel for the ask_user_question tool.
 *
 * The events contract (`rpiv:ask-user:prompt` / `rpiv:ask-user:blocked`) is
 * read-only by design, and the `done` resolve-callback passed to the
 * `ctx.ui.custom()` factory is trapped inside that closure. This module
 * bridges the gap so extensions that install this package (e.g. a chat
 * bridge) can answer a waiting questionnaire programmatically — identical to
 * the terminal user selecting by hand.
 *
 * RPC-path gap: the slot is registered ONLY on the TUI path, as the first
 * line of the factory `makeSessionFactory` returns (`ask-user-question.ts`).
 * `runRpcPath` and the `resolveUndefinedResult` backstop never register, so
 * on RPC hosts (VS Code pendant, Zed/Paseo ACP) a questionnaire can be
 * waiting while `getActiveAskParams()` returns null — bridge authors must
 * not assume this channel is available there.
 *
 * The pi SDK's `close` implementation carries its own `closed` idempotency
 * gate, so a late answer after the questionnaire already resolved is a
 * natural no-op — no double-answer races. `submitAskUserAnswer` is idempotent
 * for the same reason: once the slot is cleared, late answers return `false`
 * without side effects.
 *
 * State lives on globalThis (Symbol.for key) so multiple module instances of
 * this package — the host's installed extension vs a consumer resolving its
 * own copy — share ONE questionnaire slot, the same cross-instance pattern
 * as `rpiv-advisor/inventory.ts` and `rpiv-workflow/execution-host.ts`.
 * Without the shared slot, each instance would hold a private null and the
 * programmatic answer would always miss.
 */

import { isQuestionnaireResult, type QuestionnaireResult, type QuestionParams } from "./tool/types.js";

type Done = (result: QuestionnaireResult) => void;

/**
 * Opaque handle to one registered questionnaire — returned by
 * `registerActiveAsk`, passed back to `clearActiveAsk`, compared by object
 * identity only ("clear only if still held"), never inspected.
 */
export interface ActiveAsk {
	/** Identity token — opaque, never read. */
	readonly token: symbol;
}

type RegisteredAsk = ActiveAsk & { params: QuestionParams; done: Done };

const ACTIVE_ASK = Symbol.for("@juicesharp/rpiv-ask-user-question:activeAsk");
const store = globalThis as Record<symbol, RegisteredAsk | undefined>;

function get(): RegisteredAsk | undefined {
	return store[ACTIVE_ASK];
}

/**
 * Called by the tool's execute() path — first line of the factory that
 * `makeSessionFactory` returns. Registers the live questionnaire and returns
 * its handle; the caller MUST keep the handle and pass it to `clearActiveAsk`
 * in its `finally`. A later registration replaces an earlier one in the slot
 * (the newest ask is the one a programmatic answer targets), and each handle
 * only ever clears itself.
 */
export function registerActiveAsk(params: QuestionParams, done: Done): ActiveAsk {
	const ask: RegisteredAsk = { token: Symbol(), params, done };
	store[ACTIVE_ASK] = ask;
	return ask;
}

/**
 * Called from execute()'s finally — the questionnaire is over either way.
 * Clears ONLY when the slot still holds the caller's own handle: pi runs
 * tool-call batches in parallel, so an overlapping ask registered after this
 * one must survive the first call's teardown. An undefined handle (the
 * factory never ran — e.g. `ctx.ui.custom` rejected before rendering) clears
 * nothing.
 */
export function clearActiveAsk(ask: ActiveAsk | undefined): void {
	if (ask !== undefined && store[ACTIVE_ASK] === ask) {
		store[ACTIVE_ASK] = undefined;
	}
}

/** True when a questionnaire is waiting (registered and not yet resolved). */
export function hasActiveAsk(): boolean {
	return get() !== undefined;
}

/** Read-only snapshot of the waiting questionnaire's params (null if none). */
export function getActiveAskParams(): QuestionParams | null {
	return get()?.params ?? null;
}

/**
 * Validate submitted answers against the registered params, entry by entry:
 * - every entry MUST be an object with a known `kind`
 * - `questionIndex` MUST be an integer within `[0, questions.length)`
 * - `kind: "option"` — `answer` MUST be a string whose `|`-separated parts
 *   are all valid labels of that question (multi-select answers arrive as
 *   pipe-joined label lists)
 * - `kind: "multi"` — when `selected` is present, every element MUST be a
 *   valid label of that question
 * - `kind: "custom"` — free text; only the index is checked
 *
 * Answers arrive from remote users through bridges, not just from trusted
 * code: a fabricated label would be echoed verbatim into the LLM-facing
 * envelope, and an out-of-range index would throw inside
 * `buildQuestionnaireResponse`. Reject (return false) instead of throwing.
 */
function answersMatchParams(answers: readonly unknown[], params: QuestionParams): boolean {
	for (const entry of answers) {
		if (entry === null || typeof entry !== "object") return false;
		const { kind, questionIndex, answer: answerText, selected } = entry as Record<string, unknown>;
		if (kind !== "option" && kind !== "custom" && kind !== "multi") return false;
		if (typeof questionIndex !== "number" || !Number.isInteger(questionIndex)) return false;
		if (questionIndex < 0 || questionIndex >= params.questions.length) return false;
		const question = params.questions[questionIndex]!;
		if (kind === "option") {
			if (typeof answerText !== "string") return false;
			const labels = new Set(question.options.map((o) => o.label));
			for (const part of answerText.split("|")) {
				if (!labels.has(part)) return false;
			}
		} else if (kind === "multi" && selected !== undefined) {
			if (!Array.isArray(selected)) return false;
			const labels = new Set(question.options.map((o) => o.label));
			for (const label of selected) {
				if (typeof label !== "string" || !labels.has(label)) return false;
			}
		}
	}
	return true;
}

/**
 * Submit an answer to the currently-waiting questionnaire.
 *
 * Returns `true` when the result was handed to the still-open questionnaire
 * (overlay closes, the tool call resolves with the structured result).
 * Returns `false` — without side effects — when there is no active
 * questionnaire, it was already answered (idempotent no-op: the answer
 * arrived too late), or the result fails validation against the registered
 * params (forged labels, out-of-range question index, malformed entries).
 * Cancelled requests skip the per-entry validation (a cancel carries no
 * answers to lie about). Never throws.
 */
export function submitAskUserAnswer(result: QuestionnaireResult): boolean {
	const ask = get();
	if (!ask) return false;
	if (!isQuestionnaireResult(result)) return false;
	if (!result.cancelled && result.answers.length === 0) return false;
	if (!result.cancelled && !answersMatchParams(result.answers, ask.params)) return false;
	store[ACTIVE_ASK] = undefined;
	ask.done(result);
	return true;
}
