/**
 * Manifest validation — TypeBox Value.Check gate + Value.Errors adapter.
 *
 * Uses `Value.Errors` (from `typebox/value`) for schema-conformance diagnostics.
 * Value.Errors returns an array of `TLocalizedValidationError` records with
 * `keyword`, `schemaPath`, `instancePath`, `params`, and `message` fields.
 * We adapt these into our `ValidationFailure` shape for a stable internal API.
 *
 * We use Value.Errors (exhaustive) rather than hand-rolling a walker because:
 *   - Manifest validation is "does this object match this TypeBox schema"
 *   - Value.Errors covers every constraint (type, required, minimum, pattern,
 *     minLength, enum, const, etc.) without manual tracking of TypeBox internals.
 */

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single validation failure. */
export interface ValidationFailure {
	/** JSON-pointer-like path to the failing field (from instancePath). */
	path: string;
	/** What the schema expected (derived from keyword). */
	expected: string;
	/** What was actually found (type description). */
	actual: string;
	/** Human-readable description (from message or synthesized). */
	message: string;
}

/** Result of manifest data validation. */
export interface ValidationResult {
	valid: boolean;
	failures: ValidationFailure[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on retries regardless of node config. */
export const MAX_VALIDATION_RETRIES = 3;

/** Default retries when node doesn't specify. */
export const DEFAULT_VALIDATION_RETRIES = 1;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate manifest data against a TypeBox schema.
 *
 * Uses Value.Check as the boolean gate (fast path) and Value.Errors for
 * field-level diagnostics. Value.Errors returns an array of
 * TLocalizedValidationError records; we adapt each into our
 * `ValidationFailure` shape.
 */
export function validateManifestData(schema: TSchema, data: unknown): ValidationResult {
	if (Value.Check(schema, data)) {
		return { valid: true, failures: [] };
	}

	const errors = Value.Errors(schema, data);
	const failures: ValidationFailure[] = [];
	for (const err of errors) {
		failures.push({
			// instancePath is a JSON pointer like "/field" or "" for root.
			// Normalize: "" → ".".
			path: err.instancePath === "" ? "." : err.instancePath,
			// Use the keyword as a short "expected" label.
			expected: err.keyword,
			// Describe the offending value (per-field), not the root data.
			actual: describeType((err as { value?: unknown }).value ?? resolveInstanceValue(data, err.instancePath)),
			// Use the localized message if available, otherwise synthesize.
			message: err.message || `${err.keyword} validation failed at ${err.instancePath || "root"}`,
		});
	}
	return { valid: false, failures };
}

/** Walk a JSON pointer (e.g. "/foo/bar/0") into `data`, returning the leaf value. */
function resolveInstanceValue(data: unknown, instancePath: string): unknown {
	if (!instancePath || instancePath === "") return data;
	const segments = instancePath.split("/").slice(1);
	let cur: unknown = data;
	for (const seg of segments) {
		if (cur === null || cur === undefined) return cur;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}

/**
 * Format validation failures into an agent-readable error message.
 *
 * Tells the agent what went wrong and asks it to fix the frontmatter
 * and re-write the artifact at the same path.
 */
export function formatValidationFailuresForAgent(skill: string, failures: ValidationFailure[]): string {
	const errorLines = failures.map((f) => ` • ${f.path} — ${f.message}`).join("\n");

	return (
		`The artifact you produced for ${skill} doesn't satisfy the expected output schema. ` +
		"Please update the frontmatter and re-write the artifact at the same path.\n\n" +
		`Errors:\n${errorLines}`
	);
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
