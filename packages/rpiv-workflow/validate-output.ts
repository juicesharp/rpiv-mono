/**
 * Output-data validation against a `StageSchema` (Standard Schema v1 under
 * the hood). The schema-library boundary is `~standard.validate`; users may
 * bring Zod / Valibot / ArkType / TypeBox (wrapped via
 * `typebox-adapter.ts:typeboxSchema`).
 */

import type { StageSchema } from "./api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchemaValidationFailure {
	/** JSON-pointer-like path (instancePath); `"."` for root. */
	path: string;
	/** Schema keyword that failed. */
	expected: string;
	/** typeof / "array" / "null" / "undefined" of the offending value. */
	actual: string;
	message: string;
}

export interface ValidationResult {
	valid: boolean;
	failures: SchemaValidationFailure[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_VALIDATION_RETRIES = 1;
export const MAX_VALIDATION_RETRIES = 3;
export const DEFAULT_VALIDATION_RETRIES = 1;

export const DEFAULT_VALIDATION_RETRY_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_VALIDATION_RETRY_TIMEOUT_MS = 30 * 60 * 1000;
export const MIN_VALIDATION_RETRY_TIMEOUT_MS = 1_000;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Returns the schema's verdict on `data`. Standard Schema permits `validate`
 * to return synchronously or as a Promise; this function mirrors that —
 * callers must `await` the result. Both seams that drive validation
 * (`retryUntilValid` in extraction.ts and `ensureInputValid` in
 * stage-lifecycle.ts) are async, so awaiting a sync value is free (one
 * microtask) and async schemas (I/O-backed checks, async-by-default libs
 * like ArkType) round-trip without a sync-only escape hatch.
 */
export function validateOutputData(schema: StageSchema, data: unknown): ValidationResult | Promise<ValidationResult> {
	const result = schema["~standard"].validate(data);
	if (result instanceof Promise) {
		return result.then((resolved) => buildResult(resolved, data));
	}
	return buildResult(result, data);
}

function buildResult(
	result: {
		readonly issues?: readonly {
			readonly message: string;
			readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
		}[];
	},
	data: unknown,
): ValidationResult {
	if (!result.issues) {
		return { valid: true, failures: [] };
	}
	const failures: SchemaValidationFailure[] = result.issues.map((issue) => {
		const path = issue.path ? formatStandardPath(issue.path) : ".";
		return {
			path,
			expected: "schema",
			actual: describeType(resolveInstanceValue(data, path)),
			message: issue.message,
		};
	});
	return { valid: false, failures };
}

/** `["foo", 0, "bar"]` → `/foo/0/bar`; empty path → `"."`. */
function formatStandardPath(path: readonly (PropertyKey | { readonly key: PropertyKey })[]): string {
	if (path.length === 0) return ".";
	const segs: string[] = [];
	for (const seg of path) {
		if (typeof seg === "object" && seg !== null && "key" in seg) {
			segs.push(String(seg.key));
		} else {
			segs.push(String(seg));
		}
	}
	return `/${segs.join("/")}`;
}

function resolveInstanceValue(data: unknown, instancePath: string): unknown {
	if (!instancePath || instancePath === "" || instancePath === ".") return data;
	const segments = instancePath.split("/").slice(1);
	let cur: unknown = data;
	for (const seg of segments) {
		if (cur === null || cur === undefined) return cur;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeType(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
