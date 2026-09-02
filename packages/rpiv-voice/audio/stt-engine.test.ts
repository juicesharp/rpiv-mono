import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock sherpa-onnx-node before importing the module under test.
// The module is loaded via dynamic import(), so we intercept at the module level.
const mockDecode = vi.fn();
const mockGetResult = vi.fn();
const mockDecodeAsync = vi.fn();
const mockAcceptWaveform = vi.fn();
const mockCreateStream = vi.fn(() => ({
	acceptWaveform: mockAcceptWaveform,
}));

// Instance-method seam shared by both construction paths (sync constructor and
// static createAsync) so the two surfaces stay in lockstep.
function makeRecognizerInstance(): Record<string, unknown> {
	return {
		createStream: mockCreateStream,
		decode: mockDecode,
		getResult: mockGetResult,
		decodeAsync: mockDecodeAsync,
	};
}

// Static async factory — the engine's only construction path. Armed per test
// in beforeEach to resolve to a recognizer instance; await-gating tests
// override it with a held promise.
const mockCreateAsync = vi.fn();

const MockOfflineRecognizer = Object.assign(
	vi.fn().mockImplementation(function (this: Record<string, unknown>) {
		Object.assign(this, makeRecognizerInstance());
	}),
	{ createAsync: mockCreateAsync },
);

vi.mock("sherpa-onnx-node", () => ({
	default: { OfflineRecognizer: MockOfflineRecognizer },
	OfflineRecognizer: MockOfflineRecognizer,
}));

import { createSttEngine, type SttEngineConfig } from "./stt-engine.js";

const BASE_CONFIG: SttEngineConfig = {
	encoderPath: "/models/encoder.onnx",
	decoderPath: "/models/decoder.onnx",
	tokensPath: "/models/tokens.txt",
};

function loudSamples(count: number): Float32Array {
	const samples = new Float32Array(count);
	for (let i = 0; i < count; i++) samples[i] = i % 2 === 0 ? 0.5 : -0.5;
	return samples;
}

function armDefaultMocks(): void {
	vi.clearAllMocks();
	mockCreateAsync.mockImplementation(async () => makeRecognizerInstance());
}

describe("createSttEngine", () => {
	beforeEach(armDefaultMocks);

	it("returns an object with recognize and release methods", async () => {
		const engine = await createSttEngine(BASE_CONFIG);
		expect(engine).toHaveProperty("recognize");
		expect(engine).toHaveProperty("release");
		expect(typeof engine.recognize).toBe("function");
		expect(typeof engine.release).toBe("function");
	});

	it("constructs via OfflineRecognizer.createAsync and never the sync constructor", async () => {
		await createSttEngine(BASE_CONFIG);
		expect(mockCreateAsync).toHaveBeenCalledOnce();
		expect(MockOfflineRecognizer).not.toHaveBeenCalled();
	});

	it("passes config to createAsync with correct featConfig", async () => {
		await createSttEngine(BASE_CONFIG);
		const config = mockCreateAsync.mock.calls[0][0];
		expect(config.featConfig).toEqual({ sampleRate: 16000, featureDim: 80 });
	});

	it("uses provided paths in modelConfig.whisper", async () => {
		await createSttEngine(BASE_CONFIG);
		const config = mockCreateAsync.mock.calls[0][0];
		expect(config.modelConfig.whisper.encoder).toBe("/models/encoder.onnx");
		expect(config.modelConfig.whisper.decoder).toBe("/models/decoder.onnx");
		expect(config.modelConfig.tokens).toBe("/models/tokens.txt");
	});

	it("sets tailPaddings to 1000", async () => {
		await createSttEngine(BASE_CONFIG);
		const config = mockCreateAsync.mock.calls[0][0];
		expect(config.modelConfig.whisper.tailPaddings).toBe(1000);
	});

	it("defaults numThreads to 4 and provider to 'cpu'", async () => {
		await createSttEngine(BASE_CONFIG);
		const config = mockCreateAsync.mock.calls[0][0];
		expect(config.modelConfig.numThreads).toBe(4);
		expect(config.modelConfig.provider).toBe("cpu");
	});

	it("uses custom numThreads and provider when provided", async () => {
		await createSttEngine({ ...BASE_CONFIG, numThreads: 8, provider: "cuda" });
		const config = mockCreateAsync.mock.calls[0][0];
		expect(config.modelConfig.numThreads).toBe(8);
		expect(config.modelConfig.provider).toBe("cuda");
	});

	it("includes language in config when provided", async () => {
		await createSttEngine({ ...BASE_CONFIG, language: "en" });
		const config = mockCreateAsync.mock.calls[0][0];
		expect(config.modelConfig.whisper.language).toBe("en");
	});

	it("omits language from config when undefined", async () => {
		await createSttEngine(BASE_CONFIG);
		const config = mockCreateAsync.mock.calls[0][0];
		expect(config.modelConfig.whisper).not.toHaveProperty("language");
	});
});

describe("SttEngine.recognize", () => {
	beforeEach(() => {
		armDefaultMocks();
		mockDecodeAsync.mockResolvedValue({ text: "  hello world  ", tokens: [], timestamps: [] });
	});

	it("returns empty string for empty samples", async () => {
		const engine = await createSttEngine(BASE_CONFIG);
		const result = await engine.recognize(new Float32Array(0), 16000);
		expect(result).toBe("");
		// Should not create a stream or decode for empty input
		expect(mockCreateStream).not.toHaveBeenCalled();
	});

	it("calls acceptWaveform, decodeAsync and returns trimmed text", async () => {
		const engine = await createSttEngine(BASE_CONFIG);
		const samples = loudSamples(1600);
		const result = await engine.recognize(samples, 16000);

		expect(mockCreateStream).toHaveBeenCalledOnce();
		expect(mockAcceptWaveform).toHaveBeenCalledWith({ samples, sampleRate: 16000 });
		expect(mockDecodeAsync).toHaveBeenCalledOnce();
		expect(mockGetResult).not.toHaveBeenCalled();
		expect(mockDecode).not.toHaveBeenCalled();
		expect(result).toBe("hello world");
	});

	it("passes sampleRate through to acceptWaveform", async () => {
		const engine = await createSttEngine(BASE_CONFIG);
		await engine.recognize(loudSamples(800), 44100);
		expect(mockAcceptWaveform).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 44100 }));
	});

	it("returns empty string when recognizer returns empty text", async () => {
		mockDecodeAsync.mockResolvedValue({ text: "", tokens: [], timestamps: [] });
		const engine = await createSttEngine(BASE_CONFIG);
		const result = await engine.recognize(loudSamples(1600), 16000);
		expect(result).toBe("");
	});
});

describe("async gating — native work awaits instead of blocking the event loop", () => {
	beforeEach(() => {
		armDefaultMocks();
		mockDecodeAsync.mockResolvedValue({ text: "hello world", tokens: [], timestamps: [] });
	});

	it("keeps recognize pending while decodeAsync is unresolved; continuations still run", async () => {
		const engine = await createSttEngine(BASE_CONFIG);
		let releaseDecode!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseDecode = resolve;
		});
		mockDecodeAsync.mockReturnValue(gate.then(() => ({ text: "  held decode  ", tokens: [], timestamps: [] })));

		const pending = engine.recognize(loudSamples(1600), 16000);
		let settled = false;
		pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		// A macrotask continuation runs while the decode promise is held —
		// the await gates the pipeline rather than decoding synchronously.
		let continuationRan = false;
		await new Promise<void>((resolve) => {
			setImmediate(() => {
				continuationRan = true;
				resolve();
			});
		});
		expect(continuationRan).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);

		releaseDecode();
		await expect(pending).resolves.toBe("held decode");
	});

	it("keeps createSttEngine pending while createAsync is unresolved", async () => {
		let releaseCreate!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		mockCreateAsync.mockReturnValue(gate.then(() => makeRecognizerInstance()));

		const pendingEngine = createSttEngine(BASE_CONFIG);
		let settled = false;
		pendingEngine.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		let continuationRan = false;
		await new Promise<void>((resolve) => {
			setImmediate(() => {
				continuationRan = true;
				resolve();
			});
		});
		expect(continuationRan).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);

		releaseCreate();
		const engine = await pendingEngine;
		expect(engine).toHaveProperty("recognize");
		expect(engine).toHaveProperty("release");
	});
});

describe("SttEngine.release", () => {
	it("is a no-op (no throw)", async () => {
		const engine = await createSttEngine(BASE_CONFIG);
		expect(() => engine.release()).not.toThrow();
	});
});
