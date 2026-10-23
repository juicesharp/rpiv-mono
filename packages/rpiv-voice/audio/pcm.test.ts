import { describe, expect, it } from "vitest";

import { bufferToFloat32, clamp01, computeRmsFloat32, computeRmsInt16, samplesInInt16Chunk } from "./pcm.ts";

describe("bufferToFloat32", () => {
	it("converts int16 LE samples to float32 in [-1, +1]", () => {
		const buf = Buffer.alloc(4);
		buf.writeInt16LE(16384, 0); // ~0.5
		buf.writeInt16LE(-16384, 2); // ~-0.5
		const result = bufferToFloat32(buf);
		expect(result).toHaveLength(2);
		expect(result[0]).toBeCloseTo(16384 / 0x8000, 4);
		expect(result[1]).toBeCloseTo(-16384 / 0x8000, 4);
	});

	it("returns empty Float32Array for empty buffer", () => {
		const result = bufferToFloat32(Buffer.alloc(0));
		expect(result).toHaveLength(0);
	});

	it("converts max int16 to ~1.0", () => {
		const buf = Buffer.alloc(2);
		buf.writeInt16LE(0x7fff, 0);
		const result = bufferToFloat32(buf);
		expect(result[0]).toBeCloseTo(0x7fff / 0x8000, 4);
	});
});

describe("computeRmsInt16", () => {
	it("returns 0 for empty buffer", () => {
		expect(computeRmsInt16(Buffer.alloc(0))).toBe(0);
	});

	it("returns 0 for silent buffer", () => {
		expect(computeRmsInt16(Buffer.alloc(4))).toBe(0);
	});

	it("computes RMS for known amplitude", () => {
		// Two samples at ±0.5 → RMS = sqrt((0.25+0.25)/2) = 0.5
		const buf = Buffer.alloc(4);
		buf.writeInt16LE(16384, 0);
		buf.writeInt16LE(-16384, 2);
		expect(computeRmsInt16(buf)).toBeCloseTo(0.5, 3);
	});

	it("clamps result to [0, 1]", () => {
		// Full-scale signal → RMS should be clamped to 1
		const buf = Buffer.alloc(2);
		buf.writeInt16LE(0x7fff, 0);
		const rms = computeRmsInt16(buf);
		expect(rms).toBeLessThanOrEqual(1);
		expect(rms).toBeGreaterThanOrEqual(0);
	});
});

describe("computeRmsFloat32", () => {
	it("returns 0 for empty array", () => {
		expect(computeRmsFloat32(new Float32Array(0))).toBe(0);
	});

	it("returns 0 for silent array", () => {
		expect(computeRmsFloat32(new Float32Array([0, 0, 0]))).toBe(0);
	});

	it("computes RMS for known values", () => {
		// [0.6, -0.8] → RMS = sqrt((0.36+0.64)/2) = sqrt(0.5) ≈ 0.7071
		expect(computeRmsFloat32(new Float32Array([0.6, -0.8]))).toBeCloseTo(Math.sqrt(0.5), 4);
	});

	it("returns 1.0 for full-scale signal", () => {
		expect(computeRmsFloat32(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1.0, 4);
	});
});

describe("clamp01", () => {
	it("clamps negative to 0", () => {
		expect(clamp01(-0.5)).toBe(0);
	});

	it("clamps above 1 to 1", () => {
		expect(clamp01(1.5)).toBe(1);
	});

	it("passes through values in [0, 1]", () => {
		expect(clamp01(0)).toBe(0);
		expect(clamp01(0.5)).toBe(0.5);
		expect(clamp01(1)).toBe(1);
	});
});

describe("samplesInInt16Chunk", () => {
	it("returns number of int16 samples in a buffer", () => {
		expect(samplesInInt16Chunk(Buffer.alloc(200))).toBe(100);
		expect(samplesInInt16Chunk(Buffer.alloc(0))).toBe(0);
		expect(samplesInInt16Chunk(Buffer.alloc(2))).toBe(1);
	});
});
