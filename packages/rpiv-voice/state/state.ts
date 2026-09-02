import { DEFAULT_NUM_THREADS } from "../config/voice-config.js";

export type RecordingStatus = "recording" | "paused";
export type ScreenKind = "dictation" | "settings";

export type SettingsFieldKey = "hallucination" | "equalizer";

export interface SettingsDraft {
	hallucinationFilterEnabled: boolean;
	equalizerEnabled: boolean;
}

export interface VoiceState {
	currentScreen: ScreenKind;
	status: RecordingStatus;
	/** Committed text — produced by the final decode at each VAD silence /
	 *  cap boundary. This is what the editor receives on commit. */
	transcript: string;
	/** In-progress text — rolling re-decodes of the still-active utterance,
	 *  emitted every ~1 s. Replaced wholesale by each successive partial.
	 *  Cleared (and concatenated into `transcript`) on the final decode of
	 *  the utterance. Rendered after `transcript` in a dim style. */
	partialTranscript: string;
	audioLevel: number;
	/** In-flight editor draft — auto-persists on `close_settings` (Esc/Tab) so
	 *  toggling and exiting saves; Ctrl-S (`settings_save`) is the explicit
	 *  save+notify path. */
	settingsDraft: SettingsDraft;
	/** Which interactive settings field is currently focused. Up/Down arrows
	 *  cycle through `SETTINGS_FIELD_ORDER`; Enter toggles the focused one. */
	settingsFocus: SettingsFieldKey;
	/** Decode thread count baked in when the session started — display-only
	 *  (the settings Threads row). The running recognizer keeps the count it
	 *  was constructed with; changes apply on the next `/voice` run. */
	numThreads: number;
}

export const SETTINGS_FIELD_ORDER: readonly SettingsFieldKey[] = ["hallucination", "equalizer"];

export interface VoiceRuntime {
	keybindings: { matches(data: string, name: string): boolean };
}

export function initialVoiceState(draft: SettingsDraft, numThreads = DEFAULT_NUM_THREADS): VoiceState {
	return {
		currentScreen: "dictation",
		status: "recording",
		transcript: "",
		partialTranscript: "",
		audioLevel: 0,
		settingsDraft: draft,
		settingsFocus: SETTINGS_FIELD_ORDER[0]!,
		numThreads,
	};
}
