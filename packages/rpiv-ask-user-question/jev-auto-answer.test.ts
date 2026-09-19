import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedJevConfig } from "./config.js";
import { autoAnswerWithJev, buildJevQuestions, type JevClient } from "./jev-auto-answer.js";
import type { QuestionParams } from "./tool/types.js";

const CONFIG: ResolvedJevConfig = { autoAnswer: true, model: "jev-latest", minConfidence: 0.5 };

const PARAMS: QuestionParams = {
	state: "The app is a small TypeScript CLI and must minimize dependencies.",
	questions: [
		{
			question: "Which storage should it use?",
			header: "Storage",
			options: [
				{ label: "JSON", description: "One local file", preview: "config.json" },
				{ label: "SQLite", description: "Embedded database" },
			],
		},
		{
			question: "Which checks should run?",
			header: "Checks",
			multiSelect: true,
			options: [
				{ label: "Lint", description: "Static style checks" },
				{ label: "Tests", description: "Behavior checks" },
			],
		},
	],
};

function clientWith(response: unknown): JevClient {
	return { systemOne: vi.fn(async () => response) as never };
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("buildJevQuestions", () => {
	it("batches one Choice per single-select and one Noul per multi-select option", () => {
		expect(buildJevQuestions(PARAMS)).toEqual({
			question_0: {
				type: "choice",
				instructions: "Which option best answers this question? Which storage should it use?",
				criteria: { option_0: "JSON: One local file", option_1: "SQLite: Embedded database" },
			},
			question_1_option_0: {
				type: "noul",
				instructions:
					'For the question "Which checks should run?", should "Lint" be selected as one of the answers?',
				criteria: { true: "Select it: Static style checks", false: "Do not select this option." },
			},
			question_1_option_1: {
				type: "noul",
				instructions:
					'For the question "Which checks should run?", should "Tests" be selected as one of the answers?',
				criteria: { true: "Select it: Behavior checks", false: "Do not select this option." },
			},
		});
	});
});

describe("autoAnswerWithJev", () => {
	it("maps confident Choice and Noul answers into the existing questionnaire result", async () => {
		const client = clientWith({
			model: "jev-1.13.0",
			answers: {
				question_0: {
					type: "choice",
					choice: "option_0",
					confidence: 0.8,
					probabilities: { option_0: 0.9, option_1: 0.1 },
				},
				question_1_option_0: { type: "noul", noul: 0.9 },
				question_1_option_1: { type: "noul", noul: 0.2 },
			},
			usage: { input_tokens: 120, output_tokens: 20 },
		});

		const outcome = await autoAnswerWithJev(PARAMS, CONFIG, undefined, async () => client);

		expect(outcome).toMatchObject({
			ok: true,
			result: {
				cancelled: false,
				answers: [
					{ questionIndex: 0, kind: "option", answer: "JSON", preview: "config.json" },
					{ questionIndex: 1, kind: "multi", answer: null, selected: ["Lint"] },
				],
				autoAnswer: {
					provider: "typesafe",
					model: "jev-1.13.0",
					usage: { input_tokens: 120, output_tokens: 20 },
				},
			},
		});
		expect(client.systemOne).toHaveBeenCalledWith(
			expect.objectContaining({ state: PARAMS.state, model: "jev-latest" }),
			{ signal: undefined },
		);
	});

	it("dynamically loads the real SDK and makes one offline batched request", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "offline-test-key");
		const fetch = vi.fn(
			async (_input: string | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						model: "jev-offline-fixture",
						answers: {
							question_0: {
								type: "choice",
								choice: "option_0",
								confidence: 0.8,
								probabilities: { option_0: 0.9, option_1: 0.1 },
							},
							question_1_option_0: { type: "noul", noul: 0.9 },
							question_1_option_1: { type: "noul", noul: 0.2 },
						},
						usage: { input_tokens: 12, output_tokens: 4 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetch);

		const outcome = await autoAnswerWithJev(PARAMS, CONFIG);

		expect(outcome).toMatchObject({ ok: true, result: { autoAnswer: { model: "jev-offline-fixture" } } });
		expect(fetch).toHaveBeenCalledOnce();
		const [, init] = fetch.mock.calls[0]!;
		const body = JSON.parse(String(init?.body));
		expect(body).toEqual({
			state: PARAMS.state,
			questions: buildJevQuestions(PARAMS),
			model: CONFIG.model,
		});
	});

	it("requires explicit nonblank state without constructing a client", async () => {
		const factory = vi.fn(async () => clientWith({}));
		const outcome = await autoAnswerWithJev({ ...PARAMS, state: "  " }, CONFIG, undefined, factory);
		expect(outcome).toEqual({
			ok: false,
			error: "auto_answer_state_required",
			message: "Jev auto-answer requires explicit state in the tool call.",
		});
		expect(factory).not.toHaveBeenCalled();
	});

	it("returns uncertain for low Choice confidence", async () => {
		const client = clientWith({
			model: "jev-1.13.0",
			answers: {
				question_0: {
					type: "choice",
					choice: "option_0",
					confidence: 0.49,
					probabilities: { option_0: 0.51, option_1: 0.49 },
				},
			},
			usage: { input_tokens: 1, output_tokens: 1 },
		});
		const outcome = await autoAnswerWithJev(PARAMS, CONFIG, undefined, async () => client);
		expect(outcome).toMatchObject({ ok: false, error: "auto_answer_uncertain" });
	});

	it("uses 0.5 as the Noul selection threshold and minConfidence as the certainty floor", async () => {
		const client = clientWith({
			model: "jev-1.13.0",
			answers: {
				question_0: {
					type: "choice",
					choice: "option_0",
					confidence: 0.5,
					probabilities: { option_0: 0.75, option_1: 0.25 },
				},
				question_1_option_0: { type: "noul", noul: 0.75 },
				question_1_option_1: { type: "noul", noul: 0.25 },
			},
			usage: { input_tokens: 1, output_tokens: 1 },
		});

		const outcome = await autoAnswerWithJev(PARAMS, CONFIG, undefined, async () => client);

		expect(outcome).toMatchObject({
			ok: true,
			result: {
				answers: [
					{ questionIndex: 0, answer: "JSON" },
					{ questionIndex: 1, selected: ["Lint"] },
				],
				autoAnswer: { evaluations: [{ confidence: 0.5 }, { confidence: 0.5 }] },
			},
		});
	});

	it("treats a Noul near 0.5 as uncertain", async () => {
		const client = clientWith({
			model: "jev-1.13.0",
			answers: {
				question_0: {
					type: "choice",
					choice: "option_0",
					confidence: 0.9,
					probabilities: { option_0: 0.9, option_1: 0.1 },
				},
				question_1_option_0: { type: "noul", noul: 0.6 },
				question_1_option_1: { type: "noul", noul: 0.1 },
			},
			usage: { input_tokens: 1, output_tokens: 1 },
		});
		const outcome = await autoAnswerWithJev(PARAMS, CONFIG, undefined, async () => client);
		expect(outcome).toMatchObject({ ok: false, error: "auto_answer_uncertain" });
	});

	it("turns client failures into a fallback outcome", async () => {
		const outcome = await autoAnswerWithJev(PARAMS, CONFIG, undefined, async () => {
			throw new Error("service unavailable");
		});
		expect(outcome).toEqual({
			ok: false,
			error: "auto_answer_failed",
			message: "Jev auto-answer failed: service unavailable",
		});
	});
});
