import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import type { QuestionAnswer, QuestionnaireResult } from "./types.js";

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
				tui: { requestRender: () => void; terminal: { columns: number } },
				theme: typeof identityTheme,
				kb: undefined,
				done: (v: unknown) => void,
			) => RenderableComponent;
			const component = f({ requestRender, terminal: { columns: 120 } }, identityTheme, undefined, resolve);
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
		expect(r?.details.answers[0]).toMatchObject({ answer: "Alpha", wasCustom: false });
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
});

describe("ask_user_question — single-question navigation", () => {
	it("DOWN to Beta, Enter → selects Beta (wasCustom=false)", async () => {
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
		expect(r?.details.answers[0]).toMatchObject({ questionIndex: 0, answer: "Beta", wasCustom: false });
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

	it("UP wraps from Alpha past last option through chat back to Gamma", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			// Items = [Alpha, Beta, Gamma, "Type something."] (index 3 = Other sentinel)
			c.handleInput(KEY.UP); // wraps to last (Type something, inputMode=true)
			c.handleInput(KEY.DOWN); // → focus_chat
			c.handleInput(KEY.UP); // → focus_options (back to Type something)
			c.handleInput(KEY.UP); // → Gamma (index 2)
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

	it("navigate to Other sentinel, type text, Enter → wasCustom=true with typed text", async () => {
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
		expect(r?.details.answers[0].wasCustom).toBe(true);
		expect(r?.details.answers[0].answer).toBe("hello");
	});

	it("Type something with no input → wasCustom=true, answer=null", async () => {
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
		expect(r?.details.answers[0].wasCustom).toBe(true);
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

describe("ask_user_question — chat focus integration", () => {
	it("DOWN past last option focuses chat row; ENTER returns wasChat:true", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			// items = [Alpha, Beta, Gamma, "Type something."] (4 items)
			c.handleInput(KEY.DOWN); // → Beta
			c.handleInput(KEY.DOWN); // → Gamma
			c.handleInput(KEY.DOWN); // → Type something (inputMode=true)
			c.handleInput(KEY.DOWN); // → focus_chat
			c.handleInput(KEY.ENTER); // confirm chat
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", threeOptionParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers[0]?.wasChat).toBe(true);
		expect(r?.details.answers[0]?.answer).toBe("Chat about this");
		expect(r?.content[0].text).toContain("Continue the conversation");
	});

	it("UP-from-chat clears chatFocused; subsequent ENTER returns options answer (not wasChat)", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.DOWN); // → Beta
			c.handleInput(KEY.DOWN); // → Gamma
			c.handleInput(KEY.DOWN); // → Type something (inputMode=true)
			c.handleInput(KEY.DOWN); // → focus_chat
			c.handleInput(KEY.UP); // → focus_options (back to Type something)
			c.handleInput(KEY.ENTER); // confirm via inputMode branch with empty buffer
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", threeOptionParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers[0]?.wasChat).not.toBe(true);
		expect(r?.details.answers[0]?.wasCustom).toBe(true);
		expect(r?.details.answers[0]?.answer).toBeNull();
	});

	it("Esc from chat cancels the whole dialog", async () => {
		const tool = register();
		const { custom } = driveCustom((c) => {
			c.handleInput(KEY.DOWN); // → Beta
			c.handleInput(KEY.DOWN); // → Gamma
			c.handleInput(KEY.DOWN); // → Type something
			c.handleInput(KEY.DOWN); // → focus_chat
			c.handleInput(KEY.ESC); // cancel
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", threeOptionParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(true);
	});

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
			c.handleInput(KEY.DOWN); // → Next sentinel (5)
			c.handleInput(KEY.ENTER); // commit multi-select → Submit tab
			c.handleInput(KEY.ENTER); // Submit (all answered)
		});
		const ctx = { hasUI: true, ui: { custom } } as never;
		const r = (await tool.execute?.("tc", mixedParams as never, undefined as never, undefined as never, ctx)) as
			| ToolResult
			| undefined;
		expect(r?.details.cancelled).toBe(false);
		expect(r?.details.answers).toHaveLength(2);
		expect(r?.details.answers[0]).toMatchObject({ answer: "A", wasCustom: false });
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
		expect(r?.details.answers[0]).toMatchObject({ answer: "Centered", wasCustom: false });
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
