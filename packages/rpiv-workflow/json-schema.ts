/**
 * Raw-JSON-Schema ↔ Standard Schema bridge + introspection helpers.
 *
 * Makes schemas inspectable AS DATA, not just executable validators. Two
 * directions:
 *
 *   - `jsonSchemaToStandard(schema)` wraps a plain JSON-Schema-shaped object
 *     (a skill's frontmatter `consumes.data` / `produces.data`) into a Standard
 *     Schema v1 backed by TypeBox `Value.Check` — droppable into the same
 *     `~standard.validate` seam `validate-output.ts` consumes, AND carrying the
 *     spec `jsonSchema` Converter so the captured schema round-trips back out.
 *   - `hasJsonSchema(schema)` / `extractJsonSchema(schema, target?)` feature-detect
 *     and pull the JSON Schema off ANY `~standard` value (TypeBox- or raw-wrapped).
 *     The edge-compat checker uses them; opaque schemas (Zod/Valibot without
 *     the Converter) degrade to `undefined` and the caller skips + warns.
 *
 * No new dependency: `typebox@1.1.39` is keyword-driven, so `Value.Check`
 * validates a raw JSON Schema object with zero normalization.
 */

import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/** A JSON-Schema-shaped object — the canonical contract data format. */
export type JsonSchemaObject = Record<string, unknown>;

/**
 * Runtime guard that a value is a plain (non-null, non-array) object — the
 * minimum shape a JSON Schema must have. The framework treats INJECTED contracts
 * as untrusted: any caller that feeds a `consumes.data` / `produces.data` into
 * the keyword engine guards with this first, so a malformed contract (a string /
 * array / null where a schema was expected) DEGRADES instead of throwing into a
 * load or a run.
 */
export function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The intersection a `~standard` value carries when it exposes its JSON Schema
 * as data: the validate surface (`StandardSchemaV1`) PLUS the introspection
 * Converter (`StandardJSONSchemaV1`). `typeboxSchema` and `jsonSchemaToStandard`
 * both return this; third-party schemas (Zod/Valibot) satisfy only the former.
 */
export type JsonSchemaCapable<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output> &
	StandardJSONSchemaV1<Input, Output>;

/** Targets whose dialect our structural subset serialises to identically. */
const SUPPORTED_TARGETS = new Set<string>(["draft-2020-12", "draft-07"]);

/**
 * Build the spec-conformant `jsonSchema` Converter for a captured schema. The
 * captured value is already a clean JSON Schema (TypeBox v1 schemas have zero
 * symbol keys; frontmatter schemas are plain objects), so `input`/`output` both
 * return it — validation-only schemas have no input≠output transform. Supports
 * `draft-2020-12` + `draft-07` (the spec's strongly-recommended pair), identical
 * over our structural subset; other targets throw per the spec.
 */
export function jsonSchemaConverter(schema: JsonSchemaObject): StandardJSONSchemaV1.Converter {
	const convert = (options: StandardJSONSchemaV1.Options): JsonSchemaObject => {
		if (!SUPPORTED_TARGETS.has(options.target)) {
			throw new Error(
				`jsonSchema: unsupported target "${options.target}" (supported: ${[...SUPPORTED_TARGETS].join(", ")})`,
			);
		}
		return schema;
	};
	return { input: convert, output: convert };
}

/**
 * Shared `Value.Check` + `Value.Errors` → Standard Schema `Issue[]` mapping.
 * Both `jsonSchemaToStandard` and `typeboxSchema` (typebox-adapter.ts) call
 * this so validation failures are reported identically regardless of which
 * wrapper was used. Returns `{ value }` on success, `{ issues }` on failure.
 */
export function validateToJsonSchemaIssues(schema: TSchema | JsonSchemaObject, value: unknown) {
	if (Value.Check(schema, value)) return { value };
	const issues = [...Value.Errors(schema, value)].map((err) => ({
		message: err.message || `${err.keyword} validation failed at ${err.instancePath || "root"}`,
		path: err.instancePath ? err.instancePath.split("/").filter(Boolean) : undefined,
	}));
	return { issues };
}

/**
 * Wrap a raw JSON-Schema-shaped object into a Standard Schema v1 that BOTH
 * validates (via `Value.Check`) and exposes the schema as data (the Converter).
 * Delegates to the shared `validateToJsonSchemaIssues` helper so both this
 * wrapper and `typeboxSchema` report failures identically by construction.
 */
export function jsonSchemaToStandard(schema: JsonSchemaObject): JsonSchemaCapable {
	return {
		"~standard": {
			version: 1,
			vendor: "rpiv-json-schema",
			validate: (value: unknown) => validateToJsonSchemaIssues(schema, value),
			jsonSchema: jsonSchemaConverter(schema),
		},
	};
}

/**
 * True when a `~standard` value exposes its JSON Schema as data (carries the
 * `jsonSchema` Converter). TypeBox- and raw-wrapped schemas pass; Zod/Valibot/
 * ArkType schemas — which implement only `~standard.validate` — do not.
 */
export function hasJsonSchema(schema: StandardSchemaV1 | undefined): schema is JsonSchemaCapable {
	if (!schema) return false;
	const std = (schema as Partial<JsonSchemaCapable>)["~standard"] as Partial<StandardJSONSchemaV1.Props> | undefined;
	return typeof std?.jsonSchema?.output === "function";
}

/**
 * Pull the JSON Schema back off a `~standard` value as data, or `undefined`
 * when the schema is opaque (no Converter) or the Converter throws for the
 * requested target. The edge-compat checker calls this and skips + warns
 * on `undefined`. Defaults to `draft-2020-12` — the TypeBox-native dialect.
 */
export function extractJsonSchema(
	schema: StandardSchemaV1 | undefined,
	target: StandardJSONSchemaV1.Target = "draft-2020-12",
): JsonSchemaObject | undefined {
	if (!hasJsonSchema(schema)) return undefined;
	try {
		return schema["~standard"].jsonSchema.output({ target });
	} catch {
		return undefined;
	}
}
