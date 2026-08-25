import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	reads: [] as MockRead[],
	lastOpts: null as Record<string, unknown> | null,
}));

// Mirrors the self-contained listener-registry convention already used in
// mic-source.test.ts's `vi.mock("decibri", ...)` factory: vi.mock factories
// are hoisted above imports and cannot reference this file's imports.
//
// Models @audio/mic's own callback-style `read(cb)` factory (not the
// `/stream` Readable wrapper — the shim deliberately avoids that subpath,
// see decibri-audiomic-shim.ts's file header for why). Each call to the
// returned function registers ONE pending callback, matching the real
// single-shot-per-call semantics; `emitChunk`/`emitError`/`emitEnd` below
// resolve the most recently registered pending callback, and `close` mirrors
// the real `read.close()`.
type ReadCb = (err: Error | null, chunk?: Buffer | Uint8Array | null) => void;
class MockRead {
	close = vi.fn();
	private pending: ReadCb | null = null;
	call(cb: ReadCb): void {
		this.pending = cb;
	}
	emitChunk(chunk: Buffer): void {
		const cb = this.pending;
		this.pending = null;
		cb?.(null, chunk);
	}
	emitError(err: Error): void {
		const cb = this.pending;
		this.pending = null;
		cb?.(err, null);
	}
	emitEnd(): void {
		const cb = this.pending;
		this.pending = null;
		cb?.(null, null);
	}
}

vi.mock("@audio/mic", () => ({
	default: vi.fn((opts: Record<string, unknown>) => {
		state.lastOpts = opts;
		const mockRead = new MockRead();
		state.reads.push(mockRead);
		const read = ((cb: ReadCb | null) => {
			if (cb === null) {
				mockRead.close();
				return;
			}
			mockRead.call(cb);
		}) as unknown as { (cb: ReadCb | null): void; close: () => void };
		read.close = mockRead.close;
		return read;
	}),
}));

import AudioMicDecibriShim from "./decibri-audiomic-shim.js";

function lastRead(): MockRead {
	const r = state.reads[state.reads.length - 1];
	if (!r) throw new Error("no read() call registered yet");
	return r;
}

async function flush(): Promise<void> {
	await new Promise((r) => setImmediate(r));
}

describe("AudioMicDecibriShim", () => {
	beforeEach(() => {
		state.reads = [];
		state.lastOpts = null;
	});

	it("rejects when vad is requested (no VAD support in the @audio/mic backend)", async () => {
		const shim = new AudioMicDecibriShim({ sampleRate: 16000, channels: 1, vad: true });
		const err = await new Promise<Error>((resolve) => shim.once("error", resolve));
		expect(err.message).toMatch(/vad/i);
	});

	it("rejects when channels is not 1", async () => {
		const shim = new AudioMicDecibriShim({ sampleRate: 48000, channels: 2, vad: false });
		const err = await new Promise<Error>((resolve) => shim.once("error", resolve));
		expect(err.message).toMatch(/channels/i);
	});

	it("rejects on invalid sampleRate", async () => {
		const shim = new AudioMicDecibriShim({ sampleRate: 0, channels: 1, vad: false });
		const err = await new Promise<Error>((resolve) => shim.once("error", resolve));
		expect(err.message).toMatch(/sampleRate/i);
	});

	it("opens @audio/mic with the requested sampleRate, mono, 16-bit", async () => {
		const shim = new AudioMicDecibriShim({ sampleRate: 48000, channels: 1, vad: false });
		await flush();
		expect(state.lastOpts).toMatchObject({ sampleRate: 48000, channels: 1, bitDepth: 16 });
		shim.stop();
	});

	it("converts framesPerBuffer (samples) to bufferSize (ms) correctly", async () => {
		// 4800 samples at 48000 Hz = 100 ms
		const shim = new AudioMicDecibriShim({ sampleRate: 48000, channels: 1, framesPerBuffer: 4800, vad: false });
		await flush();
		expect(state.lastOpts).toMatchObject({ bufferSize: 100 });
		shim.stop();
	});

	it("forwards data events and keeps reading (pump loop) until stopped", async () => {
		const shim = new AudioMicDecibriShim({ sampleRate: 48000, channels: 1, vad: false });
		await flush();
		const chunks: Buffer[] = [];
		shim.on("data", (c: Buffer) => chunks.push(c));
		lastRead().emitChunk(Buffer.from([1, 2, 3, 4]));
		await flush();
		lastRead().emitChunk(Buffer.from([5, 6]));
		expect(chunks).toEqual([Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6])]);
		shim.stop();
	});

	it("stop() calls read.close() — this is what actually stops the native device", async () => {
		const shim = new AudioMicDecibriShim({ sampleRate: 48000, channels: 1, vad: false });
		await flush();
		shim.stop();
		expect(lastRead().close).toHaveBeenCalledTimes(1);
	});

	it("stop() is safe to call multiple times", async () => {
		const shim = new AudioMicDecibriShim({ sampleRate: 48000, channels: 1, vad: false });
		await flush();
		shim.stop();
		expect(() => shim.stop()).not.toThrow();
		expect(lastRead().close).toHaveBeenCalledTimes(1);
	});

	it("a null chunk (device closed) ends the pump loop without emitting further data", async () => {
		const shim = new AudioMicDecibriShim({ sampleRate: 48000, channels: 1, vad: false });
		await flush();
		const events: string[] = [];
		shim.on("end", () => events.push("end"));
		shim.on("close", () => events.push("close"));
		lastRead().emitEnd();
		expect(events).toEqual(["end", "close"]);
	});
});
