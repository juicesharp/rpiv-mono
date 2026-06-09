/**
 * Tests for json-schema.ts — Raw-JSON-Schema ↔ Standard Schema bridge +
 * introspection helpers.
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	extractJsonSchema,
	hasJsonSchema,
	isJsonSchemaObject,
	jsonSchemaConverter,
	jsonSchemaToStandard,
	validateToJsonSchemaIssues,
} from "./json-schema.js";
import { isSchemaCompatible } from "./schema-compat.js";
import { typeboxSchema } from "./typebox-adapter.js";

// ---------------------------------------------------------------------------
// isJsonSchemaObject
// ---------------------------------------------------------------------------

describe("isJsonSchemaObject", () => {
	it("accepts plain objects", () => {
		expect(isJsonSchemaObject({ type: "string" })).toBe(true);
		expect(isJsonSchemaObject({})).toBe(true);
	});

	it("rejects non-objects", () => {
		expect(isJsonSchemaObject(null)).toBe(false);
		expect(isJsonSchemaObject("string")).toBe(false);
		expect(isJsonSchemaObject(42)).toBe(false);
		expect(isJsonSchemaObject(true)).toBe(false);
	});

	it("rejects arrays", () => {
		expect(isJsonSchemaObject([{ type: "string" }])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// jsonSchemaConverter
// ---------------------------------------------------------------------------

describe("jsonSchemaConverter", () => {
	const schema = { type: "object", properties: { name: { type: "string" } } };

	it("returns the schema for draft-2020-12", () => {
		const result = jsonSchemaConverter(schema).output({ target: "draft-2020-12" });
		expect(result).toEqual(schema);
	});

	it("returns the schema for draft-07", () => {
		const result = jsonSchemaConverter(schema).output({ target: "draft-07" });
		expect(result).toEqual(schema);
	});

	it("throws for an unsupported target", () => {
		expect(() => jsonSchemaConverter(schema).output({ target: "draft-04" })).toThrow(
			/jsonSchema: unsupported target "draft-04"/,
		);
	});

	it("input converter also returns the schema for valid targets", () => {
		const result = jsonSchemaConverter(schema).input({ target: "draft-2020-12" });
		expect(result).toEqual(schema);
	});
});

// ---------------------------------------------------------------------------
// jsonSchemaToStandard
// ---------------------------------------------------------------------------

describe("jsonSchemaToStandard", () => {
	const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };

	it("validates valid data", async () => {
		const std = jsonSchemaToStandard(schema);
		const result = await std["~standard"].validate({ name: "Alice" });
		if ("issues" in result && result.issues !== undefined) {
			throw new Error("Expected success, got issues");
		}
		expect(result.value).toEqual({ name: "Alice" });
	});

	it("validates invalid data and reports issues", async () => {
		const std = jsonSchemaToStandard(schema);
		const result = await std["~standard"].validate({ name: 42 });
		if (!("issues" in result && result.issues !== undefined)) {
			throw new Error("Expected failure, got success");
		}
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.issues[0].message).toBeTruthy();
	});

	it("carries the jsonSchema Converter", () => {
		const std = jsonSchemaToStandard(schema);
		expect(typeof std["~standard"].jsonSchema?.output).toBe("function");
		const extracted = std["~standard"].jsonSchema.output({ target: "draft-2020-12" });
		expect(extracted).toEqual(schema);
	});

	it("reports issues with path for nested validation failures", async () => {
		const nested = {
			type: "object",
			properties: {
				address: {
					type: "object",
					properties: { zip: { type: "number" } },
					required: ["zip"],
				},
			},
			required: ["address"],
		};
		const std = jsonSchemaToStandard(nested);
		const result = await std["~standard"].validate({ address: { zip: "not-a-number" } });
		if (!("issues" in result && result.issues !== undefined)) {
			throw new Error("Expected failure, got success");
		}
		// Should have at least one issue with a path pointing to /address/zip
		expect(result.issues.some((i) => i.path && i.path.length > 0)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// hasJsonSchema
// ---------------------------------------------------------------------------

describe("hasJsonSchema", () => {
	it("returns true for typebox-wrapped schemas (they now carry the Converter)", () => {
		const schema = typeboxSchema(Type.Object({ name: Type.String() }));
		expect(hasJsonSchema(schema)).toBe(true);
	});

	it("returns true for jsonSchemaToStandard-wrapped schemas", () => {
		const schema = jsonSchemaToStandard({ type: "string" });
		expect(hasJsonSchema(schema)).toBe(true);
	});

	it("returns false for a validate-only ~standard stub", () => {
		const stub: { "~standard": { version: 1; vendor: string; validate: (v: unknown) => { value: unknown } } } = {
			"~standard": {
				version: 1,
				vendor: "test",
				validate: (v: unknown) => ({ value: v }),
			},
		};
		expect(hasJsonSchema(stub as any)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(hasJsonSchema(undefined)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// extractJsonSchema
// ---------------------------------------------------------------------------

describe("extractJsonSchema", () => {
	it("round-trips a TypeBox schema via extractJsonSchema", () => {
		const schema = typeboxSchema(Type.Object({ name: Type.String() }));
		const extracted = extractJsonSchema(schema);
		expect(extracted).toBeDefined();
		expect(extracted!.type).toBe("object");
		expect((extracted as Record<string, unknown>).properties).toBeDefined();
	});

	it("round-trips a raw JSON Schema via jsonSchemaToStandard + extractJsonSchema", () => {
		const raw = { type: "string", minLength: 1 };
		const wrapped = jsonSchemaToStandard(raw);
		const extracted = extractJsonSchema(wrapped);
		expect(extracted).toEqual(raw);
	});

	it("returns undefined for a validate-only stub (no Converter)", () => {
		const stub = {
			"~standard": {
				version: 1,
				vendor: "test",
				validate: (v: unknown) => ({ value: v }),
			},
		};
		expect(extractJsonSchema(stub as any)).toBeUndefined();
	});

	it("returns undefined for undefined input", () => {
		expect(extractJsonSchema(undefined)).toBeUndefined();
	});

	it("returns undefined when Converter throws for the requested target", () => {
		// Schema that only supports draft-2020-12 — extractJsonSchema with target "draft-04"
		// should catch the throw and return undefined.
		const schema = jsonSchemaToStandard({ type: "string" });
		// The Converter in jsonSchemaToStandard throws for unsupported targets.
		// extractJsonSchema should swallow the error and return undefined.
		expect(extractJsonSchema(schema, "draft-04" as any)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Integration: typeboxSchema round-trips through extractJsonSchema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// validateToJsonSchemaIssues — shared validation helper
// ---------------------------------------------------------------------------

describe("validateToJsonSchemaIssues", () => {
	it("returns { value } for valid data against a JSON Schema object", () => {
		const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
		const result = validateToJsonSchemaIssues(schema, { name: "Alice" });
		expect("value" in result).toBe(true);
	});

	it("returns { issues } for invalid data with message and path", () => {
		const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
		const result = validateToJsonSchemaIssues(schema, { name: 42 });
		expect("issues" in result).toBe(true);
		if ("issues" in result && result.issues) {
			expect(result.issues.length).toBeGreaterThan(0);
			expect(result.issues[0].message).toBeTruthy();
		}
	});

	it("returns { issues } with path for nested validation failures", () => {
		const schema = {
			type: "object",
			properties: { address: { type: "object", properties: { zip: { type: "number" } }, required: ["zip"] } },
			required: ["address"],
		};
		const result = validateToJsonSchemaIssues(schema, { address: { zip: "not-a-number" } });
		expect("issues" in result).toBe(true);
		if ("issues" in result && result.issues) {
			expect(result.issues.some((i) => i.path && i.path.length > 0)).toBe(true);
		}
	});
});

describe("typeboxSchema <-> extractJsonSchema round-trip", () => {
	it("a TypeBox schema round-trips: extractJsonSchema produces a JSON Schema object that validates the same values", async () => {
		const schema = typeboxSchema(Type.Object({ count: Type.Number() }));
		const extracted = extractJsonSchema(schema);
		expect(extracted).toBeDefined();
		expect(extracted!.type).toBe("object");

		// Use extractJsonSchema to wrap the extracted schema again — it should validate
		// the same values.
		const rewrapped = jsonSchemaToStandard(extracted!);
		const validResult = await rewrapped["~standard"].validate({ count: 42 });
		expect("value" in validResult && validResult.value).toEqual({ count: 42 });

		const invalidResult = await rewrapped["~standard"].validate({ count: "not a number" });
		expect("issues" in invalidResult && invalidResult.issues!.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// isSchemaCompatible — conservative structural comparator
// ---------------------------------------------------------------------------

describe("isSchemaCompatible", () => {
	it("returns ok:true for two identical object schemas", () => {
		const schema = { type: "object", properties: { name: { type: "string" } } };
		expect(isSchemaCompatible(schema, schema)).toEqual({ ok: true });
	});

	it("flags disjoint type sets — string vs number", () => {
		const producer = { type: "object", properties: { a: { type: "string" } } };
		const consumer = { type: "object", properties: { a: { type: "number" } } };
		const result = isSchemaCompatible(producer, consumer);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/field "a": producer emits string but consumer expects number/);
	});

	it("does NOT flag integer vs number (subtype)", () => {
		const producer = { type: "object", properties: { count: { type: "integer" } } };
		const consumer = { type: "object", properties: { count: { type: "number" } } };
		expect(isSchemaCompatible(producer, consumer)).toEqual({ ok: true });
	});

	it("does NOT flag number vs integer", () => {
		const producer = { type: "object", properties: { count: { type: "number" } } };
		const consumer = { type: "object", properties: { count: { type: "integer" } } };
		expect(isSchemaCompatible(producer, consumer)).toEqual({ ok: true });
	});

	it("handles type arrays that overlap (no false positive)", () => {
		const producer = { type: "object", properties: { v: { type: ["string", "null"] } } };
		const consumer = { type: "object", properties: { v: { type: "string" } } };
		expect(isSchemaCompatible(producer, consumer)).toEqual({ ok: true });
	});

	it("flags truly disjoint type arrays", () => {
		const producer = { type: "object", properties: { v: { type: ["string", "null"] } } };
		const consumer = { type: "object", properties: { v: { type: "number" } } };
		const result = isSchemaCompatible(producer, consumer);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/field "v": producer emits/);
	});

	it("flags disjoint enums", () => {
		const producer = { type: "object", properties: { status: { type: "string", enum: ["ok", "pending"] } } };
		const consumer = { type: "object", properties: { status: { type: "string", enum: ["error", "failed"] } } };
		const result = isSchemaCompatible(producer, consumer);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/field "status": producer enum is disjoint from consumer enum/);
	});

	it("does NOT flag overlapping enums", () => {
		const producer = { type: "object", properties: { status: { type: "string", enum: ["ok", "pending"] } } };
		const consumer = { type: "object", properties: { status: { type: "string", enum: ["ok", "done"] } } };
		expect(isSchemaCompatible(producer, consumer)).toEqual({ ok: true });
	});

	it("flags conflicting const values", () => {
		const producer = { type: "object", properties: { mode: { const: "fast" } } };
		const consumer = { type: "object", properties: { mode: { const: "slow" } } };
		const result = isSchemaCompatible(producer, consumer);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/field "mode": producer const/);
	});

	it("does NOT flag matching const values", () => {
		const schema = { type: "object", properties: { mode: { const: "fast" } } };
		expect(isSchemaCompatible(schema, schema)).toEqual({ ok: true });
	});

	it("flags closed producer missing a consumer-required field", () => {
		const producer = { type: "object", additionalProperties: false, properties: { a: { type: "string" } } };
		const consumer = {
			type: "object",
			properties: { a: { type: "string" }, b: { type: "number" } },
			required: ["b"],
		};
		const result = isSchemaCompatible(producer, consumer);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/consumer requires "b" but producer \(closed object\) never emits it/);
	});

	it("does NOT flag open producer missing a consumer-required field (no false positive)", () => {
		const producer = { type: "object", properties: { a: { type: "string" } } };
		const consumer = {
			type: "object",
			properties: { a: { type: "string" }, b: { type: "number" } },
			required: ["b"],
		};
		expect(isSchemaCompatible(producer, consumer)).toEqual({ ok: true });
	});

	it("flags root type mismatch for non-object roots", () => {
		const result = isSchemaCompatible({ type: "string" }, { type: "number" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("root type mismatch");
		}

		const result2 = isSchemaCompatible({ type: "array" }, { type: "object" });
		expect(result2.ok).toBe(false);
		if (!result2.ok) {
			expect(result2.reason).toContain("root type mismatch");
		}
	});

	it("passes matching non-object root types", () => {
		expect(isSchemaCompatible({ type: "string" }, { type: "string" })).toEqual({ ok: true });
		expect(isSchemaCompatible({ type: "array" }, { type: "array" })).toEqual({ ok: true });
	});

	it("degrades to ok when one side lacks a root type", () => {
		expect(isSchemaCompatible({}, { type: "string" })).toEqual({ ok: true });
		expect(isSchemaCompatible({ type: "string" }, {})).toEqual({ ok: true });
	});

	it("returns ok:true when neither schema has properties", () => {
		expect(isSchemaCompatible({ type: "object" }, { type: "object" })).toEqual({ ok: true });
	});

	it("does NOT flag fields present in only one schema", () => {
		const producer = { type: "object", properties: { a: { type: "string" }, extra: { type: "boolean" } } };
		const consumer = { type: "object", properties: { a: { type: "string" }, other: { type: "number" } } };
		expect(isSchemaCompatible(producer, consumer)).toEqual({ ok: true });
	});

	it("does NOT flag nested-object differences (no deep compare)", () => {
		const producer = {
			type: "object",
			properties: { nested: { type: "object", properties: { x: { type: "string" } } } },
		};
		const consumer = {
			type: "object",
			properties: { nested: { type: "object", properties: { x: { type: "number" } } } },
		};
		expect(isSchemaCompatible(producer, consumer)).toEqual({ ok: true });
	});

	it("handles type: integer correctly as subtype of number", () => {
		const producer = { type: "object", properties: { v: { type: ["integer", "null"] } } };
		const consumer = { type: "object", properties: { v: { type: "number" } } };
		expect(isSchemaCompatible(producer, consumer)).toEqual({ ok: true });
	});
});
