import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ASK_USER_ANSWER_EVENT,
	ASK_USER_ANSWER_RESULT_EVENT,
	type AskUserAnswerRejectCode,
	type AskUserAnswerResultEventPayload,
} from "./events.ts";
import { resolveExternalAnswer } from "./tool/external-answer.ts";
import type { QuestionData, QuestionnaireResult } from "./tool/types.ts";

/** "rpc" while the RPC dialog walker owns the prompts — those cannot be answered from outside. */
export type AnswerHost = "tui" | "rpc";

/**
 * One questionnaire an inbound `rpiv:ask-user:answer` may resolve, opened by `execute()`
 * before its prompt event goes out and closed in its `finally`. Both answer sources —
 * the dialog's own `done` and the inbound event — go through `settle`, so the first
 * wins and a later one is refused instead of reported as applied.
 */
export class OpenQuestionnaire {
	private result: QuestionnaireResult | undefined;
	private deliver: ((result: QuestionnaireResult) => void) | undefined;
	private resolveEarly!: (result: QuestionnaireResult) => void;
	/** Resolves with an answer accepted while no dialog was mounted to take it. */
	readonly answeredEarly = new Promise<QuestionnaireResult>((resolve) => {
		this.resolveEarly = resolve;
	});

	constructor(
		readonly toolCallId: string,
		readonly questions: readonly QuestionData[],
		public host: AnswerHost,
	) {}

	/** The accepted result, once settled. */
	get settled(): QuestionnaireResult | undefined {
		return this.result;
	}

	/** Hand over the mounted dialog's `done`; answers from now on close the dialog through it. */
	attach(done: (result: QuestionnaireResult) => void): void {
		this.deliver = done;
	}

	/** First answer wins. False when this questionnaire is already settled. */
	settle(result: QuestionnaireResult): boolean {
		if (this.result) return false;
		this.result = result;
		if (this.deliver) this.deliver(result);
		else this.resolveEarly(result);
		return true;
	}
}

export interface AnswerChannel {
	open(toolCallId: string, questions: readonly QuestionData[], host: AnswerHost): OpenQuestionnaire;
	close(questionnaire: OpenQuestionnaire): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Listen for `rpiv:ask-user:answer` and answer every attempt on `rpiv:ask-user:answer-result`.
 * Open questionnaires are keyed by tool-call id: Pi runs tool calls in parallel, so several
 * can be open at once and the emitter must name the one it answers.
 */
export function registerAnswerChannel(pi: ExtensionAPI): AnswerChannel {
	const open = new Map<string, OpenQuestionnaire>();

	pi.events.on(ASK_USER_ANSWER_EVENT, (data: unknown) => {
		const payload = isRecord(data) ? data : {};
		const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
		const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
		const reply = (code?: AskUserAnswerRejectCode, reason?: string) => {
			const verdict: AskUserAnswerResultEventPayload = {
				ok: code === undefined,
				...(code ? { code, reason } : {}),
				...(requestId !== undefined ? { requestId } : {}),
				...(toolCallId !== undefined ? { toolCallId } : {}),
			};
			pi.events.emit(ASK_USER_ANSWER_RESULT_EVENT, verdict);
		};

		if (!isRecord(data)) return reply("invalid_payload", "payload must be an object");
		if (payload.requestId !== undefined && requestId === undefined) {
			return reply("invalid_payload", "requestId must be a string");
		}
		if (toolCallId === undefined) return reply("invalid_payload", "toolCallId must be a string");
		const target = open.get(toolCallId);
		if (!target || target.settled) return reply("not_found", `no open questionnaire for tool call ${toolCallId}`);
		if (target.host === "rpc") return reply("unsupported_host", "this host shows the questions in its own dialogs");

		const outcome = resolveExternalAnswer(target.questions, payload);
		if (!outcome.ok) return reply(outcome.code, outcome.reason);
		if (!target.settle(outcome.result)) return reply("not_found", `tool call ${toolCallId} is already answered`);
		reply();
	});

	return {
		open(toolCallId, questions, host) {
			const questionnaire = new OpenQuestionnaire(toolCallId, questions, host);
			open.set(toolCallId, questionnaire);
			return questionnaire;
		},
		close(questionnaire) {
			if (open.get(questionnaire.toolCallId) === questionnaire) open.delete(questionnaire.toolCallId);
		},
	};
}
