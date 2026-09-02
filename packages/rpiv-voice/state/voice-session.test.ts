import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme, makeTui } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";

import type { VoiceConfig } from "../config/voice-config.js";
import { VoiceSession, type VoiceSessionConfig, type VoiceSessionDeps } from "./voice-session.js";

// Mock getKeybindings so the runtime() method doesn't need real pi-tui context.
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@earendil-works/pi-tui")>();
	return { ...orig, getKeybindings: () => ({ matches: () => false }) };
});

// Mock saveVoiceConfig to avoid filesystem writes. Default-return `true` to
// match the real success path; per-test overrides can return `false` to drive
// the save-failure notify branch. loadVoiceConfig is mocked too: the shell
// re-reads it at save time (review I4), so tests control "the file as it is
// now" through this mock rather than the constructor snapshot.
vi.mock("../config/voice-config.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../config/voice-config.js")>();
	return { ...orig, saveVoiceConfig: vi.fn(() => true), loadVoiceConfig: vi.fn(() => ({})) };
});

const theme = makeTheme({
	fg: (_c: string, t: string) => t,
	bold: (t: string) => t,
}) as unknown as Theme;

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

function makeSessionConfig(
	deps: ReturnType<typeof makeDeps>,
	persistedConfig: VoiceConfig = { hallucinationFilterEnabled: true },
): VoiceSessionConfig {
	return {
		tui: { ...makeTui(), terminal: { columns: 80, rows: 24 } } as VoiceSessionConfig["tui"],
		theme,
		persistedConfig,
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

	describe("settings screen threads row", () => {
		it("renders the Threads label and a hand-configured thread count", () => {
			const deps = makeDeps();
			const config: VoiceSessionConfig = {
				...makeSessionConfig(deps),
				persistedConfig: { numThreads: 8 } as VoiceSessionConfig["persistedConfig"],
			};
			const session = new VoiceSession(config);

			session.dispatchAction({ kind: "open_settings" });
			const lines = session.component.render(80);
			// The row line is `  Threads: 8` — the hint line mentions numThreads
			// too, so assert on the label+value pairing, not the bare label.
			expect(lines.some((l) => l.includes("Threads: 8"))).toBe(true);
			// Fifth row: after the Equalizer row, before the footer chrome.
			const equalizerIdx = lines.findIndex((l) => l.includes("Equalizer:"));
			const threadsIdx = lines.findIndex((l) => l.includes("Threads: 8"));
			expect(threadsIdx).toBeGreaterThan(equalizerIdx);
		});

		it("renders the resolved default 4 for a default config (real decoder via the spread mock)", () => {
			const deps = makeDeps();
			const config: VoiceSessionConfig = {
				...makeSessionConfig(deps),
				persistedConfig: {} as VoiceSessionConfig["persistedConfig"],
			};
			const session = new VoiceSession(config);

			session.dispatchAction({ kind: "open_settings" });
			const lines = session.component.render(80);
			expect(lines.some((l) => l.includes("Threads: 4"))).toBe(true);
		});
	});

	describe("config round-trip durability", () => {
		it("settings_save keeps numThreads from the on-disk config (Ctrl-S path)", async () => {
			const { loadVoiceConfig, saveVoiceConfig } = await import("../config/voice-config.js");
			vi.mocked(saveVoiceConfig).mockClear();
			vi.mocked(loadVoiceConfig).mockReturnValue({ numThreads: 8, equalizerEnabled: true } as VoiceConfig);
			const deps = makeDeps();
			const config = makeSessionConfig(deps, { numThreads: 8, equalizerEnabled: true } as VoiceConfig);
			const session = new VoiceSession(config);

			session.dispatchAction({ kind: "settings_save" });

			expect(saveVoiceConfig).toHaveBeenCalledWith(expect.objectContaining({ numThreads: 8 }));
		});

		it("close_settings keeps numThreads from the on-disk config (silent Esc path)", async () => {
			const { loadVoiceConfig, saveVoiceConfig } = await import("../config/voice-config.js");
			vi.mocked(saveVoiceConfig).mockClear();
			vi.mocked(loadVoiceConfig).mockReturnValue({ numThreads: 8, equalizerEnabled: true } as VoiceConfig);
			const deps = makeDeps();
			const config = makeSessionConfig(deps, { numThreads: 8, equalizerEnabled: true } as VoiceConfig);
			const session = new VoiceSession(config);

			session.dispatchAction({ kind: "close_settings" });

			expect(saveVoiceConfig).toHaveBeenCalledWith(expect.objectContaining({ numThreads: 8 }));
		});

		it("a mid-session hand edit of a JSON-only key survives a save — merge reads disk, not the session-start snapshot (review I4)", async () => {
			const { loadVoiceConfig, saveVoiceConfig } = await import("../config/voice-config.js");
			vi.mocked(saveVoiceConfig).mockClear();
			// Session started with no numThreads on disk…
			vi.mocked(loadVoiceConfig).mockReturnValue({});
			const deps = makeDeps();
			const config = makeSessionConfig(deps, {});
			const session = new VoiceSession(config);

			// …then the user hand-edits voice.json while the overlay is open.
			vi.mocked(loadVoiceConfig).mockReturnValue({ numThreads: 12 } as VoiceConfig);
			session.dispatchAction({ kind: "settings_save" });

			expect(saveVoiceConfig).toHaveBeenCalledWith(expect.objectContaining({ numThreads: 12 }));
		});

		it("default draft over an empty persisted config still saves {} (voice.json stays minimal)", async () => {
			const { loadVoiceConfig, saveVoiceConfig } = await import("../config/voice-config.js");
			vi.mocked(saveVoiceConfig).mockClear();
			vi.mocked(loadVoiceConfig).mockReturnValue({});
			const deps = makeDeps();
			const config = makeSessionConfig(deps, {});
			const session = new VoiceSession(config);

			session.dispatchAction({ kind: "settings_save" });

			expect(saveVoiceConfig).toHaveBeenCalledWith({});
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
