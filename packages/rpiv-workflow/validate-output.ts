/**
 * Output-data validation against a `StageSchema` (Standard Schema v1 under
 * the hood). The schema-library boundary is `~standard.validate`; users may
 * bring Zod / Valibot / ArkType / TypeBox (wrapped via
 * `typebox-adapter.ts:typeboxSchema`).
 */

import type { StageSchema } from "./api.js";
import { extractJsonSchema, isJsonSchemaObject, type JsonSchemaObject } from "./json-schema.js";

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
	/**
	 * The actual offending value at `path`, resolved from the input data.
	 * `undefined` when the field is absent (e.g. a missing required property).
	 */
	value?: unknown;
	/**
	 * The values the schema permits at `path` (`enum`, or a single-element list
	 * for `const`), recovered from the JSON-Schema-as-data when the schema is
	 * introspectable. `undefined` for non-enum constraints or opaque schemas.
	 */
	allowed?: readonly unknown[];
}

export interface ValidationResult {
	valid: boolean;
	failures: SchemaValidationFailure[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The policy bounds live in the dependency-free `validation-bounds.ts` leaf so
// the load-time validator can read them without importing this runtime module;
// re-exported here so this module's runtime callers keep a single import.
export {
	DEFAULT_VALIDATION_RETRIES,
	DEFAULT_VALIDATION_RETRY_TIMEOUT_MS,
	MAX_VALIDATION_RETRIES,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRIES,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
} from "./validation-bounds.js";

/**
 * Thrown by `withTimeout` (internal-utils.ts) when the caller passes a
 * `SchemaTimeoutError` instance as the message. Lets validation consumers
 * distinguish a schema-evaluation timeout from inner-promise rejections via
 * `instanceof` instead of string-identity comparison. Lives in the validation
 * domain — it is part of the schema-validation contract, not a generic
 * timeout utility.
 */
export class SchemaTimeoutError extends Error {}

// ---------------------------------------------------------------------------
// Retry-policy loop
// ---------------------------------------------------------------------------

/**
 * Hooks for `runValidationRetryLoop`. `H` is the caller's halt payload — a
 * tagged value that aborts the loop immediately (extraction's fatal arm; the
 * script path's already-recorded failure marker). Throws are NOT caught:
 * they propagate to the caller's own catch posture (the runner's single
 * catch site for the script path; extraction wraps inside its hooks).
 */
export interface RetryLoopHooks<T, H> {
	/** Produce attempt `n` (0-based; 0 = the initial production). */
	produce(attempt: number): Promise<{ kind: "ok"; value: T } | { kind: "halt"; halt: H }>;
	/** Validate one produced value. */
	validate(value: T): Promise<{ kind: "ok"; result: ValidationResult } | { kind: "halt"; halt: H }>;
	/** Between a failed validation and the next produce. `attempt` is 1-based. */
	onRetry(attempt: number, failures: SchemaValidationFailure[]): Promise<{ kind: "ok" } | { kind: "halt"; halt: H }>;
}

export type RetryLoopOutcome<T, H> =
	| { kind: "ok"; value: T }
	| { kind: "exhausted"; failures: SchemaValidationFailure[] }
	| { kind: "halt"; halt: H };

/**
 * THE produce → validate → retry policy loop, shared by the skill path
 * (extraction.ts — re-prompts the agent between attempts) and the script
 * path (script-stage.ts — re-invokes the function). One structure: produce,
 * validate, and while invalid — stop on `haltOnInvalid` or a spent budget
 * (`"exhausted"`), otherwise fire the retry hook and go again. Total
 * productions are bounded by `maxRetries + 1`.
 */
export async function runValidationRetryLoop<T, H>(
	policy: { maxRetries: number; haltOnInvalid: boolean },
	hooks: RetryLoopHooks<T, H>,
): Promise<RetryLoopOutcome<T, H>> {
	let attempt = 0;
	let produced = await hooks.produce(attempt);
	if (produced.kind !== "ok") return { kind: "halt", halt: produced.halt };
	let validation = await hooks.validate(produced.value);
	if (validation.kind !== "ok") return { kind: "halt", halt: validation.halt };

	while (!validation.result.valid) {
		if (policy.haltOnInvalid || attempt >= policy.maxRetries) {
			return { kind: "exhausted", failures: validation.result.failures };
		}
		attempt++;
		const retried = await hooks.onRetry(attempt, validation.result.failures);
		if (retried.kind !== "ok") return { kind: "halt", halt: retried.halt };
		produced = await hooks.produce(attempt);
		if (produced.kind !== "ok") return { kind: "halt", halt: produced.halt };
		validation = await hooks.validate(produced.value);
		if (validation.kind !== "ok") return { kind: "halt", halt: validation.halt };
	}
	return { kind: "ok", value: produced.value };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Returns the schema's verdict on `data`. Standard Schema permits `validate`
 * to return synchronously or as a Promise; this function mirrors that —
 * callers must `await` the result. Both seams that drive validation
 * (`retryUntilValid` in extraction.ts and `ensureInputValid` in
 * run-stage.ts) are async, so awaiting a sync value is free (one
 * microtask) and async schemas (I/O-backed checks, async-by-default libs
 * like ArkType) round-trip without a sync-only escape hatch.
 */
export function validateOutputData(schema: StageSchema, data: unknown): ValidationResult | Promise<ValidationResult> {
	const result = schema["~standard"].validate(data);
	if (result instanceof Promise) {
		return result.then((resolved) => buildResult(resolved, data, schema));
	}
	return buildResult(result, data, schema);
}

function buildResult(
	result: {
		readonly issues?: readonly {
			readonly message: string;
			readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
		}[];
	},
	data: unknown,
	schema: StageSchema,
): ValidationResult {
	if (!result.issues) {
		return { valid: true, failures: [] };
	}
	// Recover the schema AS DATA once (validator-agnostic; `undefined` for opaque
	// schemas) so each failure can name the values it actually permits.
	const rootSchema = extractJsonSchema(schema);
	const failures: SchemaValidationFailure[] = result.issues.map((issue) => {
		const path = issue.path ? formatStandardPath(issue.path) : ".";
		const value = resolveInstanceValue(data, path);
		const node = rootSchema ? resolveSchemaNode(rootSchema, path) : undefined;
		const allowed = node ? allowedValues(node) : undefined;
		return {
			path,
			expected: node ? schemaKeyword(node) : "schema",
			actual: describeType(value),
			message: issue.message,
			value,
			...(allowed ? { allowed } : {}),
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
// Failure formatting
// ---------------------------------------------------------------------------

/**
 * Render a failure as one actionable line: the field, the constraint it
 * violated, and — when recoverable — the values the schema allows and the
 * value the data actually carried. Falls back to the raw validator message
 * when the schema is opaque (Zod/Valibot without a Converter) or the failure
 * isn't an enum/const mismatch.
 *
 *   status: must be one of "in-progress", "in-review", "ready" — got "done"
 *   phase_count: must be an integer — got "3"
 *   status: must have required property (field missing)
 */
export function describeFailure(f: SchemaValidationFailure): string {
	const field = f.path === "." ? "(root)" : f.path.replace(/^\//, "").replace(/\//g, ".");
	if (f.allowed && f.allowed.length > 0) {
		const allowed = f.allowed.map((v) => JSON.stringify(v)).join(", ");
		const got = f.value === undefined ? "(field missing)" : `got ${JSON.stringify(f.value)}`;
		return `${field}: must be one of ${allowed} — ${got}`;
	}
	// Non-enum failure: keep the validator's own message, append the offending
	// value only when it's a primitive (an object/array dump adds noise, and a
	// `required` failure resolves to the whole parent object).
	const got = isPrimitive(f.value) ? ` — got ${JSON.stringify(f.value)}` : "";
	return `${field}: ${f.message}${got}`;
}

function isPrimitive(value: unknown): boolean {
	return value === null || (typeof value !== "object" && typeof value !== "undefined" && typeof value !== "function");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk a JSON Schema by an instance path (`/status`, `/phases/0/n`) to the
 * sub-schema that governs the offending value. Handles the shapes a frontmatter
 * contract uses — object `properties` and array `items` (single-schema, not
 * tuple) — and degrades to `undefined` on `$ref`/`anyOf`/`allOf` or any segment
 * it can't follow, so an unrecoverable node simply yields no enum enrichment.
 */
function resolveSchemaNode(root: JsonSchemaObject, path: string): JsonSchemaObject | undefined {
	if (path === "." || path === "") return root;
	let node: JsonSchemaObject | undefined = root;
	for (const seg of path.split("/").filter(Boolean)) {
		if (!node) return undefined;
		const props: unknown = node.properties;
		if (isJsonSchemaObject(props) && isJsonSchemaObject(props[seg])) {
			node = props[seg];
			continue;
		}
		// Array index → the `items` schema (single-schema form only).
		if (/^\d+$/.test(seg) && isJsonSchemaObject(node.items)) {
			node = node.items;
			continue;
		}
		return undefined;
	}
	return node;
}

/** The values a schema node permits: its `enum`, or `[const]` for a const node. */
function allowedValues(node: JsonSchemaObject): readonly unknown[] | undefined {
	if (Array.isArray(node.enum)) return node.enum;
	if ("const" in node) return [node.const];
	return undefined;
}

/** A short keyword for the `expected` field — the node's `type`, or `enum`/`const`. */
function schemaKeyword(node: JsonSchemaObject): string {
	if (Array.isArray(node.enum)) return "enum";
	if ("const" in node) return "const";
	if (typeof node.type === "string") return node.type;
	if (Array.isArray(node.type)) return node.type.join("|");
	return "schema";
}

function describeType(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
