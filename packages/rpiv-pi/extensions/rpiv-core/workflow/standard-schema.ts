/**
 * Bridge between the TypeBox schemas the built-in workflows author with and
 * the Standard Schema v1 interface that `validation.ts` consumes.
 *
 * Why the bridge exists: `NodeDef.outputSchema` / `inputSchema` are typed as
 * `StandardSchemaV1` so users can author with Zod, Valibot, ArkType, or any
 * other library that implements the `~standard` property. TypeBox v1.1.38
 * doesn't ship with `~standard` natively (as of this commit); when a future
 * version does, this adapter can be deleted and built-in.ts can pass
 * `Type.Object(...)` results directly.
 *
 * Validation surface kept intentionally tight: only the runtime + path
 * shape `validation.ts` needs. `expected`/`actual` diagnostic fields from
 * the legacy TypeBox failure shape become best-effort placeholders, since
 * Standard Schema's `issues` only carries `message` + `path`.
 */

import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { NodeSchema } from "./api.js";

/**
 * Wrap a TypeBox schema to satisfy `NodeSchema` (Standard Schema v1). The
 * returned object is structurally a Standard Schema; downstream code
 * (`validateManifestData`) consults `~standard.validate` and never sees
 * the underlying TypeBox value.
 */
export function typeboxSchema(schema: TSchema): NodeSchema<unknown, unknown> {
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
