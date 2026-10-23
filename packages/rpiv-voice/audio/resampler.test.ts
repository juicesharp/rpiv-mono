import { describe, expect, it } from "vitest";
import { Int16LinearResampler } from "./resampler.ts";

function pcmFromSamples(samples: number[]): Buffer {
	const buf = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i]!, i * 2);
	return buf;
}

function pcmToSamples(buf: Buffer): number[] {
	const out: number[] = [];
	for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i));
	return out;
}

describe("Int16LinearResampler", () => {
	it("48 kHz → 16 kHz decimates by 3 with no interpolation phase drift", () => {
		// Synthetic ramp; 48k→16k with linear interp should pick every 3rd
		// sample (the integer ratio collapses interpolation to identity).
		// Streaming property: the algorithm needs one input sample of
		// read-ahead per output, so the trailing input sample (index 9 = 900)
		// is held back as state until the next chunk arrives. That is the
		// correct steady-state behavior — verified by the cross-boundary
		// test below — and produces a fixed 1-sample group delay.
		const r = new Int16LinearResampler(48000, 16000);
		const input = pcmFromSamples([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
		const out = pcmToSamples(r.process(input));
		expect(out).toEqual([0, 300, 600]);
	});

	it("16 kHz → 32 kHz upsample interleaves midpoints", () => {
		const r = new Int16LinearResampler(16000, 32000);
		const out = pcmToSamples(r.process(pcmFromSamples([0, 1000, 2000, 3000])));
		// First sample primes; then for each (prev, cur) pair we emit prev,
		// then the midpoint, so the output is [0, 500, 1000, 1500, 2000, 2500].
		expect(out).toEqual([0, 500, 1000, 1500, 2000, 2500]);
	});

	it("identity 16 kHz → 16 kHz passes samples through (minus the prime sample)", () => {
		const r = new Int16LinearResampler(16000, 16000);
		const out = pcmToSamples(r.process(pcmFromSamples([10, 20, 30, 40])));
		expect(out).toEqual([10, 20, 30]);
	});

	it("state persists across chunk boundaries (piecewise input matches concat input)", () => {
		const all = pcmFromSamples([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000]);
		const single = new Int16LinearResampler(48000, 16000);
		const expected = pcmToSamples(single.process(all));

		const piecewise = new Int16LinearResampler(48000, 16000);
		const halves: number[] = [];
		halves.push(...pcmToSamples(piecewise.process(all.subarray(0, 8))));
		halves.push(...pcmToSamples(piecewise.process(all.subarray(8, 16))));
		halves.push(...pcmToSamples(piecewise.process(all.subarray(16))));

		expect(halves).toEqual(expected);
	});

	it("44.1 kHz → 16 kHz produces roughly the expected sample count", () => {
		const r = new Int16LinearResampler(44100, 16000);
		const sourceSamples = 4410; // 100 ms at 44.1 kHz
		const input = pcmFromSamples(Array.from({ length: sourceSamples }, (_, i) => i));
		const out = pcmToSamples(r.process(input));
		// ~1600 output samples; the first input sample primes the filter so
		// the steady-state output count is floor((N-1) / step).
		const expected = Math.floor((sourceSamples - 1) / (44100 / 16000));
		expect(out.length).toBeGreaterThanOrEqual(expected - 1);
		expect(out.length).toBeLessThanOrEqual(expected + 1);
	});

	it("rejects non-positive rates", () => {
		expect(() => new Int16LinearResampler(0, 16000)).toThrow(/must be positive/);
		expect(() => new Int16LinearResampler(48000, -1)).toThrow(/must be positive/);
	});

	it("returns an empty buffer on empty input without touching internal state", () => {
		const r = new Int16LinearResampler(48000, 16000);
		expect(r.process(Buffer.alloc(0)).length).toBe(0);
		const out = pcmToSamples(r.process(pcmFromSamples([0, 300, 600, 900])));
		// Same as if the empty call never happened: prime on 0, emit one
		// sample (value 0) at source-index 1, hold the rest as carry.
		expect(out).toEqual([0]);
	});
});
