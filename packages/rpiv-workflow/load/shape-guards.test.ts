/**
 * Direct unit tests for the loader's small shape guards + formatting
 * helpers. `isWorkflow` / `isEnvelope` are exercised transitively through
 * `loadWorkflows` integration tests — but `describe` + `formatError`
 * have branches that aren't reachable from the integration path
 * (`normalizeDefaultExport` handles Arrays before reaching `describe`;
 * jiti's `default: true` extraction rewrites `null` / `undefined`
 * defaults). These tests pin the contract at the unit level.
 */

import { describe, expect, it } from "vitest";
import { describe as describeValue, formatError, isEnvelope, isWorkflow } from "./shape-guards.js";

describe("describe", () => {
	it("returns 'null' for null", () => {
		expect(describeValue(null)).toBe("null");
	});

	it("returns 'undefined' for undefined", () => {
		expect(describeValue(undefined)).toBe("undefined");
	});

	it("returns 'an array' for arrays", () => {
		expect(describeValue([])).toBe("an array");
		expect(describeValue([1, 2, 3])).toBe("an array");
	});

	it("returns the typeof for primitives", () => {
		expect(describeValue(42)).toBe("number");
		expect(describeValue("hi")).toBe("string");
		expect(describeValue(true)).toBe("boolean");
	});

	it("returns 'object' for plain objects", () => {
		expect(describeValue({})).toBe("object");
	});
});

describe("formatError", () => {
	it("returns the message for Error instances", () => {
		expect(formatError(new Error("boom"))).toBe("boom");
	});

	it("returns the string form for non-Error values", () => {
		expect(formatError("nope")).toBe("nope");
		expect(formatError(42)).toBe("42");
		expect(formatError({ toString: () => "obj" })).toBe("obj");
	});
});

describe("isWorkflow", () => {
	it("rejects truthy non-objects on stages/edges", () => {
		expect(isWorkflow({ name: "x", start: "y", stages: "foo", edges: 1 })).toBe(false);
		expect(isWorkflow({ name: "x", start: "y", stages: {}, edges: [] })).toBe(true);
	});

	it("rejects null/undefined", () => {
		expect(isWorkflow(null)).toBe(false);
		expect(isWorkflow(undefined)).toBe(false);
	});
});

describe("isEnvelope", () => {
	it("recognizes an envelope by its workflows array", () => {
		expect(isEnvelope({ workflows: [] })).toBe(true);
		expect(isEnvelope({ workflows: [{}], default: "x" })).toBe(true);
	});

	it("rejects shapes missing workflows", () => {
		expect(isEnvelope({})).toBe(false);
		expect(isEnvelope(null)).toBe(false);
		expect(isEnvelope({ workflows: "not an array" })).toBe(false);
	});
});
