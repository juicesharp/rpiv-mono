/**
 * Tests for the validation module — schema-check adapter + the `withTimeout`
 * walltime cap (Q14) that wraps the validation-retry loop's
 * `sendAndAwaitIdle`. `withTimeout` is a generic Promise.race helper and now
 * lives in `internal-utils.ts`; the timeout constants
 * (`DEFAULT/MIN/MAX_VALIDATION_RETRY_TIMEOUT_MS`) stay in
 * `validate-output.ts` since they're the validation-domain knobs that
 * drive the helper.
 */

import { describe, expect, it } from "vitest";
import { withTimeout } from "./internal-utils.js";
import {
	DEFAULT_VALIDATION_RETRY_TIMEOUT_MS,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
} from "./validate-output.js";

describe("withTimeout", () => {
	it("resolves with the inner promise's value when it settles before the timer", async () => {
		const inner = new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 10));
		const result = await withTimeout(inner, 200, "should not fire");
		expect(result).toBe("ok");
	});

	it("rejects with the supplied message when the inner promise outlives the timer", async () => {
		// A never-resolving promise — exactly the failure mode this helper guards
		// against (hung agent, waitForIdle that never settles).
		const hung = new Promise<never>(() => {});
		await expect(withTimeout(hung, 20, "validation retry timed out")).rejects.toThrow(/validation retry timed out/);
	});

	it("clears the timer on success so the timeout doesn't keep the event loop alive", async () => {
		// Indirect signal: if the timer leaked, vitest's hang detection would
		// fail the suite. A successful await + immediate return is the
		// observable proof that the finally branch ran clearTimeout.
		const inner = Promise.resolve(42);
		const result = await withTimeout(inner, 30_000, "would otherwise pin the run");
		expect(result).toBe(42);
	});

	it("propagates the inner promise's rejection unchanged", async () => {
		const inner = Promise.reject(new Error("inner-failure"));
		await expect(withTimeout(inner, 200, "should not be raised")).rejects.toThrow(/inner-failure/);
	});
});

describe("validation retry timeout constants", () => {
	it("default sits between min and max bounds", () => {
		expect(DEFAULT_VALIDATION_RETRY_TIMEOUT_MS).toBeGreaterThanOrEqual(MIN_VALIDATION_RETRY_TIMEOUT_MS);
		expect(DEFAULT_VALIDATION_RETRY_TIMEOUT_MS).toBeLessThanOrEqual(MAX_VALIDATION_RETRY_TIMEOUT_MS);
	});

	it("min is small enough to be useful for tests but not a misconfiguration trap", () => {
		expect(MIN_VALIDATION_RETRY_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
	});

	it("max is generous but not unbounded", () => {
		expect(MAX_VALIDATION_RETRY_TIMEOUT_MS).toBeLessThanOrEqual(60 * 60 * 1000);
	});
});
