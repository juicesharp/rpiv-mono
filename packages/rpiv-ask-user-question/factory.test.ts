import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import type { QuestionAnswer, QuestionnaireResult } from "./tool/types.js";

/** Narrowed tool-result shape for test assertions. */
interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: QuestionnaireResult;
}

interface RenderableComponent {
	render: (w: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
}

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

function register() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

function driveCustom(script: (c: RenderableComponent, done: (v: unknown) => void) => void) {
	const requestRender = vi.fn();
	const custom = vi.fn((factory: unknown) => {
		return new Promise((resolve) => {
			const f = factory as (
				tui: { requestRender: () => void; terminal: { columns: number; rows: number } },
				theme: typeof identityTheme,
				kb: undefined,
				done: (v: unknown) => void,
			) => RenderableComponent;
			const component = f(
				{ requestRender, terminal: { columns: 120, rows: 24 } },
				identityTheme,
				undefined,
				resolve,
			);
			script(component, resolve);
		});
	});
	return { custom, requestRender };
}

// Real key sequences from pi-tui
const KEY = {
	ENTER: "\r",
	ESC: "\x1b",
	DOWN: "\x1b[B",
	UP: "\x1b[A",
	TAB: "\t",
	SHIFT_TAB: "\x1b[Z",
	SPACE: " ",
};

const threeOptionParams = {
	questions: [
		{
			question: "Pick one",
			header: "Choice",
			options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
		},
	],
};

const mixedParams = {
	questions: [
		{ question: "Q1", header: "H1", options: [{ label: "A" }, { label: "B" }] },
		{
			question: "Q2",
			header: "H2",
			multiSelect: true,
			options: [{ label: "FE" }, { label: "BE" }, { label: "DB" }, { label: "QA" }, { label: "Ops" }],
		},
	],
};

beforeEach(() => {});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("ask_user_question — factory driver (real pi-tui keybindings)", () => {
	it("renders a non-empty view at width 80", async () => {
		const tool = register();
		const { custom } = driveCustom((c, done) => {
			const lines = c.render(80);
			expect(lines.length).toBeGreaterThan(0);
			done({ answers: [], cancelled: true });
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", threeOptionParams as never, undefined as never, undefined as never, ctx);
	});

	it("Esc cancels → returns decline envelope with cancelled=true", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.ESC);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", threeOptionParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details).toMatchObject({ cancelled: true });
	});

	it("Enter on first item → single-question auto-submits", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.ENTER);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", threeOptionParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details).toMatchObject({ cancelled: false });
		expect(r?.details.answers[0]).toMatchObject({ answer: "Alpha", kind: "option" });
	});

	it("DOWN navigates without completing; Esc cancels", async () => {
		const tool = register();
		const { custom, requestRender } = driveCustom((c) => {
			c.handleInput(KEY.DOWN);
			c.handleInput(KEY.ESC);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", threeOptionParams as never, undefined as never, undefined as never, ctx);
		expect(requestRender).toHaveBeenCalled();
	});

	it("invalidate() is callable without throwing", async () => {
		const tool = register();
		const { custom } = driveCustom((c, done) => {
			c.invalidate();
			done({ answers: [], cancelled: true });
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", threeOptionParams as never, undefined as never, undefined as never, ctx);
	});

	it("Ctrl+] collapses the questionnaire to a one-line footer; Ctrl+] again expands to the full render", async () => {
		// Raw control byte for Ctrl+] (GS, 0x1d) — the form every macOS terminal
		// (Terminal.app, iTerm2, Warp), every multiplexer (tmux, zellij), and Ghostty
		// deliver in raw TUI mode. Ctrl+] is the chosen collapse key because Alt+Tab is
		// OS-reserved, Ctrl+P collides with pi-coding-agent + the user's virtual
		// terminal, and F2 is intercepted by macOS function-key handling.
		const CTRL_RBRACKET = "\x1d";
		const tool = register();
		let expandedLineCount = 0;
		let collapsedLines: string[] = [];
		let reExpandedLineCount = 0;
		const { custom } = driveCustom((c, done) => {
			expandedLineCount = c.render(120).length;
			c.handleInput(CTRL_RBRACKET);
			collapsedLines = c.render(120);
			c.handleInput(CTRL_RBRACKET);
			reExpandedLineCount = c.render(120).length;
			done({ answers: [], cancelled: true });
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", threeOptionParams as never, undefined as never, undefined as never, ctx);

		// Collapse shrinks the entire dialog to one row — pi-tui sizes the overlay to
		// `min(lines.length, maxHeight)`, so a 1-line render frees the transcript above.
		expect(collapsedLines).toHaveLength(1);
		expect(collapsedLines[0]).toContain("Ctrl+] to expand");
		expect(collapsedLines[0]).toContain("Esc to cancel");
		// Expand returns the same multi-row shape as before the round-trip (idempotent toggle).
		expect(expandedLineCount).toBeGreaterThan(1);
		expect(reExpandedLineCount).toBe(expandedLineCount);
	});

	it("Esc while collapsed cancels (the only key honoured behind the one-line footer)", async () => {
		const CTRL_RBRACKET = "\x1d";
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(CTRL_RBRACKET);
			c.handleInput(KEY.ESC);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", threeOptionParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details).toMatchObject({ cancelled: true });
	});
});

describe("ask_user_question — single-question navigation", () => {
	it("DOWN to Beta, Enter → selects Beta (kind:'option')", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.DOWN); // 0 → 1 (Beta)
			c.handleInput(KEY.ENTER);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", threeOptionParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers[0]).toMatchObject({ questionIndex: 0, answer: "Beta", kind: "option" });
	});

	it("DOWN×2 to Gamma, UP×1 back to Beta, Enter → selects Beta", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.DOWN); // → Beta
			c.handleInput(KEY.DOWN); // → Gamma
			c.handleInput(KEY.UP); // → Beta
			c.handleInput(KEY.ENTER);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", threeOptionParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.answers[0].answer).toBe("Beta");
	});

	it("UP from Alpha wraps to Type-something, then UP to Gamma", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			// Items = [Alpha, Beta, Gamma, "Type something."] (no chat row). UP at index 0
			// wraps to the last item (Type something, inputMode); UP from there → Gamma.
			c.handleInput(KEY.UP); // Alpha (0) → wrap to Type something (3, inputMode)
			c.handleInput(KEY.UP); // Type something (3) → Gamma (2)
			c.handleInput(KEY.ENTER); // confirm Gamma
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", threeOptionParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers[0].answer).toBe("Gamma");
	});
});

describe("ask_user_question — 'Type something.' free-text flow", () => {
	const freeTextParams = {
		questions: [
			{
				question: "Name?",
				header: "Name",
				options: [
					{ label: "Default", description: "Default option" },
					{ label: "Second", description: "Second option" },
				],
			},
		],
	};

	it("navigate to Other sentinel, type text, Enter → kind:'custom' with typed text", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			// Items: [Default, Second, "Type something."] — DOWN×2 to Type something
			c.handleInput(KEY.DOWN); // → Second
			c.handleInput(KEY.DOWN); // → Type something (inputMode=true)
			c.handleInput("h");
			c.handleInput("e");
			c.handleInput("l");
			c.handleInput("l");
			c.handleInput("o");
			c.handleInput(KEY.ENTER);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", freeTextParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers[0].kind).toBe("custom");
		expect(r?.details.answers[0].answer).toBe("hello");
	});

	it("Type something with no input → kind:'custom', answer=null", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.DOWN); // → Second
			c.handleInput(KEY.DOWN); // → Type something
			c.handleInput(KEY.ENTER); // confirm with empty buffer
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", freeTextParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.answers[0].kind).toBe("custom");
		expect(r?.details.answers[0].answer).toBeNull();
		expect(r?.content[0].text).toContain("(no input)");
	});

	it("Type text, backspace removes last char, then Enter", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.DOWN); // → Second
			c.handleInput(KEY.DOWN); // → Type something
			c.handleInput("a");
			c.handleInput("b");
			c.handleInput("c");
			c.handleInput("\x7f"); // backspace
			c.handleInput(KEY.ENTER);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", freeTextParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.answers[0].answer).toBe("ab");
	});
});

describe("ask_user_question — tab-switch height stability", () => {
	it("dialog total line count is identical across tab switches (mixed single+multi fixture)", async () => {
		const tool = register();
		let lengthTab0 = 0;
		let lengthTab1 = 0;
		const { custom } = driveCustom((c, done) => {
			lengthTab0 = c.render(120).length;
			c.handleInput(KEY.TAB); // Tab → next question tab
			lengthTab1 = c.render(120).length;
			done({ answers: [], cancelled: true });
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", mixedParams as never, undefined as never, undefined as never, ctx);
		expect(lengthTab0).toBe(lengthTab1);
	});
});

describe("ask_user_question — multi-select flow (single question)", () => {
	const multiParams = {
		questions: [
			{
				question: "Pick areas",
				header: "Areas",
				multiSelect: true,
				options: [{ label: "Frontend" }, { label: "Backend" }, { label: "DevOps" }],
			},
		],
	};

	it("Space toggles items, then DOWN to Next + Enter confirms selected labels", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.SPACE); // toggle Frontend ON
			c.handleInput(KEY.DOWN); // → Backend
			c.handleInput(KEY.SPACE); // toggle Backend ON
			c.handleInput(KEY.DOWN); // → DevOps (not toggled)
			c.handleInput(KEY.DOWN); // → "Type something." row
			c.handleInput(KEY.DOWN); // → Next sentinel
			c.handleInput(KEY.ENTER); // commit + advance (single question → submit)
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", multiParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers[0].answer).toBeNull();
		expect(r?.details.answers[0].selected).toEqual(["Frontend", "Backend"]);
	});

	// Spec: Enter on a regular row toggles (matches Space) — does NOT submit. Asserted indirectly:
	// the user toggles via Enter, lands on Next, and Enter on Next commits.
	it("Enter on a regular row toggles (no submit); commit happens on Next", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.ENTER); // toggle Frontend ON via Enter
			c.handleInput(KEY.DOWN); // → Backend
			c.handleInput(KEY.ENTER); // toggle Backend ON via Enter
			c.handleInput(KEY.ENTER); // toggle Backend OFF via Enter
			c.handleInput(KEY.DOWN); // → DevOps
			c.handleInput(KEY.DOWN); // → "Type something." row
			c.handleInput(KEY.DOWN); // → Next
			c.handleInput(KEY.ENTER); // commit
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", multiParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers[0].selected).toEqual(["Frontend"]);
	});

	it("Space toggles on then off → item excluded", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.SPACE); // Frontend ON
			c.handleInput(KEY.SPACE); // Frontend OFF
			c.handleInput(KEY.DOWN); // → Backend
			c.handleInput(KEY.SPACE); // Backend ON
			c.handleInput(KEY.DOWN); // → DevOps
			c.handleInput(KEY.DOWN); // → "Type something." row
			c.handleInput(KEY.DOWN); // → Next
			c.handleInput(KEY.ENTER);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", multiParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.answers[0].selected).toEqual(["Backend"]);
	});

	it("Enter on Next with nothing toggled → selected=[]", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.DOWN); // → Backend
			c.handleInput(KEY.DOWN); // → DevOps
			c.handleInput(KEY.DOWN); // → "Type something." row
			c.handleInput(KEY.DOWN); // → Next
			c.handleInput(KEY.ENTER); // commit with no toggles
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", multiParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.answers[0].selected).toEqual([]);
	});
});

describe("ask_user_question — multi-select toggle persistence (regression)", () => {
	const persistParams = {
		questions: [
			{
				question: "Q1",
				header: "H1",
				multiSelect: true,
				options: [{ label: "FE" }, { label: "BE" }, { label: "DB" }],
			},
			{ question: "Q2", header: "H2", options: [{ label: "A" }, { label: "B" }] },
		],
	};

	// Bug: toggling boxes on a multi-select tab and tab-switching away (without pressing Enter
	// on Next) lost the toggle state — answers never received the in-progress selection. The
	// final result and the Submit-tab summary both showed the question as un-answered.
	it("Tab away from a multi-select tab preserves toggles in the final answers", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.SPACE); // toggle FE ON
			c.handleInput(KEY.DOWN); // → BE
			c.handleInput(KEY.SPACE); // toggle BE ON
			c.handleInput(KEY.TAB); // → Q2 WITHOUT pressing Enter on Next
			c.handleInput(KEY.ENTER); // Q2: pick A → Submit tab
			c.handleInput(KEY.ENTER); // Submit
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", persistParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		const q1 = r?.details.answers.find((a) => a.questionIndex === 0);
		expect(q1).toBeDefined();
		expect(q1?.selected).toEqual(["FE", "BE"]);
	});

	// Bug: returning to a multi-select tab after toggling + tab-switching away showed empty
	// checkboxes. After the fix, syncMultiSelectFromAnswers reads the persisted state.
	it("Tab back to a multi-select tab restores the previous toggle state", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.SPACE); // toggle FE ON
			c.handleInput(KEY.TAB); // → Q2
			c.handleInput(KEY.SHIFT_TAB); // ← Q1 (toggles must still be lit)
			c.handleInput(KEY.DOWN); // optionIndex 1 = BE
			c.handleInput(KEY.SPACE); // toggle BE ON (should NOT erase FE)
			c.handleInput(KEY.DOWN); // → DB
			c.handleInput(KEY.DOWN); // → "Type something." row
			c.handleInput(KEY.DOWN); // → Next
			c.handleInput(KEY.ENTER); // commit (auto-advance to Q2)
			c.handleInput(KEY.ENTER); // Q2: A → Submit
			c.handleInput(KEY.ENTER); // Submit
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", persistParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		const q1 = r?.details.answers.find((a) => a.questionIndex === 0);
		expect(q1?.selected).toEqual(["FE", "BE"]);
	});
});

describe("ask_user_question — multi-question tab cycling flow", () => {
	const twoParams = {
		questions: [
			{ question: "Q1?", header: "First", options: [{ label: "A" }, { label: "B" }] },
			{ question: "Q2?", header: "Second", options: [{ label: "X" }, { label: "Y" }] },
		],
	};

	it("answer Q1 → auto-advance to Q2 → answer Q2 → auto-advance to Submit", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.ENTER); // Q1: select A → auto-advance to Q2
			c.handleInput(KEY.ENTER); // Q2: select X → auto-advance to Submit
			c.handleInput(KEY.ENTER); // Submit (all answered)
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", twoParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers).toHaveLength(2);
		expect(r?.details.answers[0].answer).toBe("A");
		expect(r?.details.answers[1].answer).toBe("X");
	});

	it("Tab cycles: Q1 → Q2 → Submit → Shift+Tab back to Q2", async () => {
		const tool = register();
		let renderQ1 = 0;
		let renderQ2 = 0;
		let renderSubmit = 0;
		const { custom } = driveCustom((c, done) => {
			renderQ1 = c.render(120).length;
			c.handleInput(KEY.TAB); // → Q2
			renderQ2 = c.render(120).length;
			c.handleInput(KEY.TAB); // → Submit
			renderSubmit = c.render(120).length;
			c.handleInput(KEY.SHIFT_TAB); // → Q2
			done({ answers: [], cancelled: true });
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", twoParams as never, undefined as never, undefined as never, ctx);
		expect(renderQ1).toBe(renderQ2);
		expect(renderQ2).toBe(renderSubmit);
	});

	it("cancel mid-flow preserves partial answers in details", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.ENTER); // Q1: select A → auto-advance to Q2
			c.handleInput(KEY.ESC); // cancel on Q2
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", twoParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(true);
		expect(r?.content[0].text).toContain("declined");
		expect(r?.details.answers).toHaveLength(1);
		expect(r?.details.answers[0].answer).toBe("A");
	});

	// D1 revised: Submit always submits (warning header is informational only).
	// Enter on Submit row with submitChoiceIndex === 0 submits with whatever answers exist.
	it("Submit tab with Enter on Submit row submits with partial answers (D1 revised)", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.ENTER); // Q1: select A → auto-advance to Q2
			c.handleInput(KEY.TAB); // → Submit (Q2 unanswered)
			c.handleInput(KEY.ENTER); // Submit row (default index 0) → partial submit
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", twoParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers).toHaveLength(1);
		expect(r?.details.answers[0].question).toBe("Q1?");
	});

	it("answer all → Submit tab → DOWN → Enter on Cancel returns cancelled=true with all answers preserved", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.ENTER); // Q1: select A → auto-advance to Q2
			c.handleInput(KEY.ENTER); // Q2: select X → auto-advance to Submit
			c.handleInput(KEY.DOWN); // submit_nav → submitChoiceIndex=1 (Cancel row)
			c.handleInput(KEY.ENTER); // Enter on Cancel
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", twoParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(true);
		expect(r?.details.answers).toHaveLength(2);
		expect(r?.details.answers[0].answer).toBe("A");
		expect(r?.details.answers[1].answer).toBe("X");
	});

	// Confirmed-row indicator: tab back to a previously-answered single-select tab and the
	// prior option's row should render `<label> ✔` while the cursor (`❯`) stays at row 0.
	it("Tab back to a single-select tab marks the prior option with ` ✔`", async () => {
		const tool = register();
		const renderedAfterBack: string[][] = [];
		const { custom } = driveCustom((c, done) => {
			c.handleInput(KEY.DOWN); // Q1: cursor → B (option index 1)
			c.handleInput(KEY.ENTER); // confirm B → auto-advance to Q2
			c.handleInput(KEY.SHIFT_TAB); // ← back to Q1
			renderedAfterBack.push(c.render(120));
			done({ answers: [], cancelled: true });
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", twoParams as never, undefined as never, undefined as never, ctx);
		const lines = renderedAfterBack[0]!;
		expect(lines.some((l) => l.includes("B ✔"))).toBe(true);
		expect(lines.some((l) => l.includes("A ✔"))).toBe(false);
		expect(lines.some((l) => l.includes("❯ 1. A"))).toBe(true);
	});

	// Confirmed-row + custom text: prior typed text replaces "Type something." and gets ` ✔`.
	// Re-entering the kind:'other' row pre-fills the input buffer so the typed text is preserved.
	it("Tab back after `Type something.` → row reads `<text> ✔` and buffer is restored", async () => {
		const tool = register();
		const renderedAfterBack: string[][] = [];
		const renderedOnOtherRow: string[][] = [];
		const { custom } = driveCustom((c, done) => {
			c.handleInput(KEY.DOWN); // → B
			c.handleInput(KEY.DOWN); // → Type something. (kind:'other', inputMode)
			c.handleInput("H");
			c.handleInput("e");
			c.handleInput("l");
			c.handleInput("l");
			c.handleInput("o");
			c.handleInput(KEY.ENTER); // confirm "Hello" (kind:'custom') → auto-advance to Q2
			c.handleInput(KEY.SHIFT_TAB); // ← back to Q1; cursor resets to row 0
			renderedAfterBack.push(c.render(120));
			c.handleInput(KEY.DOWN); // → B
			c.handleInput(KEY.DOWN); // → Type something. (now active, input buffer restored)
			renderedOnOtherRow.push(c.render(120));
			done({ answers: [], cancelled: true });
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", twoParams as never, undefined as never, undefined as never, ctx);
		const back = renderedAfterBack[0]!;
		expect(back.some((l) => l.includes("Hello ✔"))).toBe(true);
		expect(back.some((l) => l.includes("Type something."))).toBe(false);
		expect(back.some((l) => l.includes("❯ 1. A"))).toBe(true);
		const onOther = renderedOnOtherRow[0]!;
		expect(onOther.some((l) => l.includes("Hello") && l.includes(CURSOR_MARKER))).toBe(true);
	});

	// Multi-select keeps its existing `[✔]` rendering — the new single-select marker must
	// NOT also render on multi-select tabs.
	it("Tab back to a multi-select tab keeps `[✔]` and does NOT add a trailing ` ✔`", async () => {
		const mixedSingleMulti = {
			questions: [
				{
					question: "Q1?",
					header: "H1",
					multiSelect: true,
					options: [{ label: "FE" }, { label: "BE" }, { label: "DB" }],
				},
				{ question: "Q2?", header: "H2", options: [{ label: "A" }, { label: "B" }] },
			],
		};
		const tool = register();
		const renderedAfterBack: string[][] = [];
		const { custom } = driveCustom((c, done) => {
			c.handleInput(KEY.SPACE); // toggle FE
			c.handleInput(KEY.TAB); // → Q2
			c.handleInput(KEY.SHIFT_TAB); // ← back to Q1
			renderedAfterBack.push(c.render(120));
			done({ answers: [], cancelled: true });
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", mixedSingleMulti as never, undefined as never, undefined as never, ctx);
		const lines = renderedAfterBack[0]!;
		expect(lines.some((l) => l.includes("[✔]") && l.includes("FE"))).toBe(true);
		// Trailing ` ✔` is the single-select marker; multi-select must not gain it.
		expect(lines.some((l) => /FE\s+✔(?!\])/.test(l))).toBe(false);
	});
});

describe("ask_user_question — MAX_QUESTIONS (4 questions) complete flow", () => {
	const fourParams = {
		questions: [
			{
				question: "Q1?",
				header: "H1",
				options: [
					{ label: "A", description: "A option" },
					{ label: "A2", description: "A2 option" },
				],
			},
			{
				question: "Q2?",
				header: "H2",
				options: [
					{ label: "B", description: "B option" },
					{ label: "B2", description: "B2 option" },
				],
			},
			{
				question: "Q3?",
				header: "H3",
				options: [
					{ label: "C", description: "C option" },
					{ label: "C2", description: "C2 option" },
				],
			},
			{
				question: "Q4?",
				header: "H4",
				options: [
					{ label: "D", description: "D option" },
					{ label: "D2", description: "D2 option" },
				],
			},
		],
	};

	it("answer all 4 questions with auto-advance, then submit", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.ENTER); // Q1 → Q2
			c.handleInput(KEY.ENTER); // Q2 → Q3
			c.handleInput(KEY.ENTER); // Q3 → Q4
			c.handleInput(KEY.ENTER); // Q4 → Submit tab
			c.handleInput(KEY.ENTER); // Submit
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", fourParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers).toHaveLength(4);
		const labels = r?.details.answers.map((a: QuestionAnswer) => a.answer);
		expect(labels).toEqual(["A", "B", "C", "D"]);
		// Phase 3 envelope: single CC-style sentence chain.
		expect(r?.content[0].text).toContain('"Q1?"="A".');
		expect(r?.content[0].text).toContain('"Q4?"="D".');
		expect(r?.content[0].text).toMatch(/^User has answered your questions:/);
		expect(r?.content[0].text).toMatch(/You can now continue with the user's answers in mind\.$/);
	});

	it("cancel after answering 2 of 4 → partial answers preserved", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.ENTER); // Q1 → Q2
			c.handleInput(KEY.ENTER); // Q2 → Q3
			c.handleInput(KEY.ESC); // cancel on Q3
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", fourParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(true);
		expect(r?.details.answers).toHaveLength(2);
	});
});

describe("ask_user_question — mixed single+multi question flow", () => {
	it("answer single-select Q1, toggle multi-select Q2, submit", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.ENTER); // Q1 (single): select A → auto-advance to Q2
			c.handleInput(KEY.SPACE); // Q2 (multi, 5 options): toggle FE (idx 0) ON
			c.handleInput(KEY.DOWN); // → BE (1)
			c.handleInput(KEY.DOWN); // → DB (2)
			c.handleInput(KEY.SPACE); // toggle DB ON
			c.handleInput(KEY.DOWN); // → QA (3)
			c.handleInput(KEY.DOWN); // → Ops (4)
			c.handleInput(KEY.DOWN); // → "Type something." row (5)
			c.handleInput(KEY.DOWN); // → Next sentinel (6)
			c.handleInput(KEY.ENTER); // commit multi-select → Submit tab
			c.handleInput(KEY.ENTER); // Submit (all answered)
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", mixedParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers).toHaveLength(2);
		expect(r?.details.answers[0]).toMatchObject({ answer: "A", kind: "option" });
		expect(r?.details.answers[1]).toMatchObject({ answer: null, selected: ["FE", "DB"] });
	});
});

const previewQuestionParams = {
	questions: [
		{
			question: "Pick layout",
			header: "Layout",
			options: [
				{ label: "Centered", description: "Centered logo", preview: "## Centered\n\nbody" },
				{ label: "Left", description: "Left logo" },
			],
		},
	],
};

describe("ask_user_question — notes pre-answer (Slice 5 notes UX)", () => {
	it("user can press 'n' to add notes BEFORE pressing Enter on a preview-bearing option", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			// Items: [Centered (preview), Left, "Type something."]
			// On startup we're focused on Centered (option 0), which has preview.
			// Slice 5 gate: focusedOptionHasPreview === true → 'n' triggers notes_enter.
			c.handleInput("n"); // enter notes mode
			c.handleInput("h");
			c.handleInput("e");
			c.handleInput("l");
			c.handleInput("l");
			c.handleInput("o");
			c.handleInput(KEY.ESC); // exit notes (commits to notesByTab)
			c.handleInput(KEY.ENTER); // confirm Centered → notesByTab merges into answer
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.(
			"tc",
			previewQuestionParams as never,
			undefined as never,
			undefined as never,
			ctx,
		)) as ToolResult | undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers[0]).toMatchObject({ answer: "Centered", kind: "option" });
		expect(r?.details.answers[0].notes).toBe("hello");
	});

	it("'n' keypress is ignored when focused option has no preview (notes scoped to preview-bearing options)", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.DOWN); // → option Left (no preview)
			c.handleInput("n"); // ignored — focusedOptionHasPreview === false
			c.handleInput(KEY.ENTER); // confirms Left
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.(
			"tc",
			previewQuestionParams as never,
			undefined as never,
			undefined as never,
			ctx,
		)) as ToolResult | undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers[0].answer).toBe("Left");
		expect(r?.details.answers[0].notes).toBeUndefined();
	});
});

describe("ask_user_question — bracketed paste + Kitty CSI-u (dictation parity)", () => {
	const freeTextParams = {
		questions: [
			{
				question: "Name?",
				header: "Name",
				options: [
					{ label: "Default", description: "Default option" },
					{ label: "Second", description: "Second option" },
				],
			},
		],
	};

	it("bracketed paste on the inline-Other row commits the pasted text as kind:'custom'", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.DOWN); // → Second
			c.handleInput(KEY.DOWN); // → Type something. (inputMode=true)
			// Wispr Flow / FluidVoice ReliablePaste deliver bracketed paste:
			c.handleInput("\x1b[200~Hello world\x1b[201~");
			c.handleInput(KEY.ENTER);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", freeTextParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers[0].kind).toBe("custom");
		expect(r?.details.answers[0].answer).toBe("Hello world");
	});

	it("bracketed paste split across two handleInput calls is reassembled correctly", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.DOWN);
			c.handleInput(KEY.DOWN); // inputMode
			// Stdin chunks the paste — pi-tui's Input.pasteBuffer accumulator handles split chunks.
			c.handleInput("\x1b[200~Hel");
			c.handleInput("lo\x1b[201~");
			c.handleInput(KEY.ENTER);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", freeTextParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.answers[0].answer).toBe("Hello");
	});

	it("bracketed paste strips embedded \\n/\\r and converts \\t to 4 spaces (single-line invariant)", async () => {
		// Wispr Flow auto-chunks long dictations into multiple bracketed pastes BUT a single
		// paste may contain literal newlines. handlePaste at input.js:356 cleans them.
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.DOWN);
			c.handleInput(KEY.DOWN);
			c.handleInput("\x1b[200~Hello\nworld\twith\rmix\x1b[201~");
			c.handleInput(KEY.ENTER);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", freeTextParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		// \n and \r stripped entirely; \t → 4 spaces.
		expect(r?.details.answers[0].answer).toBe("Helloworld    withmix");
	});

	it("Kitty CSI-u printables (\\x1b[97u …) are decoded and committed", async () => {
		// On Warp/Ghostty/kitty/WezTerm/modern Alacritty with Kitty flags 1+2+4,
		// every printable arrives as a CSI-u sequence. Input.handleInput decodes
		// these via decodeKittyPrintable BEFORE the C0 control-char rejection.
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.DOWN);
			c.handleInput(KEY.DOWN);
			c.handleInput("\x1b[97u"); // 'a'
			c.handleInput("\x1b[98u"); // 'b'
			c.handleInput("\x1b[99u"); // 'c'
			c.handleInput(KEY.ENTER);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", freeTextParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.answers[0].kind).toBe("custom");
		expect(r?.details.answers[0].answer).toBe("abc");
	});

	it("bracketed paste followed by typed chars + backspace produces the expected merged value", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.DOWN);
			c.handleInput(KEY.DOWN);
			c.handleInput("\x1b[200~Hi\x1b[201~"); // paste "Hi" → "Hi"
			c.handleInput("!"); // append "!" → "Hi!"
			c.handleInput("\x7f"); // backspace → "Hi"
			c.handleInput(KEY.ENTER);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", freeTextParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.answers[0].answer).toBe("Hi");
	});

	it("raw multi-character chunk (no bracketed paste markers) appends as-is", async () => {
		// Terminal.app does not enable bracketed paste; macOS Dictation and Wispr
		// fallback can deliver a contiguous string without ESC framing. The Input
		// hot path falls through to insertCharacter at input.js:171 for any chunk
		// with no control chars.
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.DOWN);
			c.handleInput(KEY.DOWN); // inputMode
			c.handleInput("Hello world"); // raw, unframed multi-char chunk
			c.handleInput(KEY.ENTER);
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", freeTextParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.answers[0].kind).toBe("custom");
		expect(r?.details.answers[0].answer).toBe("Hello world");
	});
});
