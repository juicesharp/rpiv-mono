import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn(actual.existsSync),
		mkdirSync: vi.fn(actual.mkdirSync),
		rmSync: vi.fn(actual.rmSync),
		writeFileSync: vi.fn(actual.writeFileSync),
		createWriteStream: vi.fn(actual.createWriteStream),
	};
});

vi.mock("../config/voice-config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../config/voice-config.js")>();
	return {
		...actual,
		loadVoiceConfig: vi.fn(() => ({})),
	};
});

import { existsSync, rmSync } from "node:fs";
import { loadVoiceConfig } from "../config/voice-config.js";
import {
	assertModelIntact,
	ensureModelDownloaded,
	getModelPaths,
	isModelDownloaded,
	ModelInstallError,
	removeModelInstall,
	WHISPER_BASE_DIR,
} from "./model-download.js";

beforeEach(() => {
	vi.mocked(loadVoiceConfig).mockReturnValue({});
});

describe("isModelDownloaded", () => {
	it("returns true when sentinel file exists", () => {
		vi.mocked(existsSync).mockReturnValueOnce(true);
		expect(isModelDownloaded()).toBe(true);
	});
	it("returns false when sentinel file is missing", () => {
		vi.mocked(existsSync).mockReturnValueOnce(false);
		expect(isModelDownloaded()).toBe(false);
	});
});

describe("getModelPaths", () => {
	it("returns paths under whisper-base/", () => {
		const paths = getModelPaths();
		expect(paths.encoderPath).toContain("whisper-base");
		expect(paths.decoderPath).toContain("whisper-base");
		expect(paths.tokensPath).toContain("whisper-base");
	});

	it("returns paths under whisper-tiny/ when configured", () => {
		vi.mocked(loadVoiceConfig).mockReturnValue({ whisperModelType: "tiny" });
		const paths = getModelPaths();
		expect(paths.encoderPath).toContain("whisper-tiny");
		expect(paths.decoderPath).toContain("whisper-tiny");
		expect(paths.tokensPath).toContain("whisper-tiny");
		expect(paths.encoderPath).toContain("tiny-encoder.int8.onnx");
	});
});

describe("ensureModelDownloaded", () => {
	it("skips download when model already exists", async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		const onProgress = vi.fn();
		const paths = await ensureModelDownloaded(onProgress);
		expect(paths.encoderPath).toContain("base-encoder.int8.onnx");
		expect(onProgress).not.toHaveBeenCalled();
	});

	it("skips download when custom model already exists", async () => {
		vi.mocked(loadVoiceConfig).mockReturnValue({ whisperModelType: "tiny" });
		vi.mocked(existsSync).mockReturnValue(true);
		const onProgress = vi.fn();
		const paths = await ensureModelDownloaded(onProgress);
		expect(paths.encoderPath).toContain("tiny-encoder.int8.onnx");
		expect(onProgress).not.toHaveBeenCalled();
	});
});

describe("ensureModelDownloaded — failure rollback", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.mocked(existsSync).mockReturnValue(false); // sentinel never exists during these runs
		vi.mocked(rmSync).mockClear();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("wipes the model dir when fetch fails (network down)", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND")) as unknown as typeof fetch;

		await expect(ensureModelDownloaded(() => {})).rejects.toMatchObject({
			name: "ModelInstallError",
			stage: "download",
		});

		const wiped = vi
			.mocked(rmSync)
			.mock.calls.some((args) => args[0] === WHISPER_BASE_DIR && args[1]?.recursive === true);
		expect(wiped).toBe(true);
	});

	it("wipes the model dir when HTTP returns non-200", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 503,
			body: null,
		} as unknown as Response) as unknown as typeof fetch;

		const err = await ensureModelDownloaded(() => {}).catch((e) => e);
		expect(err).toBeInstanceOf(ModelInstallError);
		expect((err as ModelInstallError).stage).toBe("download");

		const wiped = vi
			.mocked(rmSync)
			.mock.calls.some((args) => args[0] === WHISPER_BASE_DIR && args[1]?.recursive === true);
		expect(wiped).toBe(true);
	});
});

describe("removeModelInstall", () => {
	it("rmSyncs the whisper-base dir recursively + force", () => {
		vi.mocked(rmSync).mockClear();
		removeModelInstall();
		expect(vi.mocked(rmSync)).toHaveBeenCalledWith(WHISPER_BASE_DIR, { recursive: true, force: true });
	});
});

describe("ensureModelDownloaded — progress reporting", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.mocked(existsSync).mockReturnValue(false);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	function fakeResponse(chunks: Uint8Array[], totalHeader: string | null): Response {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const c of chunks) controller.enqueue(c);
				controller.close();
			},
		});
		return new Response(stream, {
			status: 200,
			headers: totalHeader ? { "content-length": totalHeader } : {},
		});
	}

	it("emits a final progress event with percent=100 when Content-Length is known", async () => {
		const chunks = [new Uint8Array(50), new Uint8Array(50)]; // total 100 bytes
		globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse(chunks, "100")) as unknown as typeof fetch;

		const events: Array<{ percent?: number; bytesReceived?: number; totalBytes?: number }> = [];
		await ensureModelDownloaded((p) => {
			events.push({ percent: p.percent, bytesReceived: p.bytesReceived, totalBytes: p.totalBytes });
		}).catch(() => {
			// Extract / verify will fail on our zero-byte fake archive — that's
			// expected; we only care about progress events emitted before then.
		});

		// Last byte-count emit must be 100 % with the known total.
		let final: (typeof events)[number] | undefined;
		for (let i = events.length - 1; i >= 0; i--) {
			if (events[i].bytesReceived === 100) {
				final = events[i];
				break;
			}
		}
		expect(final).toBeDefined();
		expect(final?.percent).toBe(100);
		expect(final?.totalBytes).toBe(100);
	});

	it("emits byte counts without percent when Content-Length is missing", async () => {
		const chunks = [new Uint8Array(75)];
		globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse(chunks, null)) as unknown as typeof fetch;

		const events: Array<{ percent?: number; bytesReceived?: number; totalBytes?: number }> = [];
		await ensureModelDownloaded((p) => {
			events.push({ percent: p.percent, bytesReceived: p.bytesReceived, totalBytes: p.totalBytes });
		}).catch(() => {});

		const withBytes = events.find((e) => e.bytesReceived !== undefined);
		// Without Content-Length, throttling may suppress mid-stream emits, but
		// the final event still carries the cumulative byte count.
		expect(withBytes ?? events[events.length - 1]).toBeDefined();
		const observed = events.filter((e) => e.bytesReceived !== undefined);
		for (const e of observed) {
			expect(e.percent).toBeUndefined();
			expect(e.totalBytes).toBeUndefined();
		}
	});
});

describe("assertModelIntact", () => {
	it("throws when a required model file is missing", () => {
		// Override existsSync per call: first two true (encoder, decoder) then false (tokens)
		const seq = [true, false];
		vi.mocked(existsSync).mockImplementation(() => seq.shift() ?? false);
		expect(() => assertModelIntact()).toThrow(/Model verification failed/);
	});

	it("does not throw when all required files exist", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		expect(() => assertModelIntact()).not.toThrow();
	});
});
