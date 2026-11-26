import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import type { QuestionAnswer, QuestionData, QuestionnaireResult, QuestionParams } from "../tool/types.ts";
import { renderAskCall, renderAskResult } from "./transcript.ts";

const theme = makeTheme() as unknown as Theme;
const colored = makeTheme({ fg: (color, text) => `<${color}>${text}</${color}>` }) as unknown as Theme;

const question = (header: string, text = `${header}?`, extra: Partial<QuestionData> = {}): QuestionData => ({
	question: text,
	header,
	options: [
		{ label: "A", description: "a" },
		{ label: "B", description: "b" },
	],
	...extra,
});
const params = (...questions: QuestionData[]): QuestionParams => ({ questions });
const answer = (questionIndex: number, a: Omit<QuestionAnswer, "questionIndex" | "question">): QuestionAnswer => ({
	questionIndex,
	question: `q${questionIndex}`,
	...a,
});
const result = (details: QuestionnaireResult, text = "envelope") => ({
	content: [{ type: "text" as const, text }],
	details,
});

const collapsed = { expanded: false, isError: false };
const lines = (args: QuestionParams | undefined, details: QuestionnaireResult, width = 100, opts = collapsed) =>
	renderAskResult(result(details), args, theme, opts).render(width);

describe("renderAskCall", () => {
	it("names the questions by header", () => {
		expect(renderAskCall(params(question("Format"), question("Migration")), theme).render(100)).toEqual([
			"Ask Format · Migration",
		]);
	});

	it("truncates to the terminal width with an ellipsis", () => {
		const [line] = renderAskCall(params(question("Config format"), question("Data migration")), theme).render(20);
		const visible = stripTerminalSequences(line ?? "");
		expect(visibleWidth(visible)).toBeLessThanOrEqual(20);
		expect(visible).toMatch(/^Ask Config format.*…$/);
	});

	it("renders the bare title while arguments are still streaming", () => {
		expect(renderAskCall({} as QuestionParams, theme).render(100)).toEqual(["Ask"]);
	});
});

describe("renderAskResult — one question", () => {
	const args = params(question("Format", "Which config format should we use?"));

	it("shows the picked option without its (Recommended) suffix", () => {
		const details = { answers: [answer(0, { kind: "option", answer: "TOML (Recommended)" })], cancelled: false };
		expect(lines(args, details)).toEqual(["✓ TOML"]);
		expect(renderAskResult(result(details), args, colored, collapsed).render(100)).toEqual([
			"<success>✓</success> <toolOutput>TOML</toolOutput>",
		]);
	});

	it("quotes a typed answer", () => {
		const details = { answers: [answer(0, { kind: "custom", answer: "keep both for a week" })], cancelled: false };
		expect(lines(args, details)).toEqual(['✓ "keep both for a week"']);
	});

	it("joins multi-select picks and quotes the typed extra", () => {
		const details = {
			answers: [answer(0, { kind: "multi", answer: "seed fixtures", selected: ["Schema", "Data (Recommended)"] })],
			cancelled: false,
		};
		expect(lines(args, details)).toEqual(['✓ Schema, Data, "seed fixtures"']);
	});

	it("puts the question's note and the global note under the answer", () => {
		const details = {
			answers: [answer(0, { kind: "option", answer: "TOML", notes: "we already use it" })],
			cancelled: false,
			globalNote: "ship behind a flag",
		};
		expect(lines(args, details)).toEqual(["✓ TOML", "  ✎ we already use it", "  ✎ ship behind a flag"]);
	});

	it("shows not answered when only a global note was submitted", () => {
		const details = { answers: [], cancelled: false, globalNote: "later", unanswered: [0] };
		expect(lines(args, details)).toEqual(["✓ not answered", "  ✎ later"]);
	});

	it("adds the question text and the chosen preview when expanded", () => {
		const details = {
			answers: [answer(0, { kind: "option", answer: "TOML", preview: "```toml\n[cache]\nttl = 300\n```" })],
			cancelled: false,
		};
		expect(lines(args, details, 100, { expanded: true, isError: false })).toEqual([
			"✓ TOML",
			"  Which config format should we use?",
			"  │ [cache]",
			"  │ ttl = 300",
		]);
	});
});

describe("renderAskResult — several questions", () => {
	const args = params(
		question("Config format"),
		question("Data migration"),
		question("Rollback plan"),
		question("Release channel"),
	);
	const details: QuestionnaireResult = {
		answers: [
			answer(0, { kind: "option", answer: "TOML (Recommended)", notes: "we already use it" }),
			answer(1, { kind: "multi", answer: null, selected: ["Schema", "Data"] }),
			answer(3, { kind: "custom", answer: "beta first, then stable" }),
		],
		cancelled: false,
		globalNote: "ship behind a flag",
		unanswered: [2],
	};

	it("aligns one row per question, shows skipped ones, and ends with the global note", () => {
		expect(lines(args, details)).toEqual([
			"  Config format    TOML",
			"                   ✎ we already use it",
			"  Data migration   Schema, Data",
			"  Rollback plan    not answered",
			'  Release channel  "beta first, then stable"',
			"  ✎ ship behind a flag",
		]);
	});

	it("dims a skipped question", () => {
		const rendered = renderAskResult(result(details), args, colored, collapsed).render(100);
		expect(rendered).toContain("  <muted>Rollback plan  </muted>  <dim>not answered</dim>");
	});

	it("wraps a long answer under the answer column", () => {
		const long = {
			answers: [answer(0, { kind: "custom", answer: "beta first for two weeks, then stable" })],
			cancelled: false,
			unanswered: [1],
		};
		expect(lines(params(question("Release channel"), question("Rollback")), long, 44)).toEqual([
			'  Release channel  "beta first for two',
			'                   weeks, then stable"',
			"  Rollback         not answered",
		]);
	});

	it("adds each question text and the chosen preview when expanded", () => {
		const expandedDetails = {
			answers: [
				answer(0, { kind: "option", answer: "TOML", preview: "[cache]" }),
				answer(1, { kind: "option", answer: "B" }),
			],
			cancelled: false,
		};
		expect(
			lines(params(question("Format", "Which format?"), question("Scope", "Which scope?")), expandedDetails, 100, {
				expanded: true,
				isError: false,
			}),
		).toEqual([
			"  Format  TOML",
			"          Which format?",
			"          │ [cache]",
			"  Scope   B",
			"          Which scope?",
		]);
	});
});

describe("renderAskResult — no answers", () => {
	const args = params(question("Format"));

	it("shows a declined questionnaire as a dimmed no answer", () => {
		const details = { answers: [answer(0, { kind: "option", answer: "A" })], cancelled: true };
		expect(lines(args, details)).toEqual(["✗ no answer"]);
		expect(renderAskResult(result(details), args, colored, collapsed).render(100)).toEqual([
			"<dim>✗ no answer</dim>",
		]);
	});

	it("shows the first line of a tool error in the error colour", () => {
		const details: QuestionnaireResult = { answers: [], cancelled: true, error: "no_ui" };
		const rendered = renderAskResult(
			result(details, "Error: UI not available (running in non-interactive mode)"),
			args,
			colored,
			collapsed,
		).render(100);
		expect(rendered).toEqual(["<error>✗ Error: UI not available (running in non-interactive mode)</error>"]);
	});

	it("shows the first line of a call Pi rejected before execute", () => {
		const rejected = {
			content: [
				{
					type: "text" as const,
					text: 'Validation failed for tool "ask_user_question":\n  - questions.0.options: too many',
				},
			],
			details: undefined,
		};
		expect(renderAskResult(rejected, undefined, theme, { expanded: false, isError: true }).render(100)).toEqual([
			'✗ Validation failed for tool "ask_user_question":',
		]);
	});
});

describe("renderAskResult — never wider than the terminal (#348)", () => {
	const width = (line: string) => visibleWidth(stripTerminalSequences(line));

	it("truncates a tool error's first line to the terminal width", () => {
		// The reported crash: a 132-column receipt in a 129-column terminal.
		const message =
			'Invalid arguments for tool "ask_user_question": Unexpected non-whitespace character after JSON at position 502 (line 1 column 503)';
		const rejected = { content: [{ type: "text" as const, text: message }], details: undefined };
		const rendered = renderAskResult(rejected, undefined, colored, { expanded: false, isError: true }).render(129);
		expect(rendered).toHaveLength(1);
		expect(width(rendered[0] ?? "")).toBeLessThanOrEqual(129);
		expect(stripTerminalSequences(rendered[0] ?? "")).toMatch(/^<error>✗ Invalid arguments.*…$/);
	});

	it("keeps every receipt branch within a narrow terminal", () => {
		const args = params(question("Format"), question("A much longer header"));
		const answered = { answers: [answer(0, { kind: "option", answer: "TOML", notes: "a note" })], cancelled: false };
		const receipts = [
			renderAskResult(result(answered), args, colored, { expanded: true, isError: false }),
			renderAskResult(result(answered), params(question("Format")), colored, collapsed),
			renderAskResult(result({ answers: [], cancelled: true }), args, colored, collapsed),
			renderAskResult(
				result({ answers: [], cancelled: true, error: "no_ui" }, "x".repeat(300)),
				args,
				colored,
				collapsed,
			),
			renderAskResult({ content: [], details: undefined }, args, colored, collapsed),
			renderAskCall(args, colored),
		];
		for (const w of [1, 4, 12, 40]) {
			for (const receipt of receipts) {
				for (const line of receipt.render(w)) expect(width(line)).toBeLessThanOrEqual(w);
			}
		}
	});
});

describe("recorded arguments a provider double-encoded (#353)", () => {
	const answered: QuestionnaireResult = {
		answers: [answer(0, { kind: "option", answer: "Run API" }), answer(1, { kind: "option", answer: "claude" })],
		cancelled: false,
	};
	const recorded = (questions: unknown) => ({ questions }) as unknown as QuestionParams;
	const encoded = recorded(JSON.stringify([question("Transport"), question("Types")]));

	it("decodes a stringified questions array for the call line and the receipt", () => {
		expect(renderAskCall(encoded, theme).render(100)).toEqual(["Ask Transport · Types"]);
		expect(lines(encoded, answered)).toEqual(["  Transport  Run API", "  Types      claude"]);
	});

	it("decodes questions that were stringified one by one", () => {
		const each = recorded([JSON.stringify(question("Transport")), JSON.stringify(question("Types"))]);
		expect(lines(each, answered)).toEqual(["  Transport  Run API", "  Types      claude"]);
	});

	it.each([
		["a truncated string", '[{"header":"Transport"'],
		["an object", { 0: { header: "Transport" } }],
		["null", null],
		["a number", 3],
	])("draws %s as no questions instead of throwing", (_name, questions) => {
		expect(renderAskCall(recorded(questions), theme).render(100)).toEqual(["Ask"]);
		expect(lines(recorded(questions), answered)).toEqual(["✓ Run API"]);
	});

	it("keeps each answer on its own row when some recorded questions are malformed", () => {
		const mixed = recorded([null, { question: "No header?" }, question("Types")]);
		expect(renderAskCall(mixed, theme).render(100)).toEqual(["Ask Types"]);
		const rows = lines(mixed, {
			answers: [answer(1, { kind: "option", answer: "Run API" }), answer(2, { kind: "option", answer: "claude" })],
			cancelled: false,
		});
		expect(rows).toEqual(["         not answered", "         Run API", "  Types  claude"]);
	});

	it("draws arguments that are not an object at all", () => {
		const odd = "not arguments" as unknown as QuestionParams;
		expect(renderAskCall(odd, theme).render(100)).toEqual(["Ask"]);
		expect(lines(odd, answered)).toEqual(["✓ Run API"]);
	});
});
