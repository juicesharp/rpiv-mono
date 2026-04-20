import { describe, expect, it } from "vitest";
import { dispatchQuestionInput } from "./ask-user-question.js";
import type { WrappingSelectItem } from "./wrapping-select.js";

const KEY = {
	UP: "tui.select.up",
	DOWN: "tui.select.down",
	CONFIRM: "tui.select.confirm",
	CANCEL: "tui.select.cancel",
};

const sentinel = (name: string) => `<KEY:${name}>`;

const keybindings = {
	matches(data: string, name: string) {
		return data === sentinel(name);
	},
};

const mainA: WrappingSelectItem = { label: "A" };
const mainB: WrappingSelectItem = { label: "B" };
const other: WrappingSelectItem = { label: "Type something.", isOther: true };
const chat: WrappingSelectItem = { label: "Chat about this", isChat: true };

const baseState = (overrides: Partial<Parameters<typeof dispatchQuestionInput>[1]> = {}) => ({
	selectionIndex: 0,
	totalCount: 4, // main = [A, B, other], chat = [chat]
	currentItem: mainA as WrappingSelectItem | undefined,
	isInlineInputActive: false,
	inputBuffer: "",
	keybindings,
	...overrides,
});

describe("dispatchQuestionInput — navigation", () => {
	it("UP at index 0 wraps to last", () => {
		expect(dispatchQuestionInput(sentinel(KEY.UP), baseState())).toEqual({ kind: "nav", nextIndex: 3 });
	});
	it("UP at index 3 moves to 2", () => {
		expect(dispatchQuestionInput(sentinel(KEY.UP), baseState({ selectionIndex: 3 }))).toEqual({
			kind: "nav",
			nextIndex: 2,
		});
	});
	it("DOWN at last wraps to 0", () => {
		expect(dispatchQuestionInput(sentinel(KEY.DOWN), baseState({ selectionIndex: 3 }))).toEqual({
			kind: "nav",
			nextIndex: 0,
		});
	});
	it("DOWN at index 0 advances to 1", () => {
		expect(dispatchQuestionInput(sentinel(KEY.DOWN), baseState())).toEqual({ kind: "nav", nextIndex: 1 });
	});
});

describe("dispatchQuestionInput — confirm", () => {
	it("confirms current non-inline item verbatim", () => {
		expect(dispatchQuestionInput(sentinel(KEY.CONFIRM), baseState({ currentItem: mainB }))).toEqual({
			kind: "confirm",
			choice: mainB,
		});
	});
	it("confirms chat item verbatim", () => {
		expect(dispatchQuestionInput(sentinel(KEY.CONFIRM), baseState({ currentItem: chat }))).toEqual({
			kind: "confirm",
			choice: chat,
		});
	});
	it("confirms inline-input-active with the current buffer tagged isOther", () => {
		expect(
			dispatchQuestionInput(
				sentinel(KEY.CONFIRM),
				baseState({ currentItem: other, isInlineInputActive: true, inputBuffer: "typed" }),
			),
		).toEqual({ kind: "confirm", choice: { label: "typed", isOther: true } });
	});
	it("confirms inline-input-active with empty buffer (answer=null signaled downstream)", () => {
		expect(
			dispatchQuestionInput(
				sentinel(KEY.CONFIRM),
				baseState({ currentItem: other, isInlineInputActive: true, inputBuffer: "" }),
			),
		).toEqual({ kind: "confirm", choice: { label: "", isOther: true } });
	});
	it("ignores confirm when currentItem is undefined and not inline", () => {
		expect(dispatchQuestionInput(sentinel(KEY.CONFIRM), baseState({ currentItem: undefined }))).toEqual({
			kind: "ignore",
		});
	});
});

describe("dispatchQuestionInput — cancel", () => {
	it("emits cancel", () => {
		expect(dispatchQuestionInput(sentinel(KEY.CANCEL), baseState())).toEqual({ kind: "cancel" });
	});
});

describe("dispatchQuestionInput — inline input", () => {
	const inline = baseState({ currentItem: other, isInlineInputActive: true });

	it("DEL byte \\x7f is a backspace", () => {
		expect(dispatchQuestionInput("\x7f", inline)).toEqual({ kind: "backspace" });
	});
	it("BS byte \\b is a backspace", () => {
		expect(dispatchQuestionInput("\b", inline)).toEqual({ kind: "backspace" });
	});
	it("printable data is appended", () => {
		expect(dispatchQuestionInput("x", inline)).toEqual({ kind: "append", data: "x" });
	});
	it("ESC-prefixed sequence is ignored", () => {
		expect(dispatchQuestionInput("\x1b[A", inline)).toEqual({ kind: "ignore" });
	});
	it("empty string is ignored", () => {
		expect(dispatchQuestionInput("", inline)).toEqual({ kind: "ignore" });
	});
});

describe("dispatchQuestionInput — non-inline fallthrough", () => {
	it("ignores arbitrary non-matching bytes", () => {
		expect(dispatchQuestionInput("q", baseState())).toEqual({ kind: "ignore" });
	});
	it("ignores backspace when inline input is NOT active", () => {
		expect(dispatchQuestionInput("\x7f", baseState())).toEqual({ kind: "ignore" });
	});
});
