import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearActiveAsk,
	getActiveAskParams,
	hasActiveAsk,
	registerActiveAsk,
	submitAskUserAnswer,
} from "./ask-answer.js";
import type { QuestionnaireResult } from "./tool/types.js";

const params = {
	questions: [
		{
			question: "Single?",
			header: "S",
			options: [
				{ label: "A", description: "d" },
				{ label: "B", description: "d" },
			],
		},
		{
			question: "Multi?",
			header: "M",
			multiSelect: true,
			options: [
				{ label: "X", description: "d" },
				{ label: "Y", description: "d" },
			],
		},
	],
} as Parameters<typeof registerActiveAsk>[0];

const okResult = (overrides: Partial<QuestionnaireResult> = {}): QuestionnaireResult => ({
	answers: [
		{ questionIndex: 0, question: "Single?", kind: "option", answer: "A" },
		{ questionIndex: 1, question: "Multi?", kind: "multi", answer: null, selected: ["X", "Y"] },
	],
	cancelled: false,
	...overrides,
});

function resetSlot(): void {
	registerActiveAsk(params, () => {});
	clearActiveAsk(registerActiveAsk(params, () => {}));
}

beforeEach(() => {
	// The slot is process-global (Symbol.for); make each test start from a known state.
	resetSlot();
});

describe("submitAskUserAnswer", () => {
	it("returns false when nothing is registered", () => {
		resetSlot();
		expect(submitAskUserAnswer(okResult())).toBe(false);
	});

	it("submits to the registered done callback and returns true", () => {
		const done = vi.fn();
		registerActiveAsk(params, done);
		expect(submitAskUserAnswer(okResult())).toBe(true);
		expect(done).toHaveBeenCalledWith(okResult());
	});

	it("is idempotent: second submit after answer returns false", () => {
		const done = vi.fn();
		registerActiveAsk(params, done);
		expect(submitAskUserAnswer(okResult())).toBe(true);
		expect(submitAskUserAnswer(okResult())).toBe(false);
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("returns false after the owning call's clearActiveAsk", () => {
		const done = vi.fn();
		const ask = registerActiveAsk(params, done);
		clearActiveAsk(ask);
		expect(hasActiveAsk()).toBe(false);
		expect(submitAskUserAnswer(okResult())).toBe(false);
		expect(done).not.toHaveBeenCalled();
	});

	it("accepts cancelled results (Esc-equivalent) with zero answers", () => {
		const done = vi.fn();
		registerActiveAsk(params, done);
		expect(submitAskUserAnswer({ answers: [], cancelled: true })).toBe(true);
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("accepts cancelled results even with malformed answer entries", () => {
		const done = vi.fn();
		registerActiveAsk(params, done);
		const cancelled = { answers: [null], cancelled: true } as unknown as QuestionnaireResult;
		expect(submitAskUserAnswer(cancelled)).toBe(true);
		expect(done).toHaveBeenCalledWith(cancelled);
	});

	it("rejects structurally malformed results without calling done", () => {
		const done = vi.fn();
		registerActiveAsk(params, done);
		expect(submitAskUserAnswer({} as QuestionnaireResult)).toBe(false);
		// cancelled:false with zero answers is not a real answer
		expect(submitAskUserAnswer({ answers: [], cancelled: false })).toBe(false);
		expect(done).not.toHaveBeenCalled();
	});

	it("rejects a null answer entry instead of letting buildQuestionnaireResponse throw", () => {
		const done = vi.fn();
		registerActiveAsk(params, done);
		const withNull = { answers: [null], cancelled: false } as unknown as QuestionnaireResult;
		expect(submitAskUserAnswer(withNull)).toBe(false);
		expect(done).not.toHaveBeenCalled();
	});

	it("rejects an out-of-range questionIndex", () => {
		const done = vi.fn();
		registerActiveAsk(params, done);
		const result = okResult({
			answers: [{ questionIndex: 9, question: "?", kind: "custom", answer: "text" }],
		});
		expect(submitAskUserAnswer(result)).toBe(false);
		expect(done).not.toHaveBeenCalled();
	});

	it("rejects a non-integer questionIndex", () => {
		const done = vi.fn();
		registerActiveAsk(params, done);
		const result = okResult({
			answers: [{ questionIndex: 0.5, question: "?", kind: "custom", answer: "text" }],
		});
		expect(submitAskUserAnswer(result)).toBe(false);
	});

	it("rejects a fabricated option label", () => {
		const done = vi.fn();
		registerActiveAsk(params, done);
		const result = okResult({
			answers: [{ questionIndex: 0, question: "Single?", kind: "option", answer: "NOT_A_LABEL" }],
		});
		expect(submitAskUserAnswer(result)).toBe(false);
		expect(done).not.toHaveBeenCalled();
	});

	it("rejects a fabricated label inside a pipe-joined multi-select option answer", () => {
		const done = vi.fn();
		registerActiveAsk(params, done);
		const result = okResult({
			answers: [{ questionIndex: 0, question: "Single?", kind: "option", answer: "A|FORGED" }],
		});
		expect(submitAskUserAnswer(result)).toBe(false);
	});

	it("accepts a pipe-joined option answer whose parts are all valid labels", () => {
		const done = vi.fn();
		registerActiveAsk(params, done);
		const result = okResult({
			answers: [{ questionIndex: 0, question: "Single?", kind: "option", answer: "A|B" }],
		});
		expect(submitAskUserAnswer(result)).toBe(true);
	});

	it("rejects a multi answer with a fabricated selected label", () => {
		const done = vi.fn();
		registerActiveAsk(params, done);
		const result = okResult({
			answers: [{ questionIndex: 1, question: "Multi?", kind: "multi", answer: null, selected: ["X", "FORGED"] }],
		});
		expect(submitAskUserAnswer(result)).toBe(false);
	});

	it("rejects an unknown kind", () => {
		const done = vi.fn();
		registerActiveAsk(params, done);
		const result = okResult({
			answers: [{ questionIndex: 0, question: "?", kind: "surprise", answer: "A" } as never],
		});
		expect(submitAskUserAnswer(result)).toBe(false);
	});

	it("leaves no residue: slot empty after a successful submit", () => {
		registerActiveAsk(params, vi.fn());
		expect(submitAskUserAnswer(okResult())).toBe(true);
		expect(hasActiveAsk()).toBe(false);
		expect(getActiveAskParams()).toBeNull();
	});
});

describe("held-identity clear (parallel asks)", () => {
	it("clears when the slot still holds the given handle", () => {
		const ask = registerActiveAsk(params, vi.fn());
		clearActiveAsk(ask);
		expect(hasActiveAsk()).toBe(false);
	});

	it("does not clear a different registration (first ask's finally vs second ask)", () => {
		const first = registerActiveAsk(params, vi.fn());
		const second = registerActiveAsk(params, vi.fn());
		clearActiveAsk(first); // first ask's finally — slot holds `second`
		expect(hasActiveAsk()).toBe(true);
		expect(getActiveAskParams()).toBe(params);
		clearActiveAsk(second); // second ask's finally
		expect(hasActiveAsk()).toBe(false);
	});

	it("a stale handle clears nothing after its registration was replaced", () => {
		const first = registerActiveAsk(params, vi.fn());
		registerActiveAsk(params, vi.fn()); // replaces first in the slot
		clearActiveAsk(first);
		expect(hasActiveAsk()).toBe(true);
	});

	it("an undefined handle (factory never ran) clears nothing", () => {
		registerActiveAsk(params, vi.fn());
		clearActiveAsk(undefined);
		expect(hasActiveAsk()).toBe(true);
	});

	it("submit answers the newest registration only", () => {
		const firstDone = vi.fn();
		const secondDone = vi.fn();
		registerActiveAsk(params, firstDone);
		registerActiveAsk(params, secondDone);
		expect(submitAskUserAnswer(okResult())).toBe(true);
		expect(firstDone).not.toHaveBeenCalled();
		expect(secondDone).toHaveBeenCalledTimes(1);
	});
});

describe("getActiveAskParams", () => {
	it("returns the registered params while waiting, null after clear", () => {
		const ask = registerActiveAsk(params, vi.fn());
		expect(getActiveAskParams()).toBe(params);
		clearActiveAsk(ask);
		expect(getActiveAskParams()).toBeNull();
	});
});
