import { makeTheme } from "@juicesharp/rpiv-test-utils";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { makeMultiSelectViewProps as makeProps } from "../../test-fixtures.js";
import type { QuestionData } from "../../tool/types.js";
import { MultiSelectView, type MultiSelectViewProps } from "./multi-select-view.js";

const theme = makeTheme() as unknown as Theme;

function makeView(q: QuestionData, props: MultiSelectViewProps): MultiSelectView {
	const view = new MultiSelectView(theme, q);
	view.setProps(props);
	return view;
}

function question(over: Partial<QuestionData> = {}): QuestionData {
	return {
		question: over.question ?? "areas?",
		header: over.header ?? "H",
		// Empty descriptions skip the continuation-line render path so default fixture
		// produces exactly one line per option (matches the row-count expectations below).
		options: over.options ?? [
			{ label: "FE", description: "" },
			{ label: "BE", description: "" },
			{ label: "DB", description: "" },
		],
		multiSelect: over.multiSelect ?? true,
	};
}

describe("MultiSelectView.render", () => {
	it("renders one row per option + a trailing Next sentinel", () => {
		const q = question();
		const m = makeView(q, makeProps(q));
		const lines = m.render(80);
		expect(lines.length).toBe(4); // 3 options + Next
		expect(lines[0]).toContain("FE");
		expect(lines[1]).toContain("BE");
		expect(lines[2]).toContain("DB");
		expect(lines[3]).toContain("Next");
	});

	// Spec: a 1-space gap between the bracketed glyph (`[ ]` / `[✔]`) and the option label
	// (CC parity — single space matches the CC sample `[✔] Logging`).
	it("separates the checkbox from the label by exactly ONE space", () => {
		const q = question();
		const m = makeView(q, makeProps(q));
		const lines = m.render(80);
		// Strip any ANSI escapes from line 0 to match raw glyph positioning.
		const raw = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		// Active row 0 = `❯ 1. [ ] FE` (pointer 2 + "1." 2 + space 1 + "[ ]" 3 + space 1 + label).
		expect(raw).toMatch(/\[[ ✔]\] FE/);
	});

	// Spec: when the multi-select pane is unfocused (chat row / notes input has focus), the
	// `❯` active-row pointer must NOT render — otherwise the dialog shows two cursors lit at
	// the same time (`❯ 1. [✔] HTMX` AND `❯ Chat about this`).
	it("focused=false suppresses the active-row pointer (no doubled cursor)", () => {
		const q = question();
		const m = makeView(q, makeProps(q, { optionIndex: 1, focused: true }));

		const focused = m.render(80);
		const rawFocused = focused.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
		expect(rawFocused[1].startsWith("❯ ")).toBe(true); // active pointer on selected row

		m.setProps(makeProps(q, { optionIndex: 1, focused: false }));
		const blurred = m.render(80);
		const rawBlurred = blurred.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
		// No row may begin with `❯ ` when the pane is blurred.
		for (const l of rawBlurred) expect(l.startsWith("❯ ")).toBe(false);

		m.setProps(makeProps(q, { optionIndex: 1, focused: true }));
		const refocused = m.render(80);
		const rawRefocused = refocused.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
		expect(rawRefocused[1].startsWith("❯ ")).toBe(true);
	});

	it("renders description on continuation line when present", () => {
		const q = question({
			options: [
				{ label: "FE", description: "front-end" },
				{ label: "BE", description: "" },
			],
		});
		const m = makeView(q, makeProps(q));
		const lines = m.render(80);
		expect(lines.length).toBe(4); // FE row + 1 description + BE row + Next
		expect(lines[1]).toContain("front-end");
		expect(lines[3]).toContain("Next");
	});

	it("active option uses ACTIVE_POINTER and accent styling", () => {
		const q = question();
		const m = makeView(q, makeProps(q, { optionIndex: 1 }));
		const lines = m.render(80);
		expect(lines[1]).toContain("❯ "); // ACTIVE_POINTER on the active row
		expect(lines[0].startsWith("❯ ")).toBe(false); // inactive rows do not start with active pointer
	});

	it("checked options render [✔]; unchecked render [ ]", () => {
		const q = question();
		const m = makeView(q, makeProps(q, { checkedIndices: new Set([0, 2]) }));
		const lines = m.render(80);
		expect(lines[0]).toContain("[✔]");
		expect(lines[1]).toContain("[ ]");
		expect(lines[2]).toContain("[✔]");
	});

	it("row 1 inactive unchecked renders as '  1. [ ] LABEL'", () => {
		// optionIndex = 1 → row 0 is inactive; checkbox 0 unchecked.
		const q = question();
		const m = makeView(q, makeProps(q, { optionIndex: 1 }));
		const raw = m.render(80)[0].replace(/\x1b\[[0-9;]*m/g, "");
		expect(raw).toMatch(/^ {2}1\. \[ \] FE/);
	});

	it("row 2 active checked renders as '❯ 2. [✔] LABEL'", () => {
		const q = question();
		const m = makeView(q, makeProps(q, { optionIndex: 1, checkedIndices: new Set([1]) }));
		const raw = m.render(80)[1].replace(/\x1b\[[0-9;]*m/g, "");
		expect(raw).toMatch(/^❯ 2\. \[✔\] BE/);
	});

	it("description continuation indents to col 2 (CC parity, not prefixVisibleWidth)", () => {
		const q = question({
			options: [
				{
					label: "FE",
					description:
						"this is an extremely long description that should wrap across multiple lines when rendered at narrow widths",
				},
				{ label: "BE", description: "" },
			],
		});
		const m = makeView(q, makeProps(q));
		const lines = m.render(40);
		// Line 0 = row, lines 1..N = wrapped description segments. Each continuation must start
		// with EXACTLY 2 spaces (col 2 = past pointer slot), not 9 (full prefix column).
		for (let i = 1; i < lines.length - 1; i++) {
			const raw = lines[i].replace(/\x1b\[[0-9;]*m/g, "");
			expect(raw.startsWith("  ")).toBe(true);
			expect(raw.startsWith("   ")).toBe(false);
		}
	});

	it("renders props.nextLabel verbatim on the trailing sentinel row", () => {
		const q = question();
		const m = makeView(q, makeProps(q, { nextLabel: "Submit" }));
		const lines = m.render(80);
		expect(lines[lines.length - 1]).toContain("Submit");
		expect(lines[lines.length - 1]).not.toContain("Next");
	});

	it("setProps mutates props visible to next render (active row moves)", () => {
		const q = question();
		const m = makeView(q, makeProps(q, { optionIndex: 0 }));
		expect(m.render(80)[0]).toContain("❯ ");
		m.setProps(makeProps(q, { optionIndex: 2 }));
		const lines = m.render(80);
		expect(lines[0].startsWith("❯ ")).toBe(false);
		expect(lines[2]).toContain("❯ ");
	});
});

describe("MultiSelectView.naturalHeight", () => {
	const fixtures: Array<[string, QuestionData]> = [
		["no-desc 3 options", question()],
		[
			"with-1-line-desc",
			question({
				options: [
					{ label: "FE", description: "front-end" },
					{ label: "BE", description: "back-end" },
					{ label: "DB", description: "DB" },
				],
			}),
		],
		[
			"with-multi-line-wrap-desc",
			question({
				options: [
					{
						label: "FE",
						description:
							"this is an extremely long description that should wrap across multiple lines when rendered at narrow widths to verify line counting",
					},
					{ label: "BE", description: "BE" },
				],
			}),
		],
		[
			"long-label-truncates-not-wraps",
			question({
				options: [
					{ label: "x".repeat(200), description: "long" },
					{ label: "BE", description: "BE" },
				],
			}),
		],
	];

	it("naturalHeight(w) === render(w).length across widths and fixtures", () => {
		for (const [_label, q] of fixtures) {
			const m = makeView(q, makeProps(q));
			for (const w of [20, 40, 80, 120]) {
				expect(m.naturalHeight(w)).toBe(m.render(w).length);
			}
		}
	});

	it("is props-independent (theme/question/width only)", () => {
		const q = question({
			options: [
				{ label: "FE", description: "front-end work" },
				{ label: "BE", description: "back-end" },
				{ label: "DB", description: "database tasks" },
			],
		});
		const a = makeView(q, makeProps(q, { optionIndex: 0 }));
		const b = makeView(q, makeProps(q, { optionIndex: 2, checkedIndices: new Set([0, 1]) }));
		for (const w of [20, 40, 80, 120]) {
			expect(a.naturalHeight(w)).toBe(b.naturalHeight(w));
		}
	});
});

describe("MultiSelectView width safety", () => {
	it("every emitted line satisfies visibleWidth(line) <= width", () => {
		const q = question({
			options: [
				{ label: "x".repeat(200), description: "y".repeat(200) },
				{ label: "BE", description: "back-end" },
			],
		});
		const m = makeView(q, makeProps(q));
		for (const w of [20, 40, 80, 120]) {
			const lines = m.render(w);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(w);
			}
		}
	});
});
