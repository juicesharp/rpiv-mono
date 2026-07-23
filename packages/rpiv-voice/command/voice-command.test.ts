import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────────────
// vi.mock factories run before module-scope code (they're hoisted). Use
// vi.hoisted to declare shared spies in the same hoisted phase so the mock
// factories can close over them without a TDZ error.
const mocks = vi.hoisted(() => {
	const ensureModelDownloaded = vi.fn();
	const isModelDownloaded = vi.fn(() => true);
	const assertModelIntact = vi.fn();
	const removeModelInstall = vi.fn();
	const getModelPaths = vi.fn(() => ({
		encoderPath: "/m/encoder.onnx",
		decoderPath: "/m/decoder.onnx",
		tokensPath: "/m/tokens.txt",
	}));
	class ModelInstallError extends Error {
		constructor(
			public readonly stage: "download" | "extract" | "verify",
			cause: unknown,
		) {
			super(`install failed: ${stage}`, { cause: cause as Error });
		}
	}
	const sttEngineRelease = vi.fn();
	const createSttEngine = vi.fn(async () => ({
		recognize: vi.fn(async () => ""),
		release: sttEngineRelease,
	}));
	const createMic = vi.fn(async () => ({
		on: vi.fn(),
		once: vi.fn(),
		stop: vi.fn(),
	}));
	const startDictationPipeline = vi.fn(() => ({
		finalTranscriptPromise: Promise.resolve(""),
		isPaused: () => false,
		setPaused: vi.fn(),
		setHallucinationFilterEnabled: vi.fn(),
		stop: vi.fn(),
	}));
	const getActiveLocale = vi.fn<() => string | undefined>(() => undefined);
	const sessionState: { done?: (r: { intent: "commit" | "cancel"; transcript: string }) => void } = {};
	// Regular function (not arrow) — vi.fn wraps it so call counts work, but
	// production code does `new VoiceSession(...)` and arrows can't be
	// constructors.
	const VoiceSession = vi.fn(function (
		this: Record<string, unknown>,
		cfg: { done: NonNullable<typeof sessionState.done> },
	) {
		sessionState.done = cfg.done;
		this.component = { render: () => [], invalidate: () => {}, handleInput: () => {} };
		this.dispatchAction = vi.fn();
		this.tickPulse = vi.fn();
	});
	return {
		ensureModelDownloaded,
		isModelDownloaded,
		assertModelIntact,
		removeModelInstall,
		getModelPaths,
		ModelInstallError,
		sttEngineRelease,
		createSttEngine,
		createMic,
		startDictationPipeline,
		getActiveLocale,
		sessionState,
		VoiceSession,
	};
});

vi.mock("./splash-runner.js", () => ({
	runWithSplash: vi.fn(async (_ctx, _config, work) => {
		const controller = { setPhase: vi.fn() };
		return await work(controller);
	}),
}));

vi.mock("../audio/model-download.js", () => ({
	ensureModelDownloaded: mocks.ensureModelDownloaded,
	isModelDownloaded: mocks.isModelDownloaded,
	assertModelIntact: mocks.assertModelIntact,
	removeModelInstall: mocks.removeModelInstall,
	getModelPaths: mocks.getModelPaths,
	ModelInstallError: mocks.ModelInstallError,
}));

vi.mock("../audio/stt-engine.js", () => ({ createSttEngine: mocks.createSttEngine }));

vi.mock("../audio/mic-source.js", () => ({
	createMic: mocks.createMic,
	TARGET_SAMPLE_RATE: 16000,
	FRAMES_PER_BUFFER: 1600,
}));

vi.mock("../config/voice-config.js", async (importOriginal) => {
	// Keep the real module surface (including `__resetState`, which the repo-
	// wide test/setup.ts beforeEach calls) and only stub the two functions the
	// voice-command file consumes.
	const actual = await importOriginal<typeof import("../config/voice-config.js")>();
	return {
		...actual,
		loadVoiceConfig: vi.fn(() => ({})),
		isHallucinationFilterEnabled: vi.fn(() => true),
	};
});

vi.mock("./pipeline-runner.js", () => ({ startDictationPipeline: mocks.startDictationPipeline }));

vi.mock("../state/voice-session.js", () => ({ VoiceSession: mocks.VoiceSession }));

// `t(key, fallback)` returns the KEY so notify-call assertions can match
// against the canonical i18n key instead of the English copy.
vi.mock("../state/i18n-bridge.js", () => ({
	t: (key: string, _fallback: string) => key,
	getActiveLocale: mocks.getActiveLocale,
	I18N_NAMESPACE: "@juicesharp/rpiv-voice",
}));

const {
	ensureModelDownloaded,
	isModelDownloaded,
	assertModelIntact,
	removeModelInstall,
	ModelInstallError,
	sttEngineRelease,
	createSttEngine,
	createMic,
	startDictationPipeline,
	getActiveLocale,
	sessionState,
} = mocks;

import { registerVoiceCommand, VOICE_COMMAND_NAME } from "./voice-command.js";

// ── Helpers ──────────────────────────────────────────────────────────────────
type Handler = (args: string, ctx: unknown) => Promise<void>;

function captureHandler(): { handler: Handler; registerCommand: ReturnType<typeof vi.fn> } {
	let handler: Handler | undefined;
	const registerCommand = vi.fn((_n: string, spec: { handler: Handler }) => {
		handler = spec.handler;
	});
	registerVoiceCommand({ registerCommand } as never);
	return { handler: handler!, registerCommand };
}

// runPreflight + runDictationSession chain ~half a dozen awaits before the
// VoiceSession constructor captures `done`. Spin the microtask queue a few
// times until the constructor has run.
async function waitForSessionDone(timeoutMs = 500): Promise<void> {
	const start = Date.now();
	while (!sessionState.done && Date.now() - start < timeoutMs) {
		await new Promise<void>((r) => setImmediate(r));
	}
}

function makeCtx(overrides: { notify?: ReturnType<typeof vi.fn>; pasteToEditor?: ReturnType<typeof vi.fn> } = {}) {
	const notify = overrides.notify ?? vi.fn();
	const pasteToEditor = overrides.pasteToEditor ?? vi.fn();
	const ctx = {
		hasUI: true,
		ui: {
			notify,
			pasteToEditor,
			// runDictationSession awaits ctx.ui.custom — invoke the body once with
			// stubs and resolve to whatever the body's `done` is called with.
			custom: vi.fn((body: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown) => {
				return new Promise<unknown>((resolve) => {
					body({ requestRender: vi.fn() }, {}, {}, resolve);
				});
			}),
		},
	};
	return { ctx, notify, pasteToEditor };
}

// ── Existing smoke coverage ─────────────────────────────────────────────────
describe("VOICE_COMMAND_NAME", () => {
	it("exports 'voice'", () => {
		expect(VOICE_COMMAND_NAME).toBe("voice");
	});
});

describe("registerVoiceCommand", () => {
	it("calls pi.registerCommand with the voice command name", () => {
		const registerCommand = vi.fn();
		const pi = { registerCommand } as never;
		registerVoiceCommand(pi);
		expect(registerCommand).toHaveBeenCalledOnce();
		expect(registerCommand.mock.calls[0][0]).toBe("voice");
		expect(registerCommand.mock.calls[0][1]).toHaveProperty("handler");
		expect(typeof registerCommand.mock.calls[0][1].handler).toBe("function");
	});

	it("handler notifies 'requires interactive mode' when hasUI is false", async () => {
		const { handler } = captureHandler();
		const notify = vi.fn();
		await handler("", { hasUI: false, ui: { notify } });
		expect(notify).toHaveBeenCalledOnce();
		expect(notify.mock.calls[0][1]).toBe("error");
	});
});

// ── runPreflight: every error stage maps to its i18n key ────────────────────
describe("startVoiceDictation — preflight error mapping", () => {
	beforeEach(() => {
		// Re-establish happy-path defaults each test so per-test overrides are
		// the only divergence from green.
		isModelDownloaded.mockReturnValue(true);
		ensureModelDownloaded.mockReset();
		assertModelIntact.mockReset();
		removeModelInstall.mockReset();
		createSttEngine.mockReset().mockResolvedValue({
			recognize: vi.fn(async () => ""),
			release: sttEngineRelease,
		});
		createMic.mockReset().mockResolvedValue({ on: vi.fn(), once: vi.fn(), stop: vi.fn() });
		startDictationPipeline.mockClear();
		sttEngineRelease.mockClear();
		sessionState.done = undefined;
	});

	it("download stage → notifies model_download_failed key", async () => {
		isModelDownloaded.mockReturnValue(false);
		ensureModelDownloaded.mockRejectedValueOnce(new ModelInstallError("download", new Error("net")));
		const { handler } = captureHandler();
		const { ctx, notify } = makeCtx();
		await handler("", ctx);
		expect(notify).toHaveBeenCalledWith("error.model_download_failed", "error");
	});

	it("extract stage → notifies model_extract_failed key", async () => {
		isModelDownloaded.mockReturnValue(false);
		ensureModelDownloaded.mockRejectedValueOnce(new ModelInstallError("extract", new Error("tar")));
		const { handler } = captureHandler();
		const { ctx, notify } = makeCtx();
		await handler("", ctx);
		expect(notify).toHaveBeenCalledWith("error.model_extract_failed", "error");
	});

	it("verify stage → notifies model_verify_failed key", async () => {
		isModelDownloaded.mockReturnValue(false);
		ensureModelDownloaded.mockRejectedValueOnce(new ModelInstallError("verify", new Error("missing")));
		const { handler } = captureHandler();
		const { ctx, notify } = makeCtx();
		await handler("", ctx);
		expect(notify).toHaveBeenCalledWith("error.model_verify_failed", "error");
	});

	it("non-ModelInstallError during download → falls back to engine_load_failed", async () => {
		// Bare Error (not ModelInstallError) hits the `?? "download"` fallback
		// inside runPreflight's catch.
		isModelDownloaded.mockReturnValue(false);
		ensureModelDownloaded.mockRejectedValueOnce(new Error("opaque"));
		const { handler } = captureHandler();
		const { ctx, notify } = makeCtx();
		await handler("", ctx);
		expect(notify).toHaveBeenCalledWith("error.model_download_failed", "error");
	});

	it("stale install (assertModelIntact throws) wipes the install and notifies model_stale_install", async () => {
		assertModelIntact.mockImplementationOnce(() => {
			throw new Error("missing onnx");
		});
		const { handler } = captureHandler();
		const { ctx, notify } = makeCtx();
		await handler("", ctx);
		// Recovery: the corrupt install is wiped so the next launch redownloads.
		expect(removeModelInstall).toHaveBeenCalledOnce();
		// User-facing copy must be the stale-install message — not the generic
		// engine_load_failed fallback. This guards a regression where the outer
		// catch around assertModelIntact + createSttEngine flattened every
		// inner PreflightError back to PreflightError("engine") and made the
		// `case "stale_install"` arm of preflightUserMessage unreachable.
		expect(notify).toHaveBeenCalledWith("error.model_stale_install", "error");
	});

	it("engine load failure → notifies engine_load_failed", async () => {
		createSttEngine.mockRejectedValueOnce(new Error("native crash"));
		const { handler } = captureHandler();
		const { ctx, notify } = makeCtx();
		await handler("", ctx);
		expect(notify).toHaveBeenCalledWith("error.engine_load_failed", "error");
	});

	it("mic init failure → releases STT engine and notifies mic_unavailable", async () => {
		createMic.mockRejectedValueOnce(new Error("no input device"));
		const { handler } = captureHandler();
		const { ctx, notify } = makeCtx();
		await handler("", ctx);
		expect(sttEngineRelease).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith("error.mic_unavailable", "error");
	});
});

// ── Whisper language hint, driven via getActiveLocale → createSttEngine ─────
describe("startVoiceDictation — whisper language hint", () => {
	beforeEach(() => {
		isModelDownloaded.mockReturnValue(true);
		assertModelIntact.mockReset();
		createSttEngine.mockReset().mockResolvedValue({
			recognize: vi.fn(async () => ""),
			release: sttEngineRelease,
		});
		createMic.mockReset().mockResolvedValue({ on: vi.fn(), once: vi.fn(), stop: vi.fn() });
		sessionState.done = undefined;
	});

	async function runOnceWithLocale(locale: string | undefined): Promise<unknown> {
		getActiveLocale.mockReturnValue(locale);
		const { handler } = captureHandler();
		const { ctx } = makeCtx();
		const promise = handler("", ctx);
		// Body of ctx.ui.custom captured `latestSessionDone` synchronously when
		// VoiceSession was constructed. Resolve the dictation session with a
		// cancel so the handler returns without trying to paste.
		await waitForSessionDone();
		sessionState.done?.({ intent: "cancel", transcript: "" });
		await promise;
		// `createSttEngine` is hoisted-typed as `() => Promise<...>` (no params)
		// so vi.fn's typing thinks `mock.calls` is `[][]`. Reach for the args via
		// an unknown cast — at runtime production passes a config object.
		const lastCall = createSttEngine.mock.calls.at(-1) as unknown as Array<{ language?: string }>;
		return lastCall?.[0]?.language;
	}

	it("maps a supported locale (uk) to its base language", async () => {
		expect(await runOnceWithLocale("uk")).toBe("uk");
	});

	it("strips the region subtag for IETF tags (pt-BR → pt)", async () => {
		expect(await runOnceWithLocale("pt-BR")).toBe("pt");
	});

	it("falls back to undefined for an unsupported base (xx)", async () => {
		expect(await runOnceWithLocale("xx")).toBeUndefined();
	});

	it("falls back to undefined when no active locale", async () => {
		expect(await runOnceWithLocale(undefined)).toBeUndefined();
	});
});

// ── Happy path: commit dispatch → pasteToEditor ─────────────────────────────
describe("startVoiceDictation — happy path", () => {
	beforeEach(() => {
		isModelDownloaded.mockReturnValue(true);
		assertModelIntact.mockReset();
		createSttEngine.mockReset().mockResolvedValue({
			recognize: vi.fn(async () => ""),
			release: sttEngineRelease,
		});
		createMic.mockReset().mockResolvedValue({ on: vi.fn(), once: vi.fn(), stop: vi.fn() });
		startDictationPipeline.mockClear();
		sessionState.done = undefined;
	});

	it("pastes the transcript when the session ends with intent=commit", async () => {
		const { handler } = captureHandler();
		const { ctx, pasteToEditor } = makeCtx();
		const run = handler("", ctx);
		await waitForSessionDone();
		sessionState.done?.({ intent: "commit", transcript: "hello world" });
		await run;
		expect(pasteToEditor).toHaveBeenCalledWith("hello world");
		// pipeline + STT engine were wired up.
		expect(startDictationPipeline).toHaveBeenCalledOnce();
		expect(sttEngineRelease).toHaveBeenCalledOnce();
	});

	it("does not paste when intent=commit but transcript is empty", async () => {
		const { handler } = captureHandler();
		const { ctx, pasteToEditor } = makeCtx();
		const run = handler("", ctx);
		await waitForSessionDone();
		sessionState.done?.({ intent: "commit", transcript: "" });
		await run;
		expect(pasteToEditor).not.toHaveBeenCalled();
	});

	it("does not paste when intent=cancel", async () => {
		const { handler } = captureHandler();
		const { ctx, pasteToEditor } = makeCtx();
		const run = handler("", ctx);
		await waitForSessionDone();
		sessionState.done?.({ intent: "cancel", transcript: "anything" });
		await run;
		expect(pasteToEditor).not.toHaveBeenCalled();
	});

	it("skips download path when isModelDownloaded() is true", async () => {
		const { handler } = captureHandler();
		const { ctx } = makeCtx();
		const run = handler("", ctx);
		await waitForSessionDone();
		sessionState.done?.({ intent: "cancel", transcript: "" });
		await run;
		expect(ensureModelDownloaded).not.toHaveBeenCalled();
	});

	it("invokes ensureModelDownloaded when isModelDownloaded() is false", async () => {
		isModelDownloaded.mockReturnValue(false);
		ensureModelDownloaded.mockResolvedValueOnce(undefined);
		const { handler } = captureHandler();
		const { ctx } = makeCtx();
		const run = handler("", ctx);
		await waitForSessionDone();
		sessionState.done?.({ intent: "cancel", transcript: "" });
		await run;
		expect(ensureModelDownloaded).toHaveBeenCalledOnce();
	});
});
