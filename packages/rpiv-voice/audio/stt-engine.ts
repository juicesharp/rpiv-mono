/**
 * stt-engine — thin typed wrapper around sherpa-onnx-node.
 *
 * Type model: sherpa-onnx-node ships no .d.ts files; ambient types live in
 * ./sherpa-onnx-node.d.ts. Config keys are camelCase; the binding maps to
 * snake_case C structs internally.
 *
 * Model layout: Whisper base multilingual — `modelConfig.whisper.{encoder,
 * decoder}`, matching the canonical upstream example
 * `nodejs-addon-examples/test_asr_non_streaming_whisper.js`. We use the int8
 * quantized variants (`base-encoder.int8.onnx`, `base-decoder.int8.onnx`) to
 * keep CPU latency low.
 *
 * Language pre-set: optional `language` (ISO 639-1 like "en", "ru") biases
 * Whisper toward that language for accuracy and skips the per-utterance
 * auto-detect. Threaded from `getActiveLocale()` in voice-command. When
 * undefined, the multilingual model's built-in auto-detect runs — the
 * historical default behavior.
 *
 * Decode path: ASYNCHRONOUS `recognizer.decodeAsync(stream)` — the binding
 * runs the decode as napi async work off the shared event loop, so the loop
 * stays responsive while Whisper infers (the synchronous decode blocked it
 * and froze the UI under load). Construction is asynchronous too
 * (`OfflineRecognizer.createAsync`) — loading the engine no longer blocks
 * the splash render.
 */

import type { Config } from "sherpa-onnx-node";

// ── Whisper fixed input contract ─────────────────────────────────────────────
// 16 kHz mono PCM. featureDim 80 matches the model's mel-spectrogram output.
const WHISPER_SAMPLE_RATE = 16000;
const WHISPER_FEATURE_DIM = 80;

// ── Defaults ─────────────────────────────────────────────────────────────────
// 4 threads is the sweet spot for Whisper base.en on a modern multi-core CPU
// per upstream tuning guidance (whisper.cpp benchmarks; the sherpa-onnx ORT
// thread pool follows the same pattern). More than 4 shows diminishing
// returns and can starve other Pi work on smaller machines.
const DEFAULT_NUM_THREADS = 4;
const DEFAULT_PROVIDER = "cpu";
// `tailPaddings` is the only decoder-adjacent knob sherpa-onnx exposes for
// Whisper. Per maintainer guidance in k2-fsa/sherpa-onnx#2787, audio under
// 30 s makes Whisper miss EOS and hallucinate; padding the encoder input
// reduces the chunk-end EOT bias that produces spurious terminal punctuation.
// 1000 frames ≈ 100 mel-frame steps of trailing silence.
const DEFAULT_TAIL_PADDINGS = 1000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SttEngineConfig {
	encoderPath: string;
	decoderPath: string;
	tokensPath: string;
	/** ISO 639-1 hint (e.g. "en", "ru"). Undefined → Whisper auto-detects. */
	language?: string;
	numThreads?: number;
	provider?: string;
}

export interface SttEngine {
	recognize(samples: Float32Array, sampleRate: number): Promise<string>;
	release(): void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export async function createSttEngine(config: SttEngineConfig): Promise<SttEngine> {
	const ns = await loadSherpaNamespace();
	const recognizer = await ns.OfflineRecognizer.createAsync(buildRecognizerConfig(config));

	return {
		async recognize(samples: Float32Array, sampleRate: number): Promise<string> {
			if (samples.length === 0) return "";
			const stream = recognizer.createStream();
			stream.acceptWaveform({ samples, sampleRate });
			const result = await recognizer.decodeAsync(stream);
			return result.text.trim();
		},
		release(): void {
			// sherpa-onnx-node@1.13.0 exposes no destructor; the native handle is
			// GC-managed. Kept as a no-op so the lifecycle contract is stable for
			// callers and tests.
		},
	};
}

// ── Internal ─────────────────────────────────────────────────────────────────

// sherpa-onnx-node ships as CJS; under ESM dynamic import only
// `OnlineRecognizer` is auto-detected as a named export. Everything else
// (including `OfflineRecognizer`) lives on `.default`. We fall back to the
// namespace itself in case a future ESM build flattens the shape.
async function loadSherpaNamespace(): Promise<{
	OfflineRecognizer: typeof import("sherpa-onnx-node").OfflineRecognizer;
}> {
	const mod = (await import("sherpa-onnx-node")) as Record<string, unknown> & {
		default?: Record<string, unknown>;
	};
	return (mod.default ?? mod) as { OfflineRecognizer: typeof import("sherpa-onnx-node").OfflineRecognizer };
}

function buildRecognizerConfig(config: SttEngineConfig): Config {
	return {
		featConfig: {
			sampleRate: WHISPER_SAMPLE_RATE,
			featureDim: WHISPER_FEATURE_DIM,
		},
		modelConfig: {
			whisper: {
				encoder: config.encoderPath,
				decoder: config.decoderPath,
				tailPaddings: DEFAULT_TAIL_PADDINGS,
				...(config.language ? { language: config.language } : {}),
			},
			tokens: config.tokensPath,
			numThreads: config.numThreads ?? DEFAULT_NUM_THREADS,
			provider: config.provider ?? DEFAULT_PROVIDER,
		},
	};
}
