import { createMockCtx, createMockPi, makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import { ASK_USER_ANSWER_EVENT, ASK_USER_ANSWER_RESULT_EVENT, type AskUserAnswerResultEventPayload } from "./events.js";

/**
 * Integration tests for the inbound answer event: an emitter outside the TUI
 * resolving the questionnaire without synthesizing keystrokes. `createMockPi`
 * ships an `events.on` stub that never invokes handlers, so these tests swap in
 * a real bus — the whole point is that emitting reaches the listener.
 */

function makeBus() {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	return {
		emitted,
		events: {
			on: vi.fn((channel: string, handler: (data: unknown) => void) => {
				const list = handlers.get(channel) ?? [];
				list.push(handler);
				handlers.set(channel, list);
				return () => {};
			}),
			emit: vi.fn((channel: string, data: unknown) => {
				emitted.push({ channel, data });
				for (const handler of handlers.get(channel) ?? []) handler(data);
			}),
		},
	};
}

const params = {
	questions: [
		{
			question: "Which?",
			header: "Pick",
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		},
	],
};

/**
 * Registers the tool against a live bus and starts `execute`. `ui.custom` here
 * builds the real QuestionnaireSession and hands its `done` to the component,
 * never resolving on its own — exactly like the TUI overlay, so the only way
 * the returned promise settles is an inbound answer event.
 */
function runQuestionnaire() {
	const bus = makeBus();
	const { pi, captured } = createMockPi({ events: bus.events } as never);
	registerAskUserQuestionTool(pi);

	const custom = vi.fn(
		async (factory: (...args: unknown[]) => unknown) =>
			await new Promise((resolve) => {
				void factory(
					{ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() },
					makeTheme(),
					{ matches: () => false },
					resolve,
				);
			}),
	);
	const ctx = createMockCtx({
		hasUI: true,
		mode: "tui",
		ui: { custom, onTerminalInput: vi.fn(() => () => {}) } as never,
	});

	const tool = captured.tools.get("ask_user_question")!;
	const settle = tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
	return { bus, settle };
}

function resultsOn(bus: ReturnType<typeof makeBus>): AskUserAnswerResultEventPayload[] {
	return bus.emitted
		.filter((e) => e.channel === ASK_USER_ANSWER_RESULT_EVENT)
		.map((e) => e.data as AskUserAnswerResultEventPayload);
}

describe("ask_user_question — inbound answer event", () => {
	it("resolves the questionnaire and echoes the requestId", async () => {
		const { bus, settle } = runQuestionnaire();
		await vi.waitFor(() => expect(bus.emitted.some((e) => e.channel === "rpiv:ask-user:blocked")).toBe(true));

		bus.events.emit(ASK_USER_ANSWER_EVENT, {
			requestId: "r1",
			answers: [{ questionIndex: 0, optionIndexes: [1] }],
		});

		const result = await settle;
		expect(result?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="B"') });
		expect(resultsOn(bus)).toContainEqual({ ok: true, requestId: "r1" });
	});

	it("reports why an answer was rejected and leaves the questionnaire open", async () => {
		const { bus, settle } = runQuestionnaire();
		await vi.waitFor(() => expect(bus.emitted.some((e) => e.channel === "rpiv:ask-user:blocked")).toBe(true));

		bus.events.emit(ASK_USER_ANSWER_EVENT, { answers: [{ questionIndex: 0, optionIndexes: [9] }] });
		expect(resultsOn(bus).at(-1)).toMatchObject({ ok: false, reason: expect.stringContaining("out of range") });

		bus.events.emit(ASK_USER_ANSWER_EVENT, { answers: [{ questionIndex: 0, optionIndexes: [0] }] });
		const result = await settle;
		expect(result?.content[0]).toMatchObject({ text: expect.stringContaining('"Which?"="A"') });
	});

	it("rejects a malformed payload", async () => {
		const { bus, settle } = runQuestionnaire();
		await vi.waitFor(() => expect(bus.emitted.some((e) => e.channel === "rpiv:ask-user:blocked")).toBe(true));

		bus.events.emit(ASK_USER_ANSWER_EVENT, { answers: "nope" });
		expect(resultsOn(bus).at(-1)).toMatchObject({ ok: false, reason: expect.stringContaining("must be an array") });

		bus.events.emit(ASK_USER_ANSWER_EVENT, { answers: [{ questionIndex: 0, optionIndexes: [0] }] });
		await settle;
	});

	it("rejects an answer when no questionnaire is awaiting input", () => {
		const bus = makeBus();
		const { pi } = createMockPi({ events: bus.events } as never);
		registerAskUserQuestionTool(pi);

		bus.events.emit(ASK_USER_ANSWER_EVENT, {
			requestId: "idle",
			answers: [{ questionIndex: 0, optionIndexes: [0] }],
		});

		expect(resultsOn(bus)).toEqual([{ ok: false, reason: "no questionnaire is awaiting input", requestId: "idle" }]);
	});
});
