import { describe, expect, it, vi } from "vitest";

vi.mock("decibri", () => {
	throw new Error("Cannot find module 'decibri' (simulated darwin-x64 native addon load failure)");
});

vi.mock("./decibri-audiomic-shim.js", () => {
	type Listener = (...args: unknown[]) => void;
	class MockShim {
		opts: Record<string, unknown>;
		stop = vi.fn();
		_listeners: Record<string, Listener[]> = {};
		constructor(opts: Record<string, unknown>) {
			this.opts = opts;
			// Mirrors the real shim's behavior: reject on vad:true, succeed
			// (emit data) on vad:false — simulates the built-in-mic fallback
			// path from issue #46 without depending on the real @audio/mic
			// package.
			if (opts.vad) {
				queueMicrotask(() => this.emit("error", new Error("shim: vad not supported")));
			} else {
				queueMicrotask(() => this.emit("data", Buffer.from([1, 2, 3, 4])));
			}
		}
		on(event: string, fn: Listener): this {
			// Plain 3-line form, not `(this._listeners[event] ??= []).push(fn)` —
			// the latter trips this repo's biome noAssignInExpressions rule
			// (enforced with --error-on-warnings in the pre-commit hook; confirmed
			// by a real run that failed to commit over exactly this). Matches the
			// exact style already used in mic-source.test.ts's own MockMic.
			const list = this._listeners[event] ?? [];
			list.push(fn);
			this._listeners[event] = list;
			return this;
		}
		once(event: string, fn: Listener): this {
			// Tag the wrapper with `.listener` pointing at the original fn,
			// mirroring Node's real EventEmitter. mic-source.ts's settle()
			// calls raw.removeListener(event, onError) with the ORIGINAL
			// callback reference, not this wrapper — real EventEmitter matches
			// through this tag. Without it, removeListener silently no-ops
			// against a once()-registered listener and settle() would throw
			// (confirmed by a real run: "raw.removeListener is not a function"
			// without this fix entirely; even WITH a naive removeListener that
			// only matches by direct reference, it would still silently fail
			// to actually remove a once()-wrapped listener without this tag).
			const wrap: Listener & { listener?: Listener } = (...args) => {
				this._listeners[event] = (this._listeners[event] ?? []).filter((f) => f !== wrap);
				fn(...args);
			};
			wrap.listener = fn;
			return this.on(event, wrap);
		}
		removeListener(event: string, fn: Listener): this {
			this._listeners[event] = (this._listeners[event] ?? []).filter(
				(f) => f !== fn && (f as Listener & { listener?: Listener }).listener !== fn,
			);
			return this;
		}
		emit(event: string, ...args: unknown[]): void {
			for (const fn of [...(this._listeners[event] ?? [])]) fn(...args);
		}
	}
	return { default: MockShim };
});

vi.mock("./error-log.js", () => ({
	appendErrorLog: vi.fn(),
	appendDiagnosticLog: vi.fn(),
}));

import { appendDiagnosticLog } from "./error-log.js";
import { createMic } from "./mic-source.js";

describe("createMic() fallback to decibri-audiomic-shim", () => {
	it("falls back to the shim when decibri fails to load, and resolves via Strategy 2", async () => {
		const mic = await createMic();
		expect(mic).toBeTruthy();
		expect(appendDiagnosticLog).toHaveBeenCalledWith("mic.backend", "audiomic-shim (decibri unavailable)");
		// Strategy 1 (vad:true, 16kHz) was attempted against the shim first
		// and rejected, then Strategy 2 (vad:false, fallback rate) succeeded —
		// mirrors the exact built-in-mic fallback path from issue #46, just
		// routed through the shim instead of the real decibri addon.
		expect(appendDiagnosticLog).toHaveBeenCalledWith("mic.path", expect.stringMatching(/^resample-rms@\d+Hz$/));
		mic.stop();
	});
});
