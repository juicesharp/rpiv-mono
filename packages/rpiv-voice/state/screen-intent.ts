import type { ScreenKind } from "./state.ts";

export type FooterHintKey =
	| "enter_paste"
	| "space_pause"
	| "tab_settings"
	| "esc_cancel"
	| "esc_back"
	| "ctrl_s_save"
	| "enter_toggle"
	| "up_down_select";

export interface ScreenIntentMeta {
	label: string;
	footerHints: readonly FooterHintKey[];
}

export const SCREEN_META: Record<ScreenKind, ScreenIntentMeta> = {
	dictation: {
		label: "Dictation",
		footerHints: ["enter_paste", "space_pause", "tab_settings", "esc_cancel"],
	},
	settings: {
		label: "Settings",
		footerHints: ["up_down_select", "enter_toggle", "ctrl_s_save", "esc_back"],
	},
};
