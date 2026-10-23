import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { VoiceRuntime, VoiceState } from "./state.ts";

const KEYBIND_CONFIRM = "tui.select.confirm";
// Mirrors the rpiv-ask-user-question peer pattern — cancel goes through the
// user's configurable keybinding (defaults to Esc) instead of a hardcoded
// `Key.escape`. Users who remap Esc still get a working cancel.
const KEYBIND_CANCEL = "tui.select.cancel";

const SPACE_KEY = " ";
const CTRL_S = "\x13";

export type VoiceAction =
	| { kind: "audio_chunk"; level: number }
	| { kind: "audio_transcript_appended"; text: string }
	| { kind: "audio_partial_transcript_set"; text: string }
	| { kind: "toggle_pause" }
	| { kind: "commit" }
	| { kind: "cancel" }
	| { kind: "open_settings" }
	| { kind: "close_settings" }
	| { kind: "toggle_focused_setting" }
	| { kind: "focus_settings_next" }
	| { kind: "focus_settings_prev" }
	| { kind: "settings_save" }
	| { kind: "ignore" };

export function routeKey(data: string, state: VoiceState, runtime: VoiceRuntime): VoiceAction {
	const kb = runtime.keybindings;

	if (state.currentScreen === "settings") {
		if (data === CTRL_S) return { kind: "settings_save" };
		if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "close_settings" };
		if (matchesKey(data, Key.tab)) return { kind: "close_settings" };
		if (matchesKey(data, Key.up)) return { kind: "focus_settings_prev" };
		if (matchesKey(data, Key.down)) return { kind: "focus_settings_next" };
		if (kb.matches(data, KEYBIND_CONFIRM)) return { kind: "toggle_focused_setting" };
		return { kind: "ignore" };
	}

	if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
	if (kb.matches(data, KEYBIND_CONFIRM)) return { kind: "commit" };
	if (matchesKey(data, Key.tab)) return { kind: "open_settings" };
	if (data === SPACE_KEY) return { kind: "toggle_pause" };
	return { kind: "ignore" };
}
