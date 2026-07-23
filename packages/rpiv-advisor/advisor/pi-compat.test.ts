/**
 * pi-compat tests — the host-version-tolerant `completeSimple` loader.
 *
 * The consumer test files mock `@earendil-works/pi-ai/compat` to SUCCEED, so
 * the version-tolerance arms the shim exists for are exercised here instead:
 * /compat resolves (host >= 0.80.1), /compat unresolvable → root fallback
 * (host <= 0.79.x), a REAL /compat failure rethrows instead of masking, and a
 * host with neither export fails with a clear error.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getRuntimeCompleteSimple } from "./pi-compat.js";

describe("getRuntimeCompleteSimple", () => {
	it("returns a method bound to the host runtime", async () => {
		const runtime = {
			completeSimple: vi.fn(function (this: unknown) {
				expect(this).toBe(runtime);
				return Promise.resolve(undefined as never);
			}),
		};
		const completeSimple = getRuntimeCompleteSimple({ runtime });

		expect(completeSimple).toBeTypeOf("function");
		if (!completeSimple) throw new Error("expected runtime completion facade");
		await completeSimple(undefined as never, undefined as never);
		expect(runtime.completeSimple).toHaveBeenCalledOnce();
	});

	it("returns undefined for missing or malformed runtime facades", () => {
		expect(getRuntimeCompleteSimple(undefined)).toBeUndefined();
		expect(getRuntimeCompleteSimple({ runtime: null })).toBeUndefined();
		expect(getRuntimeCompleteSimple({ runtime: { completeSimple: "not-a-function" } })).toBeUndefined();
	});
});

describe("loadCompleteSimple", () => {
	afterEach(() => {
		vi.doUnmock("@earendil-works/pi-ai/compat");
		vi.doUnmock("@earendil-works/pi-ai");
		vi.resetModules();
	});

	/** Import the shim AFTER the per-test doMocks so its dynamic imports resolve
	 *  against them (vi.resetModules first drops any previously-cached copies). */
	async function load(): Promise<unknown> {
		const mod = await import("./pi-compat.js");
		return mod.loadCompleteSimple();
	}

	it("resolves completeSimple from /compat when the host exposes it (pi >= 0.80.1)", async () => {
		vi.resetModules();
		const compatFn = vi.fn();
		vi.doMock("@earendil-works/pi-ai/compat", () => ({ completeSimple: compatFn }));
		await expect(load()).resolves.toBe(compatFn);
	});

	it("falls back to the package root when /compat is not exported (host <= 0.79.x)", async () => {
		vi.resetModules();
		vi.doMock("@earendil-works/pi-ai/compat", () => {
			// The code an installed-but-old pi-ai actually produces: the package
			// resolves, but "./compat" is missing from its exports map.
			throw Object.assign(new Error("Package subpath './compat' is not defined"), {
				code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
			});
		});
		const rootFn = vi.fn();
		vi.doMock("@earendil-works/pi-ai", () => ({ completeSimple: rootFn }));
		await expect(load()).resolves.toBe(rootFn);
	});

	it("rethrows a non-resolution /compat failure instead of masking it with the root fallback", async () => {
		vi.resetModules();
		vi.doMock("@earendil-works/pi-ai/compat", () => {
			throw new Error("compat entrypoint exploded at module init");
		});
		// A WORKING root export proves the rejection comes from the rethrow: the
		// old catch-all `.catch` fallback would have resolved here.
		vi.doMock("@earendil-works/pi-ai", () => ({ completeSimple: vi.fn() }));
		await expect(load()).rejects.toThrow();
	});

	it("fails with a clear error when neither entrypoint exposes completeSimple", async () => {
		vi.resetModules();
		vi.doMock("@earendil-works/pi-ai/compat", () => ({}));
		await expect(load()).rejects.toThrow(/completeSimple/);
	});
});
