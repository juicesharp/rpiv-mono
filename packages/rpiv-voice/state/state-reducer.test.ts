import { describe, expect, it } from "vitest";
import type { VoiceConfig } from "../config/voice-config.js";
import { initialVoiceState } from "./state.js";
import { type ApplyContext, configFromDraft, draftFromConfig, reduce } from "./state-reducer.js";
import { STATUS_META } from "./status-intent.js";

const ctx: ApplyContext = { persistedConfig: {} };

function freshState() {
	return initialVoiceState(draftFromConfig({}));
}

describe("reduce", () => {
	it("audio_chunk updates audioLevel and requests render", () => {
		const s = freshState();
		const r = reduce(s, { kind: "audio_chunk", level: 0.4 }, ctx);
		expect(r.state.audioLevel).toBe(0.4);
		expect(r.effects.find((e) => e.kind === "request_render")).toBeTruthy();
	});

	it("audio_chunk with same level is a no-op (no effects)", () => {
		const s = freshState();
		const r = reduce(s, { kind: "audio_chunk", level: 0 }, ctx);
		expect(r.effects).toHaveLength(0);
	});

	it("audio_transcript_appended concatenates with a space", () => {
		let s = freshState();
		s = reduce(s, { kind: "audio_transcript_appended", text: "hello" }, ctx).state;
		s = reduce(s, { kind: "audio_transcript_appended", text: "world" }, ctx).state;
		expect(s.transcript).toBe("hello world");
	});

	it("audio_partial_transcript_set replaces the partial wholesale", () => {
		let s = freshState();
		s = reduce(s, { kind: "audio_partial_transcript_set", text: "I am" }, ctx).state;
		expect(s.partialTranscript).toBe("I am");
		s = reduce(s, { kind: "audio_partial_transcript_set", text: "I am going to" }, ctx).state;
		expect(s.partialTranscript).toBe("I am going to");
	});

	it("audio_partial_transcript_set with the same text is a no-op (no effects)", () => {
		const s = { ...freshState(), partialTranscript: "stable" };
		const r = reduce(s, { kind: "audio_partial_transcript_set", text: "stable" }, ctx);
		expect(r.effects).toHaveLength(0);
	});

	it("audio_transcript_appended commits and clears the partial", () => {
		let s = { ...freshState(), partialTranscript: "I am goin" };
		s = reduce(s, { kind: "audio_transcript_appended", text: "I am going home" }, ctx).state;
		expect(s.transcript).toBe("I am going home");
		expect(s.partialTranscript).toBe("");
	});

	it("audio_transcript_appended with empty text still clears a stale partial", () => {
		let s = { ...freshState(), partialTranscript: "stale" };
		s = reduce(s, { kind: "audio_transcript_appended", text: "" }, ctx).state;
		expect(s.partialTranscript).toBe("");
	});

	it("toggle_pause flips status and emits set_pipeline_paused matching STATUS_META", () => {
		const s = freshState();
		const r = reduce(s, { kind: "toggle_pause" }, ctx);
		expect(r.state.status).toBe("paused");
		const effect = r.effects.find((e) => e.kind === "set_pipeline_paused");
		expect(effect).toEqual({ kind: "set_pipeline_paused", paused: STATUS_META.paused.gatesSttPipeline });
	});

	it("commit emits done with the live transcript", () => {
		let s = freshState();
		s = reduce(s, { kind: "audio_transcript_appended", text: "hi" }, ctx).state;
		const r = reduce(s, { kind: "commit" }, ctx);
		expect(r.effects).toContainEqual({ kind: "done", result: { intent: "commit", transcript: "hi" } });
	});

	it("commit folds the in-flight partial into the committed transcript", () => {
		let s = freshState();
		s = reduce(s, { kind: "audio_transcript_appended", text: "hello" }, ctx).state;
		s = reduce(s, { kind: "audio_partial_transcript_set", text: "world" }, ctx).state;
		const r = reduce(s, { kind: "commit" }, ctx);
		expect(r.effects).toContainEqual({
			kind: "done",
			result: { intent: "commit", transcript: "hello world" },
		});
	});

	it("commit with only a partial (no committed text) returns just the partial", () => {
		let s = freshState();
		s = reduce(s, { kind: "audio_partial_transcript_set", text: "first words" }, ctx).state;
		const r = reduce(s, { kind: "commit" }, ctx);
		expect(r.effects).toContainEqual({
			kind: "done",
			result: { intent: "commit", transcript: "first words" },
		});
	});

	it("cancel emits abort_session and done with empty transcript", () => {
		const s = freshState();
		const r = reduce(s, { kind: "cancel" }, ctx);
		expect(r.effects.some((e) => e.kind === "abort_session")).toBe(true);
		expect(r.effects).toContainEqual({ kind: "done", result: { intent: "cancel", transcript: "" } });
	});

	it("open_settings transitions screen to settings", () => {
		const s = freshState();
		const r = reduce(s, { kind: "open_settings" }, ctx);
		expect(r.state.currentScreen).toBe("settings");
	});

	it("close_settings returns to dictation and persists the draft (no notify)", () => {
		const s = {
			...freshState(),
			currentScreen: "settings" as const,
			settingsDraft: { hallucinationFilterEnabled: true, equalizerEnabled: true },
		};
		const r = reduce(s, { kind: "close_settings" }, ctx);
		expect(r.state.currentScreen).toBe("dictation");
		expect(r.effects).toContainEqual({ kind: "save_config", config: { equalizerEnabled: true } });
		expect(r.effects.some((e) => e.kind === "notify")).toBe(false);
	});

	it("toggle_focused_setting on hallucination focus flips the filter draft and emits the effect", () => {
		const s = { ...freshState(), settingsFocus: "hallucination" as const };
		expect(s.settingsDraft.hallucinationFilterEnabled).toBe(true);
		const r = reduce(s, { kind: "toggle_focused_setting" }, ctx);
		expect(r.state.settingsDraft.hallucinationFilterEnabled).toBe(false);
		expect(r.effects).toContainEqual({ kind: "set_hallucination_filter", enabled: false });
	});

	it("toggle_focused_setting on equalizer focus flips the equalizer draft (no pipeline effect)", () => {
		const s = { ...freshState(), settingsFocus: "equalizer" as const };
		expect(s.settingsDraft.equalizerEnabled).toBe(false);
		const r = reduce(s, { kind: "toggle_focused_setting" }, ctx);
		expect(r.state.settingsDraft.equalizerEnabled).toBe(true);
		// Equalizer is purely view-side — no pipeline-reconfig effect.
		expect(r.effects.some((e) => e.kind === "set_hallucination_filter")).toBe(false);
		expect(r.effects).toContainEqual({ kind: "request_render" });
	});

	it("focus_settings_next / focus_settings_prev cycle through the field order", () => {
		const start = { ...freshState(), settingsFocus: "hallucination" as const };
		const next = reduce(start, { kind: "focus_settings_next" }, ctx);
		expect(next.state.settingsFocus).toBe("equalizer");
		const wrap = reduce(next.state, { kind: "focus_settings_next" }, ctx);
		expect(wrap.state.settingsFocus).toBe("hallucination");
		const prev = reduce(start, { kind: "focus_settings_prev" }, ctx);
		expect(prev.state.settingsFocus).toBe("equalizer");
	});

	it("settings_save with all defaults writes an empty config", () => {
		const s = freshState();
		const r = reduce(s, { kind: "settings_save" }, ctx);
		expect(r.effects).toContainEqual(expect.objectContaining({ kind: "save_config", config: {} }));
	});

	it("settings_save persists hallucinationFilterEnabled when user disables it", () => {
		const s = { ...freshState(), settingsDraft: { hallucinationFilterEnabled: false, equalizerEnabled: false } };
		const r = reduce(s, { kind: "settings_save" }, ctx);
		expect(r.effects).toContainEqual(
			expect.objectContaining({ kind: "save_config", config: { hallucinationFilterEnabled: false } }),
		);
	});

	it("settings_save persists equalizerEnabled when user enables it", () => {
		const s = { ...freshState(), settingsDraft: { hallucinationFilterEnabled: true, equalizerEnabled: true } };
		const r = reduce(s, { kind: "settings_save" }, ctx);
		expect(r.effects).toContainEqual(
			expect.objectContaining({ kind: "save_config", config: { equalizerEnabled: true } }),
		);
	});

	it("settings_save attaches a success message to save_config (no separate notify effect — review I1)", () => {
		const s = freshState();
		const r = reduce(s, { kind: "settings_save" }, ctx);
		// Single save_config effect carries the success copy; no standalone notify
		// effect — otherwise the loop would emit it unconditionally on save failure.
		expect(r.effects).toHaveLength(1);
		expect(r.effects[0]).toMatchObject({ kind: "save_config", successMessage: "Voice settings saved" });
	});

	it("close_settings emits a save_config WITHOUT a successMessage (silent persist)", () => {
		const s = { ...freshState(), currentScreen: "settings" as const };
		const r = reduce(s, { kind: "close_settings" }, ctx);
		const save = r.effects.find((e) => e.kind === "save_config");
		expect(save).toBeDefined();
		expect((save as { successMessage?: string }).successMessage).toBeUndefined();
	});

	it("close_settings round-trips non-owned persisted keys (numThreads survives the silent Esc-save)", () => {
		const s = { ...freshState(), currentScreen: "settings" as const };
		const r = reduce(s, { kind: "close_settings" }, { persistedConfig: { numThreads: 8 } as VoiceConfig });
		expect(r.effects).toContainEqual(
			expect.objectContaining({ kind: "save_config", config: expect.objectContaining({ numThreads: 8 }) }),
		);
	});

	it("settings_save round-trips non-owned persisted keys (numThreads survives Ctrl-S)", () => {
		const s = freshState();
		const r = reduce(s, { kind: "settings_save" }, { persistedConfig: { numThreads: 8 } as VoiceConfig });
		expect(r.effects).toContainEqual(
			expect.objectContaining({ kind: "save_config", config: expect.objectContaining({ numThreads: 8 }) }),
		);
	});
});

describe("configFromDraft / draftFromConfig", () => {
	it("draftFromConfig defaults hallucination filter to enabled", () => {
		expect(draftFromConfig({})).toEqual({ hallucinationFilterEnabled: true, equalizerEnabled: false });
	});

	it("draftFromConfig preserves an explicit `false` disable", () => {
		expect(draftFromConfig({ hallucinationFilterEnabled: false, equalizerEnabled: false })).toEqual({
			hallucinationFilterEnabled: false,
			equalizerEnabled: false,
		});
	});

	it("configFromDraft drops both default flags", () => {
		expect(configFromDraft({ hallucinationFilterEnabled: true, equalizerEnabled: false }, {})).toEqual({});
	});

	it("configFromDraft persists the off-state of the filter", () => {
		expect(configFromDraft({ hallucinationFilterEnabled: false, equalizerEnabled: false }, {})).toEqual({
			hallucinationFilterEnabled: false,
		});
	});

	it("configFromDraft persists the on-state of the equalizer", () => {
		expect(configFromDraft({ hallucinationFilterEnabled: true, equalizerEnabled: true }, {})).toEqual({
			equalizerEnabled: true,
		});
	});

	it("configFromDraft passes non-owned keys through untouched (numThreads, language, future keys)", () => {
		const draft = { hallucinationFilterEnabled: true, equalizerEnabled: false };
		expect(configFromDraft(draft, { numThreads: 8, language: "uk" } as VoiceConfig)).toEqual({
			numThreads: 8,
			language: "uk",
		});
	});

	it("configFromDraft is draft-authoritative for owned keys — a default draft drops persisted owned non-defaults", () => {
		const draft = { hallucinationFilterEnabled: true, equalizerEnabled: false };
		expect(
			configFromDraft(draft, {
				hallucinationFilterEnabled: false,
				equalizerEnabled: true,
				numThreads: 8,
			} as VoiceConfig),
		).toEqual({ numThreads: 8 });
	});

	it("configFromDraft merges pass-through keys with draft-derived owned keys", () => {
		const draft = { hallucinationFilterEnabled: false, equalizerEnabled: false };
		expect(configFromDraft(draft, { numThreads: 8, language: "uk" } as VoiceConfig)).toEqual({
			numThreads: 8,
			language: "uk",
			hallucinationFilterEnabled: false,
		});
	});

	it("configFromDraft skips a hand-edited __proto__ key instead of tripping the prototype setter", () => {
		const draft = { hallucinationFilterEnabled: true, equalizerEnabled: false };
		// JSON.parse surfaces __proto__ as an own-enumerable key; a computed
		// assignment would replace the accumulator's prototype rather than
		// round-trip the key.
		const persisted = JSON.parse('{"__proto__":{"polluted":true},"numThreads":8}') as VoiceConfig;
		const out = configFromDraft(draft, persisted);
		expect(out).toEqual({ numThreads: 8 });
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
	});

	it("draftFromConfig hydrates the equalizer flag from persisted on-state", () => {
		expect(draftFromConfig({ equalizerEnabled: true })).toEqual({
			hallucinationFilterEnabled: true,
			equalizerEnabled: true,
		});
	});
});
