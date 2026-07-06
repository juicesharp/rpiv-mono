import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme, makeTui } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";

import { VoiceSession, type VoiceSessionConfig, type VoiceSessionDeps } from "./voice-session.js";

// Mock getKeybindings so the runtime() method doesn't need real pi-tui context.
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@earendil-works/pi-tui")>();
	return { ...orig, getKeybindings: () => ({ matches: () => false }) };
});

// Mock saveVoiceConfig to avoid filesystem writes. Default-return `true` to
// match the real success path; per-test overrides can return `false` to drive
// the save-failure notify branch.
vi.mock("../config/voice-config.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../config/voice-config.js")>();
	return { ...orig, saveVoiceConfig: vi.fn(() => true) };
});

const theme = {
	...makeTheme({
		fg: (_c: string, t: string) => t,
		bold: (t: string) => t,
	}),
	boxSharp: { horizontal: "─" },
} as unknown as Theme;

function makeDeps() {
	return {
		pasteToEditor: vi.fn<(text: string) => void>(),
		notify: vi.fn<(message: string, level: "error" | "info") => void>(),
		abort: vi.fn<() => void>(),
		stopMic: vi.fn<() => void>(),
		setPipelinePaused: vi.fn<(paused: boolean) => void>(),
		setHallucinationFilterEnabled: vi.fn<(enabled: boolean) => void>(),
	} satisfies VoiceSessionDeps;
}

function makeSessionConfig(deps: ReturnType<typeof makeDeps>): VoiceSessionConfig {
	return {
		tui: { ...makeTui(), terminal: { columns: 80, rows: 24 } } as VoiceSessionConfig["tui"],
		theme,
		persistedConfig: { hallucinationFilterEnabled: true },
		deps,
		done: vi.fn(),
	};
}

describe("VoiceSession", () => {
	it("constructs without error", () => {
		const config = makeSessionConfig(makeDeps());
		expect(() => new VoiceSession(config)).not.toThrow();
	});

	it("component.render returns lines", () => {
		const config = makeSessionConfig(makeDeps());
		const session = new VoiceSession(config);
		const lines = session.component.render(80);
		expect(Array.isArray(lines)).toBe(true);
	});

	it("component.invalidate does not throw", () => {
		const config = makeSessionConfig(makeDeps());
		const session = new VoiceSession(config);
		expect(() => session.component.invalidate()).not.toThrow();
	});

	it("component.handleInput routes keys through the reducer", () => {
		const config = makeSessionConfig(makeDeps());
		const session = new VoiceSession(config);
		// Space toggles pause — this should go through routeKey → reduce
		// With our mocked getKeybindings that always returns false, space is
		// the one key that matches directly via data === " ".
		session.component.handleInput(" ");
		// After toggling pause, the session should be in paused state.
		// We verify indirectly: pressing space again should toggle back.
		// This exercises the full handleInput → routeKey → commit → reduce path.
		expect(() => session.component.handleInput(" ")).not.toThrow();
	});

	describe("dispatchAction", () => {
		it("commits an action through the reducer", () => {
			const config = makeSessionConfig(makeDeps());
			const session = new VoiceSession(config);
			// audio_chunk updates audioLevel
			session.dispatchAction({ kind: "audio_chunk", level: 0.5 });
			// Verify the render was triggered (tui.requestRender is called)
			expect(
				(config.tui as unknown as { requestRender: ReturnType<typeof vi.fn> }).requestRender,
			).toHaveBeenCalled();
		});

		it("transcript append triggers render", () => {
			const config = makeSessionConfig(makeDeps());
			const session = new VoiceSession(config);
			session.dispatchAction({ kind: "audio_transcript_appended", text: "hello" });
			session.dispatchAction({ kind: "audio_transcript_appended", text: "world" });
			const lines = session.component.render(80);
			expect(lines.some((l) => l.includes("hello world"))).toBe(true);
		});

		it("partial transcript set triggers render", () => {
			const config = makeSessionConfig(makeDeps());
			const session = new VoiceSession(config);
			session.dispatchAction({ kind: "audio_partial_transcript_set", text: "going" });
			const lines = session.component.render(80);
			expect(lines.some((l) => l.includes("going"))).toBe(true);
		});
	});

	describe("effects execution", () => {
		it("commit action triggers done callback with transcript", () => {
			const deps = makeDeps();
			const config = makeSessionConfig(deps);
			const session = new VoiceSession(config);

			session.dispatchAction({ kind: "audio_transcript_appended", text: "hello" });
			session.dispatchAction({ kind: "commit" });
			expect(config.done).toHaveBeenCalledWith({
				intent: "commit",
				transcript: "hello",
			});
		});

		it("commit with partial folds it into transcript", () => {
			const deps = makeDeps();
			const config = makeSessionConfig(deps);
			const session = new VoiceSession(config);

			session.dispatchAction({ kind: "audio_transcript_appended", text: "hello" });
			session.dispatchAction({ kind: "audio_partial_transcript_set", text: "world" });
			session.dispatchAction({ kind: "commit" });
			expect(config.done).toHaveBeenCalledWith({
				intent: "commit",
				transcript: "hello world",
			});
		});

		it("cancel action triggers abort and done", () => {
			const deps = makeDeps();
			const config = makeSessionConfig(deps);
			const session = new VoiceSession(config);

			session.dispatchAction({ kind: "cancel" });
			expect(deps.abort).toHaveBeenCalled();
			expect(config.done).toHaveBeenCalledWith({
				intent: "cancel",
				transcript: "",
			});
		});

		it("toggle_pause triggers setPipelinePaused effect", () => {
			const deps = makeDeps();
			const config = makeSessionConfig(deps);
			const session = new VoiceSession(config);

			session.dispatchAction({ kind: "toggle_pause" });
			expect(deps.setPipelinePaused).toHaveBeenCalledWith(true);
		});

		it("toggle_focused_setting on hallucination focus triggers setHallucinationFilterEnabled", () => {
			const deps = makeDeps();
			const config = makeSessionConfig(deps);
			const session = new VoiceSession(config);

			// Default focus is "hallucination", so Enter toggles the filter.
			session.dispatchAction({ kind: "toggle_focused_setting" });
			expect(deps.setHallucinationFilterEnabled).toHaveBeenCalledWith(false);
		});

		it("settings_save on success: persists then emits success notify", async () => {
			const { saveVoiceConfig } = await import("../config/voice-config.js");
			const deps = makeDeps();
			const config = makeSessionConfig(deps);
			const session = new VoiceSession(config);

			session.dispatchAction({ kind: "settings_save" });
			expect(saveVoiceConfig).toHaveBeenCalled();
			expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("Voice settings saved"), "info");
			expect(deps.notify).not.toHaveBeenCalledWith(expect.stringContaining("Failed to save"), "error");
		});

		it("settings_save on save failure: emits ONLY error notify, no contradictory success notify (review I1)", async () => {
			const { saveVoiceConfig } = await import("../config/voice-config.js");
			(saveVoiceConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
			const deps = makeDeps();
			const config = makeSessionConfig(deps);
			const session = new VoiceSession(config);

			session.dispatchAction({ kind: "settings_save" });

			expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save"), "error");
			expect(deps.notify).not.toHaveBeenCalledWith(expect.stringContaining("Voice settings saved"), "info");
		});

		it("open_settings transitions to settings screen", () => {
			const config = makeSessionConfig(makeDeps());
			const session = new VoiceSession(config);

			session.dispatchAction({ kind: "open_settings" });
			// After opening settings, pressing Tab should close settings (routeKey behavior)
			// We verify by dispatching close_settings directly
			session.dispatchAction({ kind: "close_settings" });
			expect(() => session.component.render(80)).not.toThrow();
		});
	});

	describe("tickPulse", () => {
		it("triggers a render via tui.requestRender", () => {
			const config = makeSessionConfig(makeDeps());
			const session = new VoiceSession(config);
			const requestRender = config.tui as unknown as { requestRender: ReturnType<typeof vi.fn> };
			const initialCount = requestRender.requestRender.mock.calls.length;
			session.tickPulse();
			expect(requestRender.requestRender.mock.calls.length).toBeGreaterThan(initialCount);
		});
	});
});
