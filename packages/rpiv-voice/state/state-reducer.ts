import { isEqualizerEnabled, isHallucinationFilterEnabled, type VoiceConfig } from "../config/voice-config.js";
import { t } from "./i18n-bridge.js";
import type { VoiceAction } from "./key-router.js";
import { SETTINGS_FIELD_ORDER, type SettingsDraft, type SettingsFieldKey, type VoiceState } from "./state.js";
import { STATUS_META } from "./status-intent.js";

export interface ApplyContext {
	/**
	 * Fresh read of voice.json. Save handlers call it AT SAVE TIME so
	 * pass-through keys round-trip from the file as it is now — a mid-session
	 * hand edit of a JSON-only key (numThreads) must survive a settings save,
	 * not get reverted from the session-start snapshot.
	 */
	readPersistedConfig: () => VoiceConfig;
}

export type Effect =
	| { kind: "request_render" }
	| { kind: "paste_to_editor"; text: string }
	| { kind: "notify"; level: "error" | "info"; message: string }
	| { kind: "abort_session" }
	| { kind: "stop_mic" }
	| { kind: "set_pipeline_paused"; paused: boolean }
	| { kind: "set_hallucination_filter"; enabled: boolean }
	| { kind: "save_config"; config: VoiceConfig; successMessage?: string }
	| { kind: "done"; result: VoiceResult };

export interface VoiceResult {
	intent: "commit" | "cancel";
	transcript: string;
}

export interface ApplyResult {
	state: VoiceState;
	effects: readonly Effect[];
}

type Handler<K extends VoiceAction["kind"]> = (
	state: VoiceState,
	action: Extract<VoiceAction, { kind: K }>,
	ctx: ApplyContext,
) => ApplyResult;

const audioChunk: Handler<"audio_chunk"> = (state, action, _ctx) => {
	if (state.audioLevel === action.level) return { state, effects: [] };
	return { state: { ...state, audioLevel: action.level }, effects: [{ kind: "request_render" }] };
};

// Final commit. Appends to the persisted transcript and clears the in-progress
// partial — rolling re-decodes get superseded by the authoritative final.
const audioTranscriptAppended: Handler<"audio_transcript_appended"> = (state, action, _ctx) => {
	if (action.text.length === 0) {
		// Nothing to append, but a finalization still ends the partial.
		if (!state.partialTranscript) return { state, effects: [] };
		return { state: { ...state, partialTranscript: "" }, effects: [{ kind: "request_render" }] };
	}
	const next = state.transcript ? `${state.transcript} ${action.text}` : action.text;
	return {
		state: { ...state, transcript: next, partialTranscript: "" },
		effects: [{ kind: "request_render" }],
	};
};

// Replaces the partial wholesale — each rolling decode produces a fresh
// reading of the active utterance.
const audioPartialTranscriptSet: Handler<"audio_partial_transcript_set"> = (state, action, _ctx) => {
	if (state.partialTranscript === action.text) return { state, effects: [] };
	return { state: { ...state, partialTranscript: action.text }, effects: [{ kind: "request_render" }] };
};

const togglePause: Handler<"toggle_pause"> = (state, _action, _ctx) => {
	const nextStatus = state.status === "paused" ? "recording" : "paused";
	return {
		state: { ...state, status: nextStatus },
		effects: [
			{ kind: "set_pipeline_paused", paused: STATUS_META[nextStatus].gatesSttPipeline },
			{ kind: "request_render" },
		],
	};
};

// Include the in-flight partial when committing — what the user sees on
// screen (committed + grayed preview) is what they get pasted. Waiting for a
// "proper" final decode here would add 0.5–2 s of latency between Enter and
// paste; the visible partial is already a complete utterance from Whisper's
// perspective, just one without the trailing-silence padding.
const commit: Handler<"commit"> = (state, _action, _ctx) => {
	const merged = state.partialTranscript
		? state.transcript
			? `${state.transcript} ${state.partialTranscript}`
			: state.partialTranscript
		: state.transcript;
	return {
		state,
		effects: [{ kind: "done", result: { intent: "commit", transcript: merged } }],
	};
};

const cancel: Handler<"cancel"> = (state, _action, _ctx) => ({
	state,
	effects: [{ kind: "abort_session" }, { kind: "done", result: { intent: "cancel", transcript: "" } }],
});

const openSettings: Handler<"open_settings"> = (state, _action, _ctx) => ({
	state: { ...state, currentScreen: "settings" },
	effects: [{ kind: "request_render" }],
});

// Leaving the settings screen silently persists the draft. Ctrl-S remains the
// explicit save path (with a confirmation notify); this just makes the common
// "toggle then Esc/Tab" flow not lose changes.
const closeSettings: Handler<"close_settings"> = (state, _action, ctx) => ({
	state: { ...state, currentScreen: "dictation" },
	effects: [
		{ kind: "save_config", config: configFromDraft(state.settingsDraft, ctx.readPersistedConfig()) },
		{ kind: "request_render" },
	],
});

const toggleFocusedSetting: Handler<"toggle_focused_setting"> = (state, _action, _ctx) => {
	const focus = state.settingsFocus;
	if (focus === "hallucination") {
		const enabled = !state.settingsDraft.hallucinationFilterEnabled;
		return {
			state: { ...state, settingsDraft: { ...state.settingsDraft, hallucinationFilterEnabled: enabled } },
			effects: [{ kind: "set_hallucination_filter", enabled }, { kind: "request_render" }],
		};
	}
	// equalizer toggle is purely view-side: no pipeline reconfig needed, the
	// view reads the draft directly to decide whether to render its row pair.
	const enabled = !state.settingsDraft.equalizerEnabled;
	return {
		state: { ...state, settingsDraft: { ...state.settingsDraft, equalizerEnabled: enabled } },
		effects: [{ kind: "request_render" }],
	};
};

const focusSettingsNext: Handler<"focus_settings_next"> = (state, _action, _ctx) => {
	const next = stepFocus(state.settingsFocus, +1);
	if (next === state.settingsFocus) return { state, effects: [] };
	return { state: { ...state, settingsFocus: next }, effects: [{ kind: "request_render" }] };
};

const focusSettingsPrev: Handler<"focus_settings_prev"> = (state, _action, _ctx) => {
	const next = stepFocus(state.settingsFocus, -1);
	if (next === state.settingsFocus) return { state, effects: [] };
	return { state: { ...state, settingsFocus: next }, effects: [{ kind: "request_render" }] };
};

function stepFocus(current: SettingsFieldKey, delta: 1 | -1): SettingsFieldKey {
	const order = SETTINGS_FIELD_ORDER;
	const idx = order.indexOf(current);
	const next = (idx + delta + order.length) % order.length;
	return order[next] ?? current;
}

// Success notify is attached to the save_config effect (rather than a separate
// notify effect) so the imperative shell can fire it ONLY when persistence
// succeeds. A plain two-effect list ran both notifies unconditionally on
// failure because `return` inside runEffect()'s switch case exits the method,
// not the outer effect loop — review I1 caught this.
const settingsSave: Handler<"settings_save"> = (state, _action, ctx) => {
	const config = configFromDraft(state.settingsDraft, ctx.readPersistedConfig());
	return {
		state,
		effects: [
			{
				kind: "save_config",
				config,
				successMessage: t("notify.settings_saved", "Voice settings saved"),
			},
		],
	};
};

const ignore: Handler<"ignore"> = (state, _action, _ctx) => ({ state, effects: [] });

const HANDLERS: { [K in VoiceAction["kind"]]: Handler<K> } = {
	audio_chunk: audioChunk,
	audio_transcript_appended: audioTranscriptAppended,
	audio_partial_transcript_set: audioPartialTranscriptSet,
	toggle_pause: togglePause,
	commit,
	cancel,
	open_settings: openSettings,
	close_settings: closeSettings,
	toggle_focused_setting: toggleFocusedSetting,
	focus_settings_next: focusSettingsNext,
	focus_settings_prev: focusSettingsPrev,
	settings_save: settingsSave,
	ignore,
};

export function reduce(state: VoiceState, action: VoiceAction, ctx: ApplyContext): ApplyResult {
	const handler = HANDLERS[action.kind] as Handler<typeof action.kind>;
	return handler(state, action as never, ctx);
}

// Keys whose value the settings screen re-derives from the draft on every
// save — the draft is authoritative for these, so any persisted value is
// replaced by the draft-derived one (or dropped at default). Every other
// persisted key (numThreads, language, and any future JSON-only key) is
// pass-through: a settings save must never drop config the screen cannot edit.
export const DRAFT_OWNED_CONFIG_KEYS: ReadonlySet<string> = new Set(["hallucinationFilterEnabled", "equalizerEnabled"]);

export function configFromDraft(draft: SettingsDraft, persisted: VoiceConfig): VoiceConfig {
	// Widened accumulator: pass-through keys may fall outside VoiceConfig's
	// known shape (a hand-edited voice.json), so writes go through a string
	// index signature on top of the mapped known keys.
	const out: { -readonly [K in keyof VoiceConfig]: VoiceConfig[K] } & Record<string, unknown> = {};
	for (const [key, value] of Object.entries(persisted)) {
		// `__proto__` is skipped: a computed assignment on a plain accumulator
		// would invoke Object.prototype's setter — replacing the prototype —
		// instead of round-tripping the key as an own property.
		if (key === "__proto__" || DRAFT_OWNED_CONFIG_KEYS.has(key)) continue;
		out[key] = value;
	}
	// Only persist the non-default state. Hallucination filter defaults ON, so
	// only the off-state lands on disk; equalizer defaults OFF, so only the
	// on-state does. Both rules keep voice.json minimal and forward-compatible.
	if (draft.hallucinationFilterEnabled === false) out.hallucinationFilterEnabled = false;
	if (draft.equalizerEnabled === true) out.equalizerEnabled = true;
	return out;
}

export function draftFromConfig(config: VoiceConfig): SettingsDraft {
	return {
		hallucinationFilterEnabled: isHallucinationFilterEnabled(config),
		equalizerEnabled: isEqualizerEnabled(config),
	};
}
