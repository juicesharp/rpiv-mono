import { describe, expect, it } from "vitest";
import { routeKey } from "./key-router.ts";
import { initialVoiceState } from "./state.ts";
import { draftFromConfig } from "./state-reducer.ts";

const ESC = "\x1b";
const TAB = "\t";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

const kb = {
	matches: (data: string, name: string): boolean => {
		if (name === "tui.select.confirm") return data === "\r" || data === "\n";
		if (name === "tui.select.cancel") return data === ESC;
		if (name === "tui.select.up") return data === UP;
		if (name === "tui.select.down") return data === DOWN;
		return false;
	},
};

function runtime() {
	return { keybindings: kb };
}

function freshState() {
	return initialVoiceState(draftFromConfig({}));
}

describe("routeKey — dictation screen", () => {
	it("Esc → cancel", () => {
		expect(routeKey(ESC, freshState(), runtime())).toEqual({ kind: "cancel" });
	});

	it("Enter → commit", () => {
		expect(routeKey("\r", freshState(), runtime())).toEqual({ kind: "commit" });
	});

	it("Tab → open_settings", () => {
		expect(routeKey(TAB, freshState(), runtime())).toEqual({ kind: "open_settings" });
	});

	it("Space → toggle_pause", () => {
		expect(routeKey(" ", freshState(), runtime())).toEqual({ kind: "toggle_pause" });
	});

	it("unknown keystroke → ignore", () => {
		expect(routeKey("a", freshState(), runtime())).toEqual({ kind: "ignore" });
	});
});

describe("routeKey — settings screen", () => {
	const settingsState = { ...freshState(), currentScreen: "settings" as const };

	it("Esc → close_settings", () => {
		expect(routeKey(ESC, settingsState, runtime())).toEqual({ kind: "close_settings" });
	});

	it("Tab → close_settings", () => {
		expect(routeKey(TAB, settingsState, runtime())).toEqual({ kind: "close_settings" });
	});

	it("Enter → toggle_focused_setting", () => {
		expect(routeKey("\r", settingsState, runtime())).toEqual({ kind: "toggle_focused_setting" });
	});

	it("Up arrow → focus_settings_prev", () => {
		expect(routeKey(UP, settingsState, runtime())).toEqual({ kind: "focus_settings_prev" });
	});

	it("Down arrow → focus_settings_next", () => {
		expect(routeKey(DOWN, settingsState, runtime())).toEqual({ kind: "focus_settings_next" });
	});

	it("Ctrl-S → settings_save", () => {
		expect(routeKey("\x13", settingsState, runtime())).toEqual({ kind: "settings_save" });
	});

	it("unknown keystroke → ignore", () => {
		expect(routeKey("x", settingsState, runtime())).toEqual({ kind: "ignore" });
	});
});

describe("routeKey — cancel honors user keybinding remap", () => {
	const remappedKb = {
		matches: (data: string, name: string): boolean => {
			if (name === "tui.select.confirm") return data === "\r" || data === "\n";
			// User remapped cancel to Ctrl-G instead of Esc.
			if (name === "tui.select.cancel") return data === "\x07";
			return false;
		},
	};
	const remappedRuntime = () => ({ keybindings: remappedKb });

	it("dictation: Ctrl-G fires cancel when user remapped 'tui.select.cancel'", () => {
		expect(routeKey("\x07", freshState(), remappedRuntime())).toEqual({ kind: "cancel" });
	});

	it("dictation: Esc no longer cancels when remapped away", () => {
		expect(routeKey(ESC, freshState(), remappedRuntime())).toEqual({ kind: "ignore" });
	});

	it("settings: Ctrl-G fires close_settings when user remapped cancel", () => {
		const settingsState = { ...freshState(), currentScreen: "settings" as const };
		expect(routeKey("\x07", settingsState, remappedRuntime())).toEqual({ kind: "close_settings" });
	});
});
