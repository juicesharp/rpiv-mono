import type { EqualizerViewProps } from "../../view/components/equalizer-view.js";
import type { SettingsFieldViewProps } from "../../view/components/settings-field-view.js";
import type { StatusBarViewProps } from "../../view/components/status-bar-view.js";
import type { TranscriptViewProps } from "../../view/components/transcript-view.js";
import { getActiveLocale, t } from "../i18n-bridge.js";
import type { FooterHintKey } from "../screen-intent.js";
import { SCREEN_META } from "../screen-intent.js";
import type { GlobalSelector } from "./contract.js";

// Locales the bundled Whisper base multilingual model recognizes well. Mirror
// of WHISPER_SUPPORTED_LANGUAGES in voice-command.ts — duplicated rather than
// imported to keep selectors free of command-layer deps. Codes outside this
// set fall through to the auto-detect display.
//
// Endonyms (self-names) so the same string reads naturally regardless of the
// active UI locale: a Russian user sees `Русский`, an English user sees the
// same `Русский` — always self-recognizable, no translation matrix needed.
const LANGUAGE_DISPLAY_BY_CODE: Record<string, string> = {
	de: "Deutsch",
	en: "English",
	es: "Español",
	fr: "Français",
	it: "Italiano",
	ja: "日本語",
	pt: "Português",
	ru: "Русский",
	uk: "Українська",
	zh: "中文",
};

// Selector functions resolve i18n at projection time so /languages flips
// propagate without re-instantiating the views.
function hintLabel(key: FooterHintKey, status: { status: string }): string {
	switch (key) {
		case "enter_paste":
			return t("footer.enter_paste", "Enter to paste");
		case "space_pause":
			return status.status === "paused"
				? t("footer.space_resume", "Space to resume")
				: t("footer.space_pause", "Space to pause");
		case "tab_settings":
			return t("footer.tab_settings", "Tab for settings");
		case "esc_cancel":
			return t("footer.esc_cancel", "Esc to cancel");
		case "esc_back":
			return t("footer.esc_back", "Esc to go back");
		case "ctrl_s_save":
			return t("footer.ctrl_s_save", "Ctrl-S to save");
		case "enter_toggle":
			return t("footer.enter_toggle", "Enter to toggle");
		case "up_down_select":
			return t("footer.up_down_select", "↑↓ to select");
	}
}

export const selectStatusBarProps: GlobalSelector<StatusBarViewProps> = (state, _ctx) => {
	const meta = SCREEN_META[state.currentScreen];
	const hints: string[] = [];
	for (const key of meta.footerHints) hints.push(hintLabel(key, state));
	return { status: state.status, hints };
};

export const selectTranscriptProps: GlobalSelector<TranscriptViewProps> = (state, _ctx) => ({
	text: state.transcript,
	partial: state.partialTranscript,
	placeholder: t("transcript.placeholder", "Listening..."),
});

export const selectEqualizerProps: GlobalSelector<EqualizerViewProps> = (state, _ctx) => ({
	level: state.audioLevel,
	status: state.status,
	enabled: state.settingsDraft.equalizerEnabled,
});

// `active` reflects the focused settings field — only one toggle wears the
// pointer at a time. `hint` stays present so the settings body height is
// stable across focus changes (the field hides its own hint when not active,
// per settings-field-view's render gate).
export const selectHallucinationFilterFieldProps: GlobalSelector<SettingsFieldViewProps> = (state, _ctx) => ({
	label: t("settings.hallucination_filter_label", "Filter Whisper noise"),
	active: state.settingsFocus === "hallucination",
	field: { kind: "toggle", enabled: state.settingsDraft.hallucinationFilterEnabled },
	hint: t(
		"settings.hallucination_filter_hint",
		"Drops silence-segment artifacts. Turn off for single-word dictation.",
	),
});

export const selectEqualizerFieldProps: GlobalSelector<SettingsFieldViewProps> = (state, _ctx) => ({
	label: t("settings.equalizer_label", "Equalizer"),
	active: state.settingsFocus === "equalizer",
	field: { kind: "toggle", enabled: state.settingsDraft.equalizerEnabled },
	hint: t("settings.equalizer_hint", "Show the live audio waveform under the transcript. Off by default."),
});

export const selectMicReadonlyFieldProps: GlobalSelector<SettingsFieldViewProps> = (_state, _ctx) => ({
	label: t("settings.microphone_label", "Microphone"),
	active: false,
	field: { kind: "readonly", value: t("settings.microphone_value_default", "System default input") },
});

export const selectLanguageReadonlyFieldProps: GlobalSelector<SettingsFieldViewProps> = (_state, _ctx) => {
	const locale = getActiveLocale();
	const base = locale ? (locale.split("-")[0] ?? locale) : undefined;
	const display = base ? (LANGUAGE_DISPLAY_BY_CODE[base] ?? base) : t("settings.language_value_auto", "Auto-detect");
	return {
		label: t("settings.language_label", "Language"),
		active: false,
		field: { kind: "readonly", value: display },
		hint: t("settings.language_hint", "Run /languages to change."),
	};
};

// Decode threads are session-baked (VoiceState.numThreads) — display-only.
// The value is the raw count as a string; the hint points at voice.json
// because the settings screen cannot edit the key (JSON-only, restart-to-apply).
export const selectNumThreadsReadonlyFieldProps: GlobalSelector<SettingsFieldViewProps> = (state, _ctx) => ({
	label: t("settings.threads_label", "Threads"),
	active: false,
	field: { kind: "readonly", value: String(state.numThreads) },
	hint: t("settings.threads_hint", "Set numThreads in voice.json; re-run /voice to apply."),
});
