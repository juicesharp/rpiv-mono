import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getErrorLogPath } from "../audio/error-log.js";
import type { DecibriLike } from "../audio/mic-source.js";
import { TARGET_SAMPLE_RATE } from "../audio/mic-source.js";
import type { SttEngine } from "../audio/stt-engine.js";
import type { VoiceAction } from "../state/key-router.js";
import type { VoiceSession } from "../state/voice-session.js";
import { startDictationPipeline } from "./pipeline-runner.js";

class FakeMic extends EventEmitter implements DecibriLike {
	on(event: string, listener: (...args: never[]) => void): this {
		return super.on(event, listener as (...args: unknown[]) => void);
	}
	once(event: string, listener: (...args: never[]) => void): this {
		return super.once(event, listener as (...args: unknown[]) => void);
	}
	stop(): void {
		this.emit("end");
	}
}

// 1600 int16 samples × 100 ms of audio with non-trivial RMS so it survives
// the MIN_SEGMENT_RMS gate inside flushBuffer.
function loudChunk(): Buffer {
	const samples = 1600;
	const buf = Buffer.alloc(samples * 2);
	for (let i = 0; i < samples; i++) {
		// Alternating ~+/- 8000 amplitude (well above the -46 dBFS noise floor).
		buf.writeInt16LE(i % 2 === 0 ? 8000 : -8000, i * 2);
	}
	return buf;
}

// All-zero PCM at 100 ms — RMS=0 so the MIN_SEGMENT_RMS gate trips.
function quietChunk(): Buffer {
	return Buffer.alloc(1600 * 2);
}

const yieldToFlush = () => new Promise<void>((r) => setImmediate(r));

interface CapturedSession {
	session: VoiceSession;
	dispatched: VoiceAction[];
}

function makeSession(): CapturedSession {
	const dispatched: VoiceAction[] = [];
	const session = {
		dispatchAction: (action: VoiceAction) => {
			dispatched.push(action);
		},
	} as unknown as VoiceSession;
	return { session, dispatched };
}

describe("startDictationPipeline — STT recognize failure", () => {
	let abort: AbortController;

	beforeEach(() => {
		abort = new AbortController();
	});

	afterEach(() => {
		if (!abort.signal.aborted) abort.abort();
	});

	it("logs the error to errors.log and keeps the pipeline running for the next segment", async () => {
		const mic = new FakeMic();
		const { session, dispatched } = makeSession();

		// Make the very first recognize() throw, then succeed thereafter. With
		// rolling partials the first call is usually the partial decoder, so we
		// don't pin the failure scope — we just assert an error WAS logged and
		// that subsequent successful decodes still produce committed text.
		const recognize = vi
			.fn<SttEngine["recognize"]>()
			.mockRejectedValueOnce(new Error("boom"))
			.mockImplementation(async () => "hello world");
		const sttEngine: SttEngine = {
			recognize,
			release: () => {},
		};

		const handle = startDictationPipeline(mic, sttEngine, session, abort.signal);

		// flushBuffer chains as a microtask via `recognizing.then(...)`. If we
		// emit the next segment synchronously before yielding, the second chunk
		// gets concatenated into the still-pending first segment. Yield via
		// setImmediate so each segment is processed independently.
		const yieldToFlush = () => new Promise<void>((r) => setImmediate(r));

		// Segment 1
		mic.emit("data", loudChunk());
		mic.emit("silence");
		await yieldToFlush();
		await yieldToFlush();

		// Segment 2
		mic.emit("data", loudChunk());
		mic.emit("silence");
		await yieldToFlush();
		await yieldToFlush();

		// End the mic so finalTranscriptPromise resolves.
		mic.emit("end");
		const finalTranscript = await handle.finalTranscriptPromise;

		// At least one committed transcript made it through despite the failure.
		const committed = dispatched.filter((a) => a.kind === "audio_transcript_appended" && a.text.length > 0);
		expect(committed.length).toBeGreaterThanOrEqual(1);
		expect(finalTranscript.length).toBeGreaterThan(0);

		// Error log captured the rejection.
		const path = getErrorLogPath();
		expect(existsSync(path)).toBe(true);
		const content = readFileSync(path, "utf-8");
		expect(content).toMatch(/Error: boom/);
	});
});

describe("startDictationPipeline — branch coverage", () => {
	let abort: AbortController;

	beforeEach(() => {
		abort = new AbortController();
	});

	afterEach(() => {
		if (!abort.signal.aborted) abort.abort();
	});

	function startWithRecognize(
		recognize: SttEngine["recognize"],
		options: Parameters<typeof startDictationPipeline>[4] = {},
	) {
		const mic = new FakeMic();
		const { session, dispatched } = makeSession();
		const sttEngine: SttEngine = { recognize, release: () => {} };
		const handle = startDictationPipeline(mic, sttEngine, session, abort.signal, options);
		return { mic, session, dispatched, sttEngine, handle };
	}

	it("paused gate suppresses buffer push and silence flush", async () => {
		const recognize = vi.fn<SttEngine["recognize"]>().mockResolvedValue("ignored");
		const { mic, dispatched, handle } = startWithRecognize(recognize);
		handle.setPaused(true);
		expect(handle.isPaused()).toBe(true);

		mic.emit("data", loudChunk());
		mic.emit("silence");
		await yieldToFlush();
		await yieldToFlush();

		mic.emit("end");
		const finalTranscript = await handle.finalTranscriptPromise;

		// The reducer still receives audio_chunk frames (VU meter is independent of
		// paused state), but no commit/partial should fire.
		expect(recognize).not.toHaveBeenCalled();
		expect(finalTranscript).toBe("");
		expect(dispatched.some((a) => a.kind === "audio_transcript_appended")).toBe(false);
		expect(dispatched.some((a) => a.kind === "audio_chunk")).toBe(true);
	});

	it("hallucination filter drops a flagged segment as an empty commit", async () => {
		// "thank you" is in the curated hallucination phrase set.
		const recognize = vi.fn<SttEngine["recognize"]>().mockResolvedValue("thank you");
		const { mic, dispatched, handle } = startWithRecognize(recognize, { hallucinationFilterEnabled: true });

		mic.emit("data", loudChunk());
		mic.emit("silence");
		await yieldToFlush();
		await yieldToFlush();

		mic.emit("end");
		const finalTranscript = await handle.finalTranscriptPromise;

		expect(recognize).toHaveBeenCalled();
		expect(finalTranscript).toBe("");
		const appends = dispatched.filter((a) => a.kind === "audio_transcript_appended");
		expect(appends.length).toBeGreaterThanOrEqual(1);
		expect(appends.every((a) => a.text === "")).toBe(true);
	});

	it("filter toggle off lets the same phrase through", async () => {
		const recognize = vi.fn<SttEngine["recognize"]>().mockResolvedValue("thank you");
		const { mic, dispatched, handle } = startWithRecognize(recognize, { hallucinationFilterEnabled: true });
		handle.setHallucinationFilterEnabled(false);

		mic.emit("data", loudChunk());
		mic.emit("silence");
		await yieldToFlush();
		await yieldToFlush();

		mic.emit("end");
		const finalTranscript = await handle.finalTranscriptPromise;

		expect(finalTranscript).toBe("thank you");
		const committed = dispatched.filter((a) => a.kind === "audio_transcript_appended" && a.text === "thank you");
		expect(committed.length).toBe(1);
	});

	it("below-RMS segment short-circuits before recognize() runs", async () => {
		const recognize = vi.fn<SttEngine["recognize"]>().mockResolvedValue("should not be called");
		const { mic, dispatched, handle } = startWithRecognize(recognize);

		mic.emit("data", quietChunk());
		mic.emit("silence");
		await yieldToFlush();
		await yieldToFlush();

		mic.emit("end");
		const finalTranscript = await handle.finalTranscriptPromise;

		// recognize() is gated by RMS — quiet segments emit an empty commit so the
		// reducer clears any in-flight partial, but never reach the engine.
		expect(recognize).not.toHaveBeenCalled();
		expect(finalTranscript).toBe("");
		const appends = dispatched.filter((a) => a.kind === "audio_transcript_appended");
		expect(appends.length).toBe(1);
		expect(appends[0].text).toBe("");
	});

	it("mic error resolves finalTranscriptPromise like mic end", async () => {
		const recognize = vi.fn<SttEngine["recognize"]>().mockResolvedValue("hello");
		const { mic, handle } = startWithRecognize(recognize);

		mic.emit("data", loudChunk());
		mic.emit("silence");
		await yieldToFlush();
		await yieldToFlush();

		// Error path drains the buffer and resolves the promise — same shape as end.
		mic.emit("error", new Error("usb yanked"));
		await expect(handle.finalTranscriptPromise).resolves.toBe("hello");
	});

	it("stop() aborts the mic and resolves with accumulated transcript", async () => {
		const recognize = vi.fn<SttEngine["recognize"]>().mockResolvedValue("partial commit");
		const { mic, handle } = startWithRecognize(recognize);
		const stopSpy = vi.spyOn(mic, "stop");

		mic.emit("data", loudChunk());
		mic.emit("silence");
		await yieldToFlush();
		await yieldToFlush();

		handle.stop();
		await expect(handle.finalTranscriptPromise).resolves.toBe("partial commit");
		expect(stopSpy).toHaveBeenCalled();
	});

	it("abort signal mid-pipeline forwards to mic.stop()", async () => {
		const recognize = vi.fn<SttEngine["recognize"]>().mockResolvedValue("hello");
		const { mic, handle } = startWithRecognize(recognize);
		const stopSpy = vi.spyOn(mic, "stop");

		mic.emit("data", loudChunk());
		mic.emit("silence");
		await yieldToFlush();
		await yieldToFlush();

		abort.abort();
		await expect(handle.finalTranscriptPromise).resolves.toBe("hello");
		expect(stopSpy).toHaveBeenCalled();
	});

	it("cap-flush splits a long utterance and commits the head", async () => {
		// MAX_SEGMENT_SAMPLES = 16000 * 12 = 192000 → 121 × 100 ms chunks crosses it.
		// findLowestEnergyCutIndex picks the lowest-RMS chunk in the trailing 800 ms;
		// our loud chunks are uniform, so cutIdx falls inside [chunks.length-8, chunks.length-1]
		// and the cap path runs the slice/concat branch (lines 117-122).
		const recognize = vi.fn<SttEngine["recognize"]>().mockResolvedValue("first half");
		const { mic, handle } = startWithRecognize(recognize);

		const CHUNKS_TO_CROSS_CAP = Math.ceil((TARGET_SAMPLE_RATE * 12) / 1600) + 1;
		for (let i = 0; i < CHUNKS_TO_CROSS_CAP; i++) {
			mic.emit("data", loudChunk());
		}
		await yieldToFlush();
		await yieldToFlush();

		mic.emit("end");
		const finalTranscript = await handle.finalTranscriptPromise;

		// At minimum: one commit from the cap-flush head + a tail commit on mic end.
		expect(recognize).toHaveBeenCalled();
		expect(finalTranscript.length).toBeGreaterThan(0);
	});
});
