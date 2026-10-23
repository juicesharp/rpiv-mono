import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// State is hoisted alongside vi.mock so the factory can reach it. The mock
// factory cannot reference imports from this file (vi.mock is hoisted
// above imports) and cannot be async, so we ship a tiny self-contained
// EventEmitter shim instead of pulling in node:events.
const state = vi.hoisted(() => ({
	instances: [],
	devices: [],
}));

vi.mock("decibri", () => {
	type Listener = (...args: unknown[]) => void;
	class MockMic {
		opts: Record<string, unknown>;
		stop = vi.fn();
		_listeners: Record<string, Listener[]> = {};
		constructor(opts: Record<string, unknown>) {
			this.opts = opts;
			(state.instances as MockMic[]).push(this);
		}
		on(event: string, fn: Listener): this {
			const list = this._listeners[event] ?? [];
			list.push(fn);
			this._listeners[event] = list;
			return this;
		}
		once(event: string, fn: Listener): this {
			const wrap: Listener = (...args) => {
				this.removeListener(event, wrap);
				fn(...args);
			};
			return this.on(event, wrap);
		}
		removeListener(event: string, fn: Listener): this {
			const list = this._listeners[event];
			if (!list) return this;
			const idx = list.indexOf(fn);
			if (idx >= 0) list.splice(idx, 1);
			return this;
		}
		emit(event: string, ...args: unknown[]): boolean {
			const list = this._listeners[event];
			if (!list) return false;
			for (const fn of [...list]) fn(...args);
			return true;
		}
		static devices(): unknown[] {
			return state.devices;
		}
	}
	return { default: MockMic };
});

vi.mock("./error-log.ts", () => ({
	appendErrorLog: vi.fn(),
	appendDiagnosticLog: vi.fn(),
}));

import { appendDiagnosticLog } from "./error-log.ts";
import { createMic, FRAMES_PER_BUFFER, TARGET_SAMPLE_RATE } from "./mic-source.ts";

interface MockMicInstance {
	opts: Record<string, unknown>;
	stop: ReturnType<typeof vi.fn>;
	emit(event: string, ...args: unknown[]): boolean;
}

function instances(): MockMicInstance[] {
	return state.instances as unknown as MockMicInstance[];
}

const BUILT_IN_MIC = {
	index: 0,
	name: "MacBook Pro Microphone",
	id: "coreaudio:BuiltInMicrophoneDevice",
	maxInputChannels: 1,
	defaultSampleRate: 48000,
	isDefault: true,
};

beforeEach(() => {
	state.instances.length = 0;
	(state.devices as unknown as unknown[]).length = 0;
	(state.devices as unknown as unknown[]).push(BUILT_IN_MIC);
	vi.mocked(appendDiagnosticLog).mockReset();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

function setDevices(d: unknown[]): void {
	const arr = state.devices as unknown as unknown[];
	arr.length = 0;
	for (const item of d) arr.push(item);
}

describe("createMic — strategy 1: 16 kHz + Silero (the happy path on USB headsets / AirPods)", () => {
	it("tries 16 kHz with Silero VAD first", async () => {
		const micPromise = createMic();
		(await waitForInstance(0)).emit("data", Buffer.alloc(2));
		await micPromise;

		const opts = instances()[0]?.opts ?? {};
		expect(opts.sampleRate).toBe(16000);
		expect(opts.channels).toBe(1);
		expect(opts.format).toBe("int16");
		expect(opts.framesPerBuffer).toBe(1600);
		expect(opts.vad).toBe(true);
		expect(opts.vadMode).toBe("silero");
		expect(opts.vadHoldoff).toBe(500);
	});

	it("forwards decibri's data and silence events as-is on the silero-passthrough path", async () => {
		const micPromise = createMic();
		const raw = await waitForInstance(0);
		raw.emit("data", Buffer.alloc(2)); // settle startup race
		const mic = await micPromise;

		const dataChunks: Buffer[] = [];
		let silences = 0;
		mic.on("data", (b) => dataChunks.push(b));
		mic.on("silence", () => silences++);

		await flush();
		await flush();

		// Push a 320-byte (160-sample) chunk; passthrough should forward
		// identically (no resampling at 16 kHz → 16 kHz).
		const payload = Buffer.from(new Uint8Array(320).fill(7));
		raw.emit("data", payload);
		raw.emit("silence");

		expect(dataChunks.some((c) => c.length === payload.length)).toBe(true);
		expect(silences).toBe(1);
	});

	it("logs the chosen path to errors.log", async () => {
		const micPromise = createMic();
		(await waitForInstance(0)).emit("data", Buffer.alloc(2));
		await micPromise;

		expect(appendDiagnosticLog).toHaveBeenCalledWith(
			"mic.path",
			expect.stringContaining("silero-passthrough@16000Hz"),
		);
	});
});

describe("createMic — strategy 2: resample + RMS fallback (the built-in mic path)", () => {
	it("falls back to the device's native rate with vad: false when 16 kHz is refused", async () => {
		const micPromise = createMic();

		// 16 kHz attempt refused by the device.
		(await waitForInstance(0)).emit(
			"error",
			new Error("Failed to open audio stream: The requested stream configuration is not supported by the device."),
		);

		// Next attempt: device's defaultSampleRate (48 kHz).
		(await waitForInstance(1)).emit("data", Buffer.alloc(2));
		await micPromise;

		const fallbackOpts = instances()[1]?.opts ?? {};
		expect(fallbackOpts.sampleRate).toBe(48000);
		expect(fallbackOpts.vad).toBe(false);
		// Capture buffer scaled to keep the ~100 ms forwarding cadence
		// (1600 samples @ 16 kHz → 4800 samples @ 48 kHz).
		expect(fallbackOpts.framesPerBuffer).toBe(4800);
	});

	it("logs the fallback transition", async () => {
		const micPromise = createMic();
		(await waitForInstance(0)).emit("error", new Error("refused"));
		(await waitForInstance(1)).emit("data", Buffer.alloc(2));
		await micPromise;

		expect(appendDiagnosticLog).toHaveBeenCalledWith(
			"mic.path",
			expect.stringContaining("silero-passthrough@16000Hz refused"),
		);
		expect(appendDiagnosticLog).toHaveBeenCalledWith("mic.path", expect.stringContaining("resample-rms@48000Hz"));
	});

	it("walks the full fallback rate list [48k, 44.1k, 96k] when each errors", async () => {
		setDevices([]);
		const micPromise = createMic();

		// Attempt 0: silero@16k refused.
		(await waitForInstance(0)).emit("error", new Error("16k refused"));
		// Attempt 1: resample@48k refused.
		(await waitForInstance(1)).emit("error", new Error("48k refused"));
		// Attempt 2: resample@44.1k refused.
		(await waitForInstance(2)).emit("error", new Error("44.1k refused"));
		// Attempt 3: resample@96k succeeds.
		(await waitForInstance(3)).emit("data", Buffer.alloc(2));

		await expect(micPromise).resolves.toBeDefined();
		expect(instances().map((i) => i.opts.sampleRate)).toEqual([16000, 48000, 44100, 96000]);
	});

	it("rejects with the last attempted rate's error when every rate fails", async () => {
		setDevices([]);
		const micPromise = createMic();
		(await waitForInstance(0)).emit("error", new Error("16k refused"));
		(await waitForInstance(1)).emit("error", new Error("48k refused"));
		(await waitForInstance(2)).emit("error", new Error("44.1k refused"));
		(await waitForInstance(3)).emit("error", new Error("96k refused"));

		await expect(micPromise).rejects.toThrow(/mic open failed at 96000 Hz/);
	});

	it("resamples 48 kHz capture down to ~16 kHz before emitting `data` to the consumer", async () => {
		const micPromise = createMic();
		(await waitForInstance(0)).emit("error", new Error("16k refused"));
		const raw = await waitForInstance(1);
		raw.emit("data", Buffer.alloc(2)); // settles the startup race
		const mic = await micPromise;

		const seen: Buffer[] = [];
		mic.on("data", (b) => seen.push(b));
		await flush();
		await flush();

		// 4800 source samples @ 48 kHz should produce ~1600 output samples
		// after resampling to 16 kHz.
		const chunk = makeInt16Chunk(4800, 5000);
		raw.emit("data", chunk);

		const last = seen[seen.length - 1]!;
		expect(last.length).toBeGreaterThan(0);
		expect(last.length).toBeLessThan(chunk.length);
	});
});

describe("createMic — startup race plugs the silent-failure hole", () => {
	it("rejects (not silently resolves) when every attempt's decibri emits an async error", async () => {
		setDevices([]);
		const micPromise = createMic();
		(await waitForInstance(0)).emit("error", new Error("refused"));
		(await waitForInstance(1)).emit("error", new Error("refused"));
		(await waitForInstance(2)).emit("error", new Error("refused"));
		(await waitForInstance(3)).emit("error", new Error("refused"));

		await expect(micPromise).rejects.toThrow(/mic open failed at/);
	});

	it("resolves optimistically if neither data nor error arrives before the startup timeout", async () => {
		const micPromise = createMic();
		await waitForInstance(0);
		// No data, no error — just let the startup timer fire on the first
		// attempt; the wrapper resolves optimistically.
		await vi.advanceTimersByTimeAsync(2000);
		await expect(micPromise).resolves.toBeDefined();
	});
});

describe("createMic — adapter surface", () => {
	it("returned object exposes the DecibriLike surface on both paths", async () => {
		const micPromise = createMic();
		(await waitForInstance(0)).emit("data", Buffer.alloc(2));
		const mic = await micPromise;
		expect(typeof mic.on).toBe("function");
		expect(typeof mic.once).toBe("function");
		expect(typeof mic.stop).toBe("function");
	});

	it("queues events emitted before the consumer attaches a listener", async () => {
		const micPromise = createMic();
		const raw = await waitForInstance(0);
		// Priming chunk settles the startup race; further chunks arrive
		// while the consumer hasn't yet attached.
		raw.emit("data", Buffer.alloc(2));
		const mic = await micPromise;

		const chunkA = Buffer.from(new Uint8Array(320).fill(1));
		const chunkB = Buffer.from(new Uint8Array(320).fill(2));
		raw.emit("data", chunkA);
		raw.emit("data", chunkB);

		const seen: Buffer[] = [];
		mic.on("data", (b) => seen.push(b));
		await flush();
		await flush();

		expect(seen.length).toBeGreaterThanOrEqual(3);
	});

	it("forwards stop() to the underlying decibri (silero path)", async () => {
		const micPromise = createMic();
		(await waitForInstance(0)).emit("data", Buffer.alloc(2));
		const mic = await micPromise;
		mic.stop();
		expect(instances()[0]?.stop).toHaveBeenCalled();
	});

	it("forwards stop() to the underlying decibri (resample-rms path)", async () => {
		const micPromise = createMic();
		(await waitForInstance(0)).emit("error", new Error("refused"));
		(await waitForInstance(1)).emit("data", Buffer.alloc(2));
		const mic = await micPromise;
		mic.stop();
		expect(instances()[1]?.stop).toHaveBeenCalled();
	});

	it("exports stable 16 kHz target constants the pipeline depends on", () => {
		expect(TARGET_SAMPLE_RATE).toBe(16000);
		expect(FRAMES_PER_BUFFER).toBe(1600);
	});
});

// Drain microtasks until an expected instance shows up. `createMic` does
// `await import("decibri")` before constructing — the dynamic-import
// resolution chain takes a handful of microtasks, so a fixed N-tick
// `flush()` is racy. Poll instead, with a cap so a real failure surfaces.
async function waitForInstance(idx = 0): Promise<MockMicInstance> {
	for (let i = 0; i < 200; i++) {
		if (instances()[idx]) return instances()[idx]!;
		await Promise.resolve();
	}
	throw new Error(`MockMic instance #${idx} was never constructed`);
}

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function makeInt16Chunk(sampleCount: number, value: number): Buffer {
	const buf = Buffer.alloc(sampleCount * 2);
	for (let i = 0; i < sampleCount; i++) buf.writeInt16LE(value, i * 2);
	return buf;
}
