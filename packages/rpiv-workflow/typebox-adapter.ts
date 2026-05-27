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

import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { StageSchema } from "./api.js";

/**
 * Wrap a TypeBox schema to satisfy `StageSchema` (Standard Schema v1). The
 * returned object is structurally a Standard Schema; downstream code
 * (`validateOutputData`) consults `~standard.validate` and never sees
 * the underlying TypeBox value.
 *
 * Generic over the input schema `S` so the parsed type (`Static<S>`) flows
 * through `StageSchema<unknown, Static<S>>` and into the surrounding
 * `StageDef<TIn, TOut>` — predicate bodies + downstream stage consumers can
 * read `output.data` with the parsed type instead of `unknown`.
 */
export function typeboxSchema<S extends TSchema>(schema: S): StageSchema<unknown, Static<S>> {
	return {
		"~standard": {
			version: 1,
			vendor: "typebox",
			validate: (value: unknown) => {
				if (Value.Check(schema, value)) return { value };
				const issues = [...Value.Errors(schema, value)].map((err) => ({
					message: err.message || `${err.keyword} validation failed at ${err.instancePath || "root"}`,
					path: err.instancePath ? err.instancePath.split("/").filter(Boolean) : undefined,
				}));
				return { issues };
			},
		},
	};
}
