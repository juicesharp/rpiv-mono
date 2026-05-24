/**
 * Manifest validation against a `NodeSchema` (Standard Schema v1 under the
 * hood). Plus a walltime-cap helper for the agent-roundtrip retry loop. The
 * schema-library boundary is `~standard.validate`; users may bring Zod /
 * Valibot / ArkType / TypeBox (wrapped via `standard-schema.ts:typeboxSchema`).
 */

import type { NodeSchema } from "./api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationFailure {
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
	failures: ValidationFailure[];
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

/**
 * Race a promise against `ms`. The inner promise is NOT cancelled — Pi's
 * `ctx.waitForIdle()` has no abort signal today; the dangling promise becomes
 * inert when the next stage's `newSession` replaces the ctx.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateManifestData(schema: NodeSchema, data: unknown): ValidationResult {
	const result = schema["~standard"].validate(data);
	if (result instanceof Promise) {
		// Standard Schema permits async `validate`. Our retry-loop is synchronous
		// at this seam (the schema fires inside `extractAndValidateManifest`),
		// so async schemas would silently miss failures. Surface a clear error
		// rather than degrade to "always valid". If a user genuinely wants
		// async validation, the retry loop needs an awaitable refactor first.
		throw new Error("validateManifestData: async schema validation is not supported");
	}
	if (!result.issues) {
		return { valid: true, failures: [] };
	}
	const failures: ValidationFailure[] = result.issues.map((issue) => {
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

/** Asks the agent to update the frontmatter + re-write the artifact at the same path. */
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
