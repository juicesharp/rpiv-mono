import { describe, expect, it } from "vitest";

import { initialVoiceState, type VoiceState } from "../state.js";
import type { BindingContext } from "./contract.js";
import {
	selectHallucinationFilterFieldProps,
	selectLanguageReadonlyFieldProps,
	selectMicReadonlyFieldProps,
	selectNumThreadsReadonlyFieldProps,
	selectStatusBarProps,
	selectTranscriptProps,
} from "./projections.js";

const DICTATION_CTX: BindingContext = { activeView: "dictation" };

function makeState(overrides: Partial<VoiceState> = {}): VoiceState {
	return { ...initialVoiceState({ hallucinationFilterEnabled: true, equalizerEnabled: false }), ...overrides };
}

describe("selectStatusBarProps", () => {
	it("emits dictation footer hints with 'pause' verb when recording", () => {
		const props = selectStatusBarProps(makeState({ status: "recording" }), DICTATION_CTX);
		expect(props.status).toBe("recording");
		expect(props.hints).toEqual(["Enter to paste", "Space to pause", "Tab for settings", "Esc to cancel"]);
	});

	it("emits 'resume' verb on the space hint while paused", () => {
		const props = selectStatusBarProps(makeState({ status: "paused" }), DICTATION_CTX);
		expect(props.status).toBe("paused");
		expect(props.hints).toContain("Space to resume");
		expect(props.hints).not.toContain("Space to pause");
	});

	it("emits settings footer hints on the settings screen", () => {
		const props = selectStatusBarProps(makeState({ currentScreen: "settings" }), DICTATION_CTX);
		expect(props.hints).toEqual(["↑↓ to select", "Enter to toggle", "Ctrl-S to save", "Esc to go back"]);
	});
});

describe("selectTranscriptProps", () => {
	it("passes through the transcript and a placeholder", () => {
		const props = selectTranscriptProps(makeState({ transcript: "hello world" }), DICTATION_CTX);
		expect(props.text).toBe("hello world");
		expect(props.placeholder).toBe("Listening...");
	});

	it("returns an empty transcript when none has been recognized", () => {
		const props = selectTranscriptProps(makeState({ transcript: "" }), DICTATION_CTX);
		expect(props.text).toBe("");
	});
});

describe("selectMicReadonlyFieldProps", () => {
	it("is a constant readonly field — always inactive", () => {
		const props = selectMicReadonlyFieldProps(makeState(), DICTATION_CTX);
		expect(props.active).toBe(false);
		expect(props.label).toBe("Microphone");
		expect(props.field).toEqual({ kind: "readonly", value: "System default input" });
	});
});

describe("selectLanguageReadonlyFieldProps", () => {
	it("is a constant readonly field — always inactive, hint links to /languages", () => {
		const props = selectLanguageReadonlyFieldProps(makeState(), DICTATION_CTX);
		expect(props.active).toBe(false);
		expect(props.label).toBe("Language");
		expect(props.field.kind).toBe("readonly");
		expect(props.hint).toBe("Run /languages to change.");
	});
});

describe("selectNumThreadsReadonlyFieldProps", () => {
	it("is a readonly field stringifying the default thread count", () => {
		const props = selectNumThreadsReadonlyFieldProps(makeState({ numThreads: 4 }), DICTATION_CTX);
		expect(props.active).toBe(false);
		expect(props.label).toBe("Threads");
		expect(props.field).toEqual({ kind: "readonly", value: "4" });
		expect(props.hint).toBe("Set numThreads in voice.json; re-run /voice to apply.");
	});

	it("stringifies a non-default thread count the same way — still inactive", () => {
		const props = selectNumThreadsReadonlyFieldProps(makeState({ numThreads: 8 }), DICTATION_CTX);
		expect(props.field).toEqual({ kind: "readonly", value: "8" });
		expect(props.active).toBe(false);
	});
});

describe("selectHallucinationFilterFieldProps", () => {
	it("reflects the current draft toggle state", () => {
		const onProps = selectHallucinationFilterFieldProps(
			makeState({ settingsDraft: { hallucinationFilterEnabled: true, equalizerEnabled: false } }),
			DICTATION_CTX,
		);
		expect(onProps.label).toBe("Filter Whisper noise");
		expect(onProps.active).toBe(true);
		expect(onProps.field).toEqual({ kind: "toggle", enabled: true });
		expect(onProps.hint).toContain("silence-segment artifacts");

		const offProps = selectHallucinationFilterFieldProps(
			makeState({ settingsDraft: { hallucinationFilterEnabled: false, equalizerEnabled: false } }),
			DICTATION_CTX,
		);
		expect(offProps.field).toEqual({ kind: "toggle", enabled: false });
		// The `active` flag is intentionally constant-true (kept fresh so the
		// settings-form height computation stays stable across screen flips).
		expect(offProps.active).toBe(true);
	});
});
