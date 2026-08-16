import { EventEmitter } from "node:events";
import { appendDiagnosticLog } from "./error-log.js";
import { computeRmsInt16 } from "./pcm.js";
import { Int16LinearResampler } from "./resampler.js";

// Public 16 kHz target — Whisper's input rate, also the only rate the
// downstream pipeline understands (segment caps, RMS thresholds, etc. are
// all expressed in 16 kHz samples). `FRAMES_PER_BUFFER` is the chunk size
// at the target rate; capture is sized proportionally so each forwarded
// chunk lands on roughly the same 100 ms cadence regardless of device.
export const TARGET_SAMPLE_RATE = 16000;
export const FRAMES_PER_BUFFER = 1600;

// Strategy 1: capture at 16 kHz with decibri's bundled Silero VAD. Works
// on USB headsets, AirPods, most external mics — the device negotiates
// 16 kHz cleanly and Silero's ML-based detection handles noisy
// environments meaningfully better than an RMS gate.
//
// Strategy 2 (fallback): capture at the device's native rate (commonly
// 48 kHz on macOS built-in mics), resample to 16 kHz in JS, and run a
// JS-side RMS-energy gate for silence detection. Silero refuses non-
// 8/16 kHz rates at construction so we can't keep it in this path.
const SILERO_THRESHOLD = 0.5;

// RMS-gate threshold (normalized [0, 1]) used by the fallback adapter.
// Sits between the hallucination floor in pipeline-runner (0.005 ≈
// -46 dBFS, treated as "no audible content") and quiet speech
// (~-30 dBFS). 0.015 ≈ -36 dBFS catches soft speech without triggering
// on typical room noise.
const VAD_RMS_THRESHOLD = 0.015;

// Hangover before emitting `silence`, shared by both adapters. decibri's
// 300 ms default flushed mid-clause at natural breath pauses, which
// forced Whisper to "complete" an unterminated phrase with a spurious
// period. 700 ms eliminated that but felt laggy. 500 ms is the LiveKit
// value: covers most natural breath pauses, keeps the perceived gap to
// ~half a second.
const VAD_HOLDOFF_MS = 500;

// Tried in order in the resample-rms fallback path if the default
// input device's `defaultSampleRate` isn't available or that rate also
// fails. 48 kHz first (macOS built-in mic native rate, cpal common
// ground); 44.1 kHz next (near-universal on USB audio); 96 kHz last
// (newer Apple Silicon mics).
const FALLBACK_CAPTURE_RATES = [48000, 44100, 96000] as const;

// Upper bound on how long we wait for either the first `data` event
// (success) or an `error` event (device refused our config) before
// resolving optimistically. cpal/decibri surfaces config rejection
// within tens of milliseconds in practice; 1.5 s is comfortable
// headroom without making `/voice` feel laggy when the mic genuinely
// takes a moment to start producing samples.
const STARTUP_RACE_MS = 1500;

export interface DecibriLike {
	on(event: "data", listener: (chunk: Buffer) => void): unknown;
	on(event: "speech" | "silence", listener: () => void): unknown;
	once(event: "end" | "error" | "close", listener: (err?: Error) => void): unknown;
	stop(): void;
}

interface DecibriDevice {
	index: number;
	name: string;
	id?: string;
	maxInputChannels: number;
	defaultSampleRate: number;
	isDefault: boolean;
}

interface DecibriRaw extends EventEmitter {
	stop(): void;
}

interface DecibriCtor {
	new (opts: Record<string, unknown>): DecibriRaw;
	devices?(): DecibriDevice[];
}

type MicMode = "silero-passthrough" | "resample-rms";

export async function createMic(): Promise<DecibriLike> {
	const Decibri = await loadDecibriCtor();

	// Strategy 1: 16 kHz with Silero. If the device accepts 16 kHz capture
	// (USB headsets, AirPods, most external mics), this is strictly better
	// than the fallback — Silero's ML detection beats an RMS gate in noisy
	// environments. If the device refuses (built-in macOS mics — issue #46),
	// decibri's async `error` propagates out and we fall through.
	try {
		const mic = await openMicAtRate(Decibri, TARGET_SAMPLE_RATE, "silero-passthrough");
		appendDiagnosticLog("mic.path", `silero-passthrough@${TARGET_SAMPLE_RATE}Hz`);
		return mic;
	} catch (sileroErr) {
		appendDiagnosticLog(
			"mic.path",
			`silero-passthrough@${TARGET_SAMPLE_RATE}Hz refused (${describeError(sileroErr)}); falling back to resample-rms`,
		);

		const rates = pickCaptureRates(Decibri).filter((r) => r !== TARGET_SAMPLE_RATE);
		let lastError: Error = sileroErr instanceof Error ? sileroErr : new Error(String(sileroErr));
		for (const rate of rates) {
			try {
				const mic = await openMicAtRate(Decibri, rate, "resample-rms");
				appendDiagnosticLog("mic.path", `resample-rms@${rate}Hz`);
				return mic;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
			}
		}
		throw lastError;
	}
}

// decibri ships no darwin-x64 (Intel Mac) prebuilt native addon as of this
// writing. On that one platform, import("decibri") throws at the native-
// addon-load step. Fall back to a local compatibility shim built on
// @audio/mic (miniaudio backend, ships a darwin-x64 prebuilt) so darwin-x64
// users get the same resample-rms fallback quality that built-in-mic users
// already get today (see issue #46 in juicesharp/rpiv-mono — this reuses
// that exact code path, unmodified). Every other platform is unaffected:
// import("decibri") succeeds there and this catch branch never runs.
//
// Resolution is memoized at module scope (once per process), not
// re-attempted on every createMic() call. Observed live: on darwin-x64, the
// first /voice invocation in a process correctly falls back to the shim and
// works, but repeated /voice invocations within the SAME long-lived process
// intermittently produced "Decibri is not a constructor" with no shim
// fallback log line at all — consistent with import("decibri")'s cached
// module-evaluation state behaving inconsistently across repeated dynamic
// import() calls in a long-lived process (a standalone isolated test showed
// consistent throwing across 5 repeats, but pi's actual extension runtime
// environment did not reproduce that consistency across the many other
// operations happening in a real session). Resolving once and reusing the
// result removes any possibility of that inconsistency recurring. The
// `typeof … !== "function"` guards are defense-in-depth: they turn a
// silent malformed-export case into a clear, immediately-thrown diagnostic
// instead of a cryptic "X is not a constructor" surfacing later inside
// openMicAtRate's `new Decibri(opts)` call.
let cachedDecibriCtor: Promise<DecibriCtor> | null = null;

async function loadDecibriCtor(): Promise<DecibriCtor> {
	if (!cachedDecibriCtor) {
		cachedDecibriCtor = resolveDecibriCtor().catch((err) => {
			// Do not memoize a rejection — a transient failure (e.g. the shim's
			// own dynamic import racing something at startup) shouldn't
			// permanently poison every later call in the process.
			cachedDecibriCtor = null;
			throw err;
		});
	}
	return cachedDecibriCtor;
}

async function resolveDecibriCtor(): Promise<DecibriCtor> {
	try {
		// decibri ships as CJS (`module.exports = Decibri`); under ESM the ctor lands on `.default`.
		const mod = (await import("decibri")) as { default: DecibriCtor };
		if (typeof mod.default !== "function") {
			throw new Error("decibri module loaded but its default export is not a constructor");
		}
		return mod.default;
	} catch (err) {
		try {
			const shim = (await import("./decibri-audiomic-shim.js")) as { default: DecibriCtor };
			if (typeof shim.default !== "function") {
				throw new Error("decibri-audiomic-shim loaded but its default export is not a constructor");
			}
			appendDiagnosticLog("mic.backend", "audiomic-shim (decibri unavailable)");
			return shim.default;
		} catch {
			throw err instanceof Error ? err : new Error(String(err)); // surface the original decibri load failure, not the shim's
		}
	}
}

function pickCaptureRates(Decibri: DecibriCtor): number[] {
	let defaultRate: number | null = null;
	try {
		const devices = typeof Decibri.devices === "function" ? Decibri.devices() : [];
		const def = devices.find((d) => d.isDefault && d.maxInputChannels >= 1);
		if (def && def.defaultSampleRate > 0) defaultRate = def.defaultSampleRate;
	} catch {
		// Device enumeration is best-effort. A bug or platform quirk here
		// must not block capture — fall through to the fixed fallback list.
	}

	const ordered: number[] = [];
	if (defaultRate !== null) ordered.push(defaultRate);
	for (const r of FALLBACK_CAPTURE_RATES) {
		if (!ordered.includes(r)) ordered.push(r);
	}
	return ordered;
}

function openMicAtRate(Decibri: DecibriCtor, sourceRate: number, mode: MicMode): Promise<DecibriLike> {
	return new Promise<DecibriLike>((resolve, reject) => {
		// Capture buffer scaled to preserve the ~100 ms chunk cadence the
		// pipeline was tuned against (1600 samples at 16 kHz = 100 ms). For
		// the silero-passthrough path sourceRate is 16000, so this collapses
		// to FRAMES_PER_BUFFER.
		const captureBufferFrames = Math.max(1, Math.round((FRAMES_PER_BUFFER * sourceRate) / TARGET_SAMPLE_RATE));

		const opts: Record<string, unknown> = {
			sampleRate: sourceRate,
			channels: 1,
			framesPerBuffer: captureBufferFrames,
			format: "int16",
		};
		if (mode === "silero-passthrough") {
			opts.vad = true;
			opts.vadMode = "silero";
			opts.vadThreshold = SILERO_THRESHOLD;
			opts.vadHoldoff = VAD_HOLDOFF_MS;
		} else {
			// Silero only supports 8/16 kHz; we're at the native rate here.
			// Run an RMS gate in JS on the resampled 16 kHz stream instead.
			opts.vad = false;
		}

		let raw: DecibriRaw;
		try {
			raw = new Decibri(opts);
		} catch (err) {
			reject(decoratedError(err, sourceRate));
			return;
		}

		const wrapper: MicAdapterBase =
			mode === "silero-passthrough" ? new SileroPassthroughAdapter(raw) : new ResamplingRmsAdapter(raw, sourceRate);
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			raw.removeListener("error", onError);
			raw.removeListener("data", onData);
			fn();
		};
		const onError = (err: unknown) =>
			settle(() => {
				try {
					raw.stop();
				} catch {
					// stop() can throw if the stream never opened; we're already
					// rejecting with the underlying error, no need to chain.
				}
				reject(decoratedError(err, sourceRate));
			});
		const onData = () => settle(() => resolve(wrapper));
		const onTimeout = () => settle(() => resolve(wrapper));

		const timer = setTimeout(onTimeout, STARTUP_RACE_MS);
		raw.once("error", onError);
		raw.once("data", onData);
	});
}

function decoratedError(err: unknown, sourceRate: number): Error {
	const message = err instanceof Error ? err.message : String(err);
	const decorated = new Error(`mic open failed at ${sourceRate} Hz: ${message}`);
	if (err instanceof Error && err.stack) decorated.stack = err.stack;
	return decorated;
}

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

// Shared queue/drain plumbing for both adapters. Events emitted before
// any consumer attaches a listener are queued and drained on a
// microtask after the first listener registration. This closes the gap
// between `createMic()` resolving and the pipeline runner attaching its
// listeners (splash teardown + caller plumbing): without the queue,
// early audio would be dropped and — worse — an early `error` would
// throw "Unhandled error" from EventEmitter.
abstract class MicAdapterBase extends EventEmitter implements DecibriLike {
	protected readonly raw: DecibriRaw;
	private readonly pending: Array<{ event: string; args: unknown[] }> = [];
	private drained = false;

	constructor(raw: DecibriRaw) {
		super();
		this.raw = raw;

		const onNewListener = (event: string) => {
			// `newListener` fires for *any* event registration including
			// `newListener` itself; ignore the self-trigger so we drain on
			// the first real consumer attach.
			if (this.drained || event === "newListener") return;
			this.drained = true;
			this.removeListener("newListener", onNewListener);
			// Defer drain until the just-being-added listener is actually in
			// the internal array (newListener fires *before* the add).
			queueMicrotask(() => {
				for (const item of this.pending) this.emit(item.event, ...item.args);
				this.pending.length = 0;
			});
		};
		this.on("newListener", onNewListener);
	}

	stop(): void {
		this.raw.stop();
	}

	protected emitOrQueue(event: string, ...args: unknown[]): void {
		if (this.drained) {
			this.emit(event, ...args);
		} else {
			this.pending.push({ event, args });
		}
	}
}

// Strategy 1 adapter: capture is already at 16 kHz with Silero handling
// VAD inside decibri, so this is a near-passthrough. Forwards `data`,
// `silence`, `end`, `error`, `close`. Does not emit `speech` (the
// pipeline doesn't consume it).
class SileroPassthroughAdapter extends MicAdapterBase {
	constructor(raw: DecibriRaw) {
		super(raw);
		raw.on("data", (chunk: Buffer) => this.emitOrQueue("data", chunk));
		raw.on("silence", () => this.emitOrQueue("silence"));
		raw.once("end", () => this.emitOrQueue("end"));
		raw.once("error", (err: Error) => this.emitOrQueue("error", err));
		raw.once("close", () => this.emitOrQueue("close"));
	}
}

// Strategy 2 adapter: capture is at the device's native rate. Resamples
// each chunk to 16 kHz and runs an RMS-energy silence detector on the
// resampled stream.
class ResamplingRmsAdapter extends MicAdapterBase {
	private readonly resampler: Int16LinearResampler;
	private inSpeech = false;
	private silenceTimer: NodeJS.Timeout | null = null;

	constructor(raw: DecibriRaw, sourceRate: number) {
		super(raw);
		this.resampler = new Int16LinearResampler(sourceRate, TARGET_SAMPLE_RATE);

		raw.on("data", (chunk: Buffer) => this.onRawData(chunk));
		raw.once("end", () => this.emitOrQueue("end"));
		raw.once("error", (err: Error) => this.emitOrQueue("error", err));
		raw.once("close", () => this.emitOrQueue("close"));
	}

	override stop(): void {
		if (this.silenceTimer) {
			clearTimeout(this.silenceTimer);
			this.silenceTimer = null;
		}
		super.stop();
	}

	private onRawData(chunk: Buffer): void {
		const resampled = this.resampler.process(chunk);
		if (resampled.length === 0) return;
		this.emitOrQueue("data", resampled);
		this.runSilenceDetector(resampled);
	}

	private runSilenceDetector(chunk: Buffer): void {
		const rms = computeRmsInt16(chunk);
		if (rms >= VAD_RMS_THRESHOLD) {
			this.inSpeech = true;
			if (this.silenceTimer) {
				clearTimeout(this.silenceTimer);
				this.silenceTimer = null;
			}
			return;
		}
		if (this.inSpeech && this.silenceTimer === null) {
			this.silenceTimer = setTimeout(() => {
				this.silenceTimer = null;
				this.inSpeech = false;
				this.emitOrQueue("silence");
			}, VAD_HOLDOFF_MS);
		}
	}
}
