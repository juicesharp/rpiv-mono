// decibri-compatible constructor backed by @audio/mic (miniaudio.h via
// N-API), used only as a fallback when the real `decibri` npm package's
// native addon fails to load — today, that's darwin-x64 (Intel Mac) only,
// since decibri ships no prebuilt for that target and the maintainer has
// explicitly declined to add one (decibri/decibri issue #15, closed,
// citing Apple ending Intel Mac support and an upstream ort-sys blocker).
//
// Implements the exact subset of decibri's constructor contract that
// mic-source.ts consumes (see `DecibriCtor`/`DecibriRaw` there).
//
// Uses @audio/mic's BASE export (the `read(cb)` callback factory), not its
// `/stream` Readable-wrapper subpath. This is deliberate, not a style
// choice: `@audio/mic/stream`'s `Readable.from(read)` wraps an async
// iterator that only implements `next()` (see @audio/mic's index.js —
// `read[Symbol.asyncIterator]` has no `return`/`throw`). Node's
// `Readable.from` can only forward a `.destroy()` call into iterator cleanup
// by calling `iterator.return()`, which doesn't exist here — so
// `stream.destroy()` silently does NOT reach the underlying
// `device.close()`, meaning the native capture device and its libuv worker
// thread (native/mic.c's `read_execute`, which blocks in a `while (!closed)`
// loop) never actually stop. Using the base factory directly and driving our
// own read loop keeps the `read.close()` handle reachable from `stop()`,
// which is the only thing that actually calls `ma_device_stop` +
// `ma_device_uninit`.
//
// Intentionally does NOT implement Silero VAD passthrough: @audio/mic's
// miniaudio backend has no VAD of its own. When `opts.vad` is requested this
// class rejects (async `error` event) so mic-source.ts's EXISTING
// silero-passthrough -> resample-rms fallback (already shipped — see
// juicesharp/rpiv-mono issue #46) takes over unmodified. This is a
// deliberate design choice, not a rate limitation: @audio/mic's miniaudio
// backend can actually deliver clean 16kHz audio from any device via its
// internal resampler (verified by reading native/mic.c — config.sampleRate is
// passed straight to ma_device_init, which auto-converts when the backend's
// native rate differs, unlike decibri/cpal which fails outright on an
// unsupported rate). We reject anyway because we have no VAD to satisfy the
// `speech`/`silence` event contract silero-passthrough mode implies.
import { EventEmitter } from "node:events";

// Matches @audio/mic's own index.d.ts `ReadFn` shape (not re-imported to
// avoid a hard type-only dependency edge; keep in sync if @audio/mic changes
// this shape).
interface AudioMicReadFn {
	(cb: (err: Error | null, chunk?: Buffer | Uint8Array | null) => void): void;
	(cb: null): void;
	close(): void;
}

export default class AudioMicDecibriShim extends EventEmitter {
	// CoreAudio can take a short moment to fully release an input device
	// after a previous session's stop()/close() — native mic_close() calls
	// ma_device_stop() + ma_device_uninit() synchronously, but the underlying
	// HAL device teardown is not guaranteed instantaneous on every
	// device/driver combination. A rapid /voice → exit → /voice cycle can hit
	// this window and fail ma_device_init() on the second open with no
	// automatic recovery (observed live on darwin-x64: second invocation
	// throws "Microphone unavailable", and repeated fast cycling has also
	// crashed the process outright — consistent with a native-level race, not
	// just a JS-level error). Retry the open a few times with a short backoff
	// before giving up.
	private static readonly OPEN_RETRY_DELAYS_MS = [150, 300, 600, 1000];

	private stopped = false;
	private readHandle: AudioMicReadFn | null = null;

	constructor(opts: Record<string, unknown>) {
		super();
		const sampleRate = Number(opts.sampleRate);
		const channels = Number(opts.channels ?? 1);
		const framesPerBuffer = opts.framesPerBuffer != null ? Number(opts.framesPerBuffer) : undefined;
		const vad = Boolean(opts.vad);

		if (vad) {
			// See file header: intentional rejection, not a real limitation.
			queueMicrotask(() =>
				this.emit("error", new Error("decibri-audiomic-shim: vad is not supported by the @audio/mic fallback")),
			);
			return;
		}
		if (channels !== 1) {
			queueMicrotask(() =>
				this.emit("error", new Error(`decibri-audiomic-shim: channels must be 1, got ${channels}`)),
			);
			return;
		}
		if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
			queueMicrotask(() =>
				this.emit("error", new Error(`decibri-audiomic-shim: invalid sampleRate ${String(opts.sampleRate)}`)),
			);
			return;
		}

		// @audio/mic's bufferSize option is milliseconds; mic-source.ts's
		// framesPerBuffer is a sample count. Convert so chunk cadence stays
		// consistent with the ~100ms cadence the rest of the pipeline expects.
		// Clamped to @audio/mic's own accepted range (10-2000ms, confirmed in
		// its native/mic.c `mic_open` clamp) as a sane guard.
		const bufferSizeMs =
			framesPerBuffer != null && framesPerBuffer > 0
				? Math.max(10, Math.min(2000, Math.round((framesPerBuffer / sampleRate) * 1000)))
				: undefined;

		this.start({ sampleRate, bufferSizeMs }).catch((err) => this.emit("error", err));
	}

	private async start(opts: { sampleRate: number; bufferSizeMs?: number }): Promise<void> {
		const { default: mic } = await import("@audio/mic");
		const micOpts = {
			sampleRate: opts.sampleRate,
			channels: 1,
			bitDepth: 16 as const,
			...(opts.bufferSizeMs != null ? { bufferSize: opts.bufferSizeMs } : {}),
		};

		const delays = AudioMicDecibriShim.OPEN_RETRY_DELAYS_MS;
		let read: AudioMicReadFn | undefined;
		let lastErr: unknown;
		for (let attempt = 0; attempt <= delays.length; attempt++) {
			if (this.stopped) return;
			try {
				read = mic(micOpts) as AudioMicReadFn;
				break;
			} catch (err) {
				lastErr = err;
				const delay = delays[attempt];
				if (delay == null) break; // out of retries
				await new Promise((r) => setTimeout(r, delay));
			}
		}
		if (!read) {
			throw lastErr instanceof Error
				? lastErr
				: new Error(`decibri-audiomic-shim: mic open failed: ${String(lastErr)}`);
		}

		if (this.stopped) {
			// stop() was called synchronously before the dynamic import/retry
			// loop resolved; close immediately instead of starting capture.
			read.close();
			return;
		}

		this.readHandle = read;
		this.pump(read);
	}

	// @audio/mic's callback-style `read(cb)` performs exactly ONE async read
	// per call (confirmed in its miniaudio backend: one `addon.readAsync`
	// call, single-shot) — continuous capture requires re-invoking `read(cb)`
	// from inside the previous callback. This mirrors the pattern its own
	// `stream.js`/`Readable.from` uses internally via the async-iterator's
	// repeated `next()` calls, just without going through the broken destroy
	// path described in the file header.
	private pump(read: AudioMicReadFn): void {
		read((err, chunk) => {
			if (this.stopped) return;
			if (err) {
				this.emit("error", err);
				return;
			}
			if (!chunk) {
				// Device closed (either we called stop() mid-read, or the
				// device was lost) — miniaudio.js's backend delivers a null
				// chunk with no error in this case.
				this.emit("end");
				this.emit("close");
				return;
			}
			this.emit(
				"data",
				Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
			);
			this.pump(read);
		});
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.readHandle?.close();
	}
}
