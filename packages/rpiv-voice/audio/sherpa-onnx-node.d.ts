// Ambient type declarations for sherpa-onnx-node (no .d.ts shipped upstream).
// Mirrors `nodejs-addon-examples/test_asr_non_streaming_whisper.js` from
// k2-fsa/sherpa-onnx — top-level keys are camelCase; binding converts to
// snake_case C struct internally.

declare module "sherpa-onnx-node" {
	export interface Samples {
		samples: Float32Array;
		sampleRate: number;
	}
	export interface Result {
		text: string;
		tokens: string[];
		timestamps: number[];
	}
	export interface Stream {
		acceptWaveform(input: Samples): void;
	}
	// Note: OfflineRecognizer has no release/destroy/free method in
	// sherpa-onnx-node@1.13.0 — the native handle is GC-managed.
	// The engine uses the async pair — `OfflineRecognizer.createAsync` for
	// construction and `decodeAsync` for decoding — which runs as napi async
	// work off the shared event loop. `decodeAsync` resolves the parsed
	// result, so `getResult` is not needed on the async path. The
	// synchronous `decode` + `getResult` pair stays declared: this d.ts
	// mirrors the binding's full surface.
	export interface Recognizer {
		createStream(): Stream;
		decode(stream: Stream): void;
		getResult(stream: Stream): Result;
		decodeAsync(stream: Stream): Promise<Result>;
	}
	// Whisper config: `language` and `task` are optional (and meaningless for
	// the *.en monolingual variants — the upstream example omits them
	// entirely). `tailPaddings` defaults to 0.
	export interface WhisperModelConfig {
		encoder: string;
		decoder: string;
		language?: string;
		task?: string;
		tailPaddings?: number;
	}
	export interface Config {
		featConfig: { sampleRate: number; featureDim: number };
		modelConfig: {
			whisper: WhisperModelConfig;
			tokens: string;
			numThreads?: number;
			provider?: string;
		};
	}
	// The binding exposes both a sync constructor and an async factory.
	// The canonical examples use the sync constructor; we keep both signatures
	// here so consumers can pick.
	export interface OfflineRecognizerCtor {
		new (config: Config): Recognizer;
		createAsync(config: Config): Promise<Recognizer>;
	}
	export const OfflineRecognizer: OfflineRecognizerCtor;
}
