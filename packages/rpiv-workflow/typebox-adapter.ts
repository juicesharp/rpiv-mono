/**
 * Bridge between the TypeBox schemas the built-in workflows author with and
 * the Standard Schema v1 interface that `validate-output.ts` consumes.
 *
 * Why the bridge exists: `StageDef.outputSchema` / `inputSchema` are typed as
 * `StandardSchemaV1` so users can author with Zod, Valibot, ArkType, or any
 * other library that implements the `~standard` property. TypeBox v1.1.38
 * doesn't ship with `~standard` natively (as of this commit); when a future
 * version does, this adapter can be deleted and built-in.ts can pass
 * `Type.Object(...)` results directly.
 *
 * Validation surface kept intentionally tight: only the runtime + path
 * shape `validate-output.ts` needs. `expected`/`actual` diagnostic fields from
 * the legacy TypeBox failure shape become best-effort placeholders, since
 * Standard Schema's `issues` only carries `message` + `path`.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Static, TSchema } from "typebox";
import type { JsonSchemaCapable, JsonSchemaObject } from "./json-schema.js";
import { jsonSchemaConverter, validateToJsonSchemaIssues } from "./json-schema.js";

/**
 * Wrap a TypeBox schema to return a `JsonSchemaCapable` — a Standard Schema v1
 * that ALSO exposes its JSON Schema as data via the spec `jsonSchema` Converter.
 * Downstream code (`validateOutputData`) still consults `~standard.validate`;
 * the new Converter lets the edge-compat checker extract the schema as
 * data without needing to know the schema library.
 *
 * Generic over the input schema `S` so the parsed type (`Static<S>`) flows
 * through `JsonSchemaCapable<unknown, Static<S>>` and into the surrounding
 * `StageDef<TIn, TOut>` — predicate bodies + downstream stage consumers can
 * read `output.data` with the parsed type instead of `unknown`.
 */
export function typeboxSchema<S extends TSchema>(schema: S): JsonSchemaCapable<unknown, Static<S>> {
	return {
		"~standard": {
			version: 1,
			vendor: "typebox",
			validate: ((value: unknown) => validateToJsonSchemaIssues(schema, value)) as StandardSchemaV1<
				unknown,
				Static<S>
			>["~standard"]["validate"],
			// A TypeBox v1 schema is structurally a clean JSON Schema (zero symbol
			// keys, runtime-verified), so it doubles as the captured `jsonSchema` data.
			jsonSchema: jsonSchemaConverter(schema as unknown as JsonSchemaObject),
		},
	};
}
