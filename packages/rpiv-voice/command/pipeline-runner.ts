import { appendDiagnosticLog, appendErrorLog } from "../audio/error-log.js";
import { isHallucination } from "../audio/hallucination-filter.js";
import type { DecibriLike } from "../audio/mic-source.js";
import { TARGET_SAMPLE_RATE } from "../audio/mic-source.js";
import { bufferToFloat32, computeRmsFloat32, computeRmsInt16, samplesInInt16Chunk } from "../audio/pcm.js";
import type { SttEngine } from "../audio/stt-engine.js";
import { isHallucinationFilterEnabled } from "../config/voice-config.js";
import type { VoiceSession } from "../state/voice-session.js";

// 12 s soft cap: Whisper trains on 30 s windows and degrades on very short
// inputs; 5 s force-flushes routinely bisect a clause mid-word. 12 s is the
// dictation-tool consensus (LiveKit, whisper_streaming) — long enough to fit
// most sentences, short enough to bound first-token latency.
const MAX_SEGMENT_MS = 12000;
const MAX_SEGMENT_SAMPLES = (TARGET_SAMPLE_RATE * MAX_SEGMENT_MS) / 1000;

// When the cap fires, scan the trailing 800 ms for the chunk with the lowest
// RMS and split there instead of at the wall-clock boundary. The "head" half
// goes to Whisper, the "tail" carries forward as the start of the next
// segment. Cuts mid-breath instead of mid-syllable.
const CAP_CUT_SCAN_MS = 800;
const CAP_CUT_SCAN_SAMPLES = (TARGET_SAMPLE_RATE * CAP_CUT_SCAN_MS) / 1000;

// Whisper hallucinates filler ("Thanks for watching", "♪", "1/2 1/2…") on
// near-silent input. sherpa-onnx-node doesn't expose the decoder thresholds
// that would suppress this, so we gate at the input: skip segments whose mean
// RMS is below a floor. ~-46 dBFS sits between room noise and quiet speech.
const MIN_SEGMENT_RMS = 0.005;

// Cadence of rolling partial-transcript decodes during an active utterance.
// 1 s gives the user a continuously-refining preview without saturating the
// CPU on Whisper-base (typical decode of a sub-12 s buffer is well under 1 s
// on modern silicon, leaving headroom for mic + render). Single-flight: a
// new tick is skipped if the previous decode hasn't returned.
const PARTIAL_DECODE_INTERVAL_MS = 1000;

export interface PipelineHandle {
	finalTranscriptPromise: Promise<string>;
	isPaused(): boolean;
	setPaused(paused: boolean): void;
	setHallucinationFilterEnabled(enabled: boolean): void;
	stop(): void;
}

export interface PipelineOptions {
	hallucinationFilterEnabled?: boolean;
}

export function startDictationPipeline(
	mic: DecibriLike,
	sttEngine: SttEngine,
	session: VoiceSession,
	signal: AbortSignal,
	options: PipelineOptions = {},
): PipelineHandle {
	let speechBuffer: Buffer[] = [];
	let speechBufferSamples = 0;
	let transcript = "";
	let recognizing: Promise<void> = Promise.resolve();
	let paused = false;
	let hallucinationFilterEnabled = isHallucinationFilterEnabled(options);

	// Single-flight gate for partial decodes. Combined with the interval
	// throttle this means at most one partial recognize() at a time and at
	// most one per PARTIAL_DECODE_INTERVAL_MS — never queueing a backlog if
	// the CPU stalls.
	let partialInFlight = false;
	let lastPartialAt = 0;
	// Bumps every time the buffer is committed (silence flush, cap flush, or
	// session shutdown). A partial whose snapshot was taken at an earlier
	// epoch is dropped on dispatch — protects against a slow partial decode
	// painting stale text after the final commit.
	let utteranceEpoch = 0;

	// Decode-latency breadcrumbs: one stt.decode line per completed recognize
	// call (kind + wall-clock duration + sample count) so a freeze report shows
	// how long each final/partial decode actually took.
	const logDecode = (kind: "final" | "partial", sampleCount: number, startedAt: number): void => {
		appendDiagnosticLog("stt.decode", `${kind} ${Date.now() - startedAt}ms ${sampleCount} samples`);
	};

	const recognizeFinal = async (chunks: Buffer[]): Promise<void> => {
		if (chunks.length === 0) return;
		// The signal aborts on cancel — the commit path drains first and aborts
		// only after (voice-command teardown ordering). Post-abort the session
		// is torn down and the drain result has no consumer, so skip the decode
		// outright instead of running Whisper for a transcript nobody reads.
		if (signal.aborted) return;
		const samples = bufferToFloat32(Buffer.concat(chunks));
		if (computeRmsFloat32(samples) < MIN_SEGMENT_RMS) {
			// No audible content — but still finalize so any in-flight partial
			// gets cleared by the reducer's empty-append branch.
			session.dispatchAction({ kind: "audio_transcript_appended", text: "" });
			return;
		}
		try {
			const decodeStartedAt = Date.now();
			const text = await sttEngine.recognize(samples, TARGET_SAMPLE_RATE);
			logDecode("final", samples.length, decodeStartedAt);
			// Canceled while the decode was in flight: discard the result — the
			// accumulator is unconsumed on cancel and the session is done, so a
			// dispatch would only churn a torn-down TUI.
			if (signal.aborted) return;
			if (!text || (hallucinationFilterEnabled && isHallucination(text))) {
				session.dispatchAction({ kind: "audio_transcript_appended", text: "" });
				return;
			}
			transcript = transcript ? `${transcript} ${text}` : text;
			session.dispatchAction({ kind: "audio_transcript_appended", text });
		} catch (err) {
			// We deliberately do not surface this to the TUI: writing to stderr
			// corrupts the active render, and `notify` would churn the chat for
			// every dropped segment. Instead, append a breadcrumb to a file the
			// user can `cat` later when investigating transcript gaps. Only
			// cancel teardown is exempt: the signal aborts pre-drain on cancel
			// alone, so a post-abort rejection is a decode nobody consumes —
			// the commit drain runs pre-abort and its failures always log.
			if (signal.aborted) return;
			appendErrorLog("stt.recognize", err);
			session.dispatchAction({ kind: "audio_transcript_appended", text: "" });
		}
	};

	const flushBuffer = (): void => {
		if (speechBuffer.length === 0) return;
		const chunks = speechBuffer;
		speechBuffer = [];
		speechBufferSamples = 0;
		utteranceEpoch++;
		recognizing = recognizing.then(() => recognizeFinal(chunks));
	};

	const queueCapFlush = (): void => {
		const cutIdx = findLowestEnergyCutIndex(speechBuffer);
		if (cutIdx <= 0 || cutIdx >= speechBuffer.length) {
			flushBuffer();
			return;
		}
		const head = speechBuffer.slice(0, cutIdx);
		const tail = speechBuffer.slice(cutIdx);
		speechBuffer = tail;
		speechBufferSamples = countSamples(tail);
		utteranceEpoch++;
		recognizing = recognizing.then(() => recognizeFinal(head));
	};

	// Rolling partial preview. Runs *outside* the `recognizing` chain so the
	// preview latency isn't queued behind pending finals — though the engine
	// itself serializes decodes (native handle is not proven concurrency-safe),
	// so a partial can wait behind at most the one in-flight decode, never the
	// whole chain. Best-effort: a snapshot of the current buffer is decoded,
	// and the result is dispatched as the new partial only if the utterance
	// epoch hasn't advanced under us.
	const tryEmitPartial = (): void => {
		if (signal.aborted) return;
		if (partialInFlight) return;
		if (speechBuffer.length === 0) return;
		const now = Date.now();
		if (now - lastPartialAt < PARTIAL_DECODE_INTERVAL_MS) return;
		lastPartialAt = now;
		partialInFlight = true;
		const snapshotEpoch = utteranceEpoch;
		const snapshot = speechBuffer.slice();
		void (async () => {
			try {
				const samples = bufferToFloat32(Buffer.concat(snapshot));
				if (computeRmsFloat32(samples) < MIN_SEGMENT_RMS) return;
				const decodeStartedAt = Date.now();
				const text = await sttEngine.recognize(samples, TARGET_SAMPLE_RATE);
				logDecode("partial", samples.length, decodeStartedAt);
				// Session torn down (cancel) or drain-superseded — never paint.
				if (signal.aborted) return;
				if (snapshotEpoch !== utteranceEpoch) return;
				if (hallucinationFilterEnabled && isHallucination(text)) return;
				session.dispatchAction({ kind: "audio_partial_transcript_set", text });
			} catch (err) {
				if (!signal.aborted) appendErrorLog("stt.recognize.partial", err);
			} finally {
				partialInFlight = false;
			}
		})();
	};

	mic.on("data", (chunk: Buffer) => {
		const level = computeRmsInt16(chunk);
		session.dispatchAction({ kind: "audio_chunk", level });
		if (paused) return;
		speechBuffer.push(chunk);
		speechBufferSamples += samplesInInt16Chunk(chunk);
		if (speechBufferSamples >= MAX_SEGMENT_SAMPLES) {
			queueCapFlush();
		} else {
			tryEmitPartial();
		}
	});
	mic.on("silence", () => {
		if (paused) return;
		flushBuffer();
	});

	const finalTranscriptPromise = waitForMicShutdown(mic, signal, async () => {
		flushBuffer();
		await recognizing;
	}).then(() => transcript);

	return {
		finalTranscriptPromise,
		isPaused: () => paused,
		setPaused: (v) => {
			paused = v;
		},
		setHallucinationFilterEnabled: (v) => {
			hallucinationFilterEnabled = v;
		},
		stop: () => {
			mic.stop();
		},
	};
}

function countSamples(chunks: Buffer[]): number {
	let total = 0;
	for (const chunk of chunks) total += samplesInInt16Chunk(chunk);
	return total;
}

// Walk chunks newest-first up to CAP_CUT_SCAN_SAMPLES of audio; return the
// index of the lowest-RMS chunk in that window. Returns chunks.length when
// the buffer is too short to scan, telling the caller to fall back to a full
// flush.
function findLowestEnergyCutIndex(chunks: Buffer[]): number {
	if (chunks.length < 2) return chunks.length;
	let scanned = 0;
	let lowestRms = Number.POSITIVE_INFINITY;
	let lowestIdx = chunks.length;
	for (let i = chunks.length - 1; i >= 1; i--) {
		const chunk = chunks[i];
		if (!chunk) continue;
		const rms = computeRmsInt16(chunk);
		if (rms < lowestRms) {
			lowestRms = rms;
			lowestIdx = i;
		}
		scanned += samplesInInt16Chunk(chunk);
		if (scanned >= CAP_CUT_SCAN_SAMPLES) break;
	}
	return lowestIdx;
}

function waitForMicShutdown(mic: DecibriLike, signal: AbortSignal, onFinish: () => Promise<void>): Promise<void> {
	return new Promise<void>((resolve) => {
		const onAbort = () => {
			mic.stop();
		};
		// The terminal events can arrive in sequence (a Readable emits `close`
		// after `end`) — drain exactly once.
		let finished = false;
		const finish = async () => {
			if (finished) return;
			finished = true;
			signal.removeEventListener("abort", onAbort);
			await onFinish();
			resolve();
		};
		mic.once("end", finish);
		mic.once("error", finish);
		// `close` is the third terminal event in the DecibriLike contract, and
		// the adapters forward it. Nothing else consumes it, so without this a
		// close-without-end shutdown would park the drain — and with it the
		// committed paste — forever.
		mic.once("close", finish);
		if (signal.aborted) {
			mic.stop();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}
