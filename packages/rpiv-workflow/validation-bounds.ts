/**
 * Output-validation policy bounds — the retry-count and per-attempt timeout
 * clamps shared by the RUNTIME retry loop (`validate-output.ts`,
 * `sessions/extraction.ts`, `runner/input-validation.ts`) and the LOAD-TIME
 * stage-rule validator (`validate/stage-rules.ts`).
 *
 * A dependency-free LEAF (zero imports) so `validate/` can read the bounds
 * WITHOUT importing `validate-output.ts`, which also houses the runtime
 * `runValidationRetryLoop` engine — a definition-context module should not pull
 * a runtime control loop onto its dependency graph just to read six numbers.
 * `validate-output.ts` re-exports these so its runtime callers keep one import.
 */

export const MIN_VALIDATION_RETRIES = 1;
export const MAX_VALIDATION_RETRIES = 3;
export const DEFAULT_VALIDATION_RETRIES = 1;

export const DEFAULT_VALIDATION_RETRY_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_VALIDATION_RETRY_TIMEOUT_MS = 30 * 60 * 1000;
export const MIN_VALIDATION_RETRY_TIMEOUT_MS = 1_000;

/**
 * Clamp `raw` to `[min, max]`, defaulting to `def` when `raw` is `undefined`.
 * The ONE runtime-clamp idiom shared by the runtime retry loop
 * (`sessions/extraction.ts:retryUntilValid` — retries + timeout) and the input
 * preflight (`runner/input-validation.ts:clampValidateTimeoutMs` — timeout).
 * Same defense-in-depth posture as the load-time `checkRange`: `validateWorkflow`
 * rejects out-of-range values at load, but programmatic callers that embed
 * `runWorkflow` can bypass it; clamping here means a misconfigured stage degrades
 * to the spec-default behavior instead of firing a 100ms timeout before a real
 * I/O probe gets a chance to settle.
 */
export function clampRange(raw: number | undefined, min: number, def: number, max: number): number {
	return Math.max(min, Math.min(raw ?? def, max));
}
