/**
 * Tests for the validation module — schema-check adapter + the `withTimeout`
 * walltime cap that wraps the validation-retry loop's
 * `sendAndAwaitIdle`. `withTimeout` is a generic Promise.race helper and now
 * lives in `internal-utils.ts`; the timeout constants
 * (`DEFAULT/MIN/MAX_VALIDATION_RETRY_TIMEOUT_MS`) stay in
 * `validate-output.ts` since they're the validation-domain knobs that
 * drive the helper.
 */

import { describe, expect, it } from "vitest";
import { withTimeout } from "./internal-utils.js";
import { jsonSchemaToStandard } from "./json-schema.js";
import {
	DEFAULT_VALIDATION_RETRY_TIMEOUT_MS,
	describeFailure,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
	type SchemaValidationFailure,
	validateOutputData,
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

describe("validateOutputData — failure enrichment", () => {
	const statusSchema = jsonSchemaToStandard({
		type: "object",
		required: ["status"],
		properties: { status: { enum: ["in-progress", "in-review", "ready"] } },
	});

	it("captures the allowed enum values and the offending value on a bad enum", async () => {
		const result = await validateOutputData(statusSchema, { status: "done" });
		expect(result.valid).toBe(false);
		const f = result.failures.find((x) => x.path === "/status");
		expect(f?.allowed).toEqual(["in-progress", "in-review", "ready"]);
		expect(f?.value).toBe("done");
		expect(f?.expected).toBe("enum");
	});

	it("reports a missing required property at the root with no enum enrichment", async () => {
		// A `required` violation's instancePath is the parent object, not the
		// missing field — so the resolved value is the parent and there's no enum.
		const result = await validateOutputData(statusSchema, {});
		const f = result.failures[0];
		expect(f.path).toBe(".");
		expect(f.allowed).toBeUndefined();
		// describeFailure must not dump that parent object into the line.
		expect(describeFailure(f)).toBe(`(root): ${f.message}`);
	});

	it("recovers allowed values for nested array-item fields", async () => {
		const schema = jsonSchemaToStandard({
			type: "object",
			properties: {
				phases: { type: "array", items: { type: "object", properties: { kind: { enum: ["a", "b"] } } } },
			},
		});
		const result = await validateOutputData(schema, { phases: [{ kind: "c" }] });
		const f = result.failures.find((x) => x.path === "/phases/0/kind");
		expect(f?.allowed).toEqual(["a", "b"]);
		expect(f?.value).toBe("c");
	});
});

describe("describeFailure", () => {
	it("renders an enum mismatch with allowed values and the offending value", () => {
		const f: SchemaValidationFailure = {
			path: "/status",
			expected: "enum",
			actual: "string",
			message: "must be equal to one of the allowed values",
			value: "done",
			allowed: ["in-progress", "in-review", "ready"],
		};
		expect(describeFailure(f)).toBe('status: must be one of "in-progress", "in-review", "ready" — got "done"');
	});

	it("marks a missing field rather than printing an empty value", () => {
		const f: SchemaValidationFailure = {
			path: "/status",
			expected: "enum",
			actual: "undefined",
			message: "required",
			value: undefined,
			allowed: ["ready"],
		};
		expect(describeFailure(f)).toBe('status: must be one of "ready" — (field missing)');
	});

	it("falls back to the validator message, appending only a primitive offending value", () => {
		const f: SchemaValidationFailure = {
			path: "/phase_count",
			expected: "integer",
			actual: "string",
			message: "must be an integer",
			value: "3",
		};
		expect(describeFailure(f)).toBe('phase_count: must be an integer — got "3"');
	});

	it("does not dump an object/array offending value into the fallback line", () => {
		const f: SchemaValidationFailure = {
			path: ".",
			expected: "schema",
			actual: "object",
			message: "must have required property 'status'",
			value: { a: 1 },
		};
		expect(describeFailure(f)).toBe("(root): must have required property 'status'");
	});

	it("flattens nested JSON-pointer paths to dotted field names", () => {
		const f: SchemaValidationFailure = {
			path: "/phases/0/n",
			expected: "integer",
			actual: "string",
			message: "must be an integer",
			value: "x",
		};
		expect(describeFailure(f)).toBe('phases.0.n: must be an integer — got "x"');
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
