/**
 * Input-validation preflights for the runner's per-stage pipeline.
 *
 * Two validators run after prompt prep in the single-stage pipeline
 * (`runSingleStage`, run-stage.ts):
 *   - `ensureInputValid` — validates upstream output against the stage's
 *     declared `inputSchema`.
 *   - `ensureContractInputValid` — validates upstream output against the
 *     skill contract's `consumes.data` schema (the gap `ensureInputValid`
 *     leaves when the stage has no `inputSchema`).
 *
 * Both share a common validate-and-throw pipeline, factored into
 * `validateOrThrow`. The difference is error policy: `ensureInputValid`
 * halts on any validation error; `ensureContractInputValid` degrades
 * (returns) when the contract schema itself throws (author defect),
 * halting only on timeouts.
 */

import { formatError, withTimeout } from "../internal-utils.js";
import { isJsonSchemaObject, jsonSchemaToStandard } from "../json-schema.js";
import { ERR_SCHEMA_TIMEOUT, FAIL_INPUT_VALIDATION } from "../messages.js";
import type { RunContext } from "../types.js";
import {
	DEFAULT_VALIDATION_RETRY_TIMEOUT_MS,
	describeFailure,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
	SchemaTimeoutError,
	type ValidationResult,
	validateOutputData,
} from "../validate-output.js";
import { clampRange } from "../validation-bounds.js";
import { StagePreflightError } from "./errors.js";
import type { ResolvedStage } from "./resolve-stage.js";

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

/**
 * Error policy for `validateOrThrow`:
 *   - `"halt-on-any"` — any validation error or throw halts the stage.
 *     Used by `ensureInputValid` (stage-owned schemas are trusted).
 *   - `"degrade-on-non-timeout"` — timeout halts the stage; other throws
 *     degrade (return). Used by `ensureContractInputValid` (contract schemas
 *     are consumer-authored and may contain unsupported keywords).
 */
type ErrorPolicy = "halt-on-any" | "degrade-on-non-timeout";

/**
 * Shared core of both input validators: validate `data` against `schema`
 * within `timeoutMs`, throwing `StagePreflightError` on failure.
 *
 * The `errorPolicy` parameter controls the catch-path behaviour:
 *   - `"halt-on-any"`: `withTimeout` receives a string error message.
 *     Any catch → `StagePreflightError` (halt).
 *   - `"degrade-on-non-timeout"`: `withTimeout` receives a
 *     `SchemaTimeoutError` instance. On catch, only a timeout is re-thrown
 *     as `StagePreflightError`; other errors (contract schema evaluation
 *     failures) cause a silent return (degrade), so an unparseable contract
 *     doesn't kill a legitimate run.
 */
async function validateOrThrow(
	schema: Parameters<typeof validateOutputData>[0],
	data: unknown,
	stage: ResolvedStage,
	prevSkill: string,
	timeoutMs: number,
	errorPolicy: ErrorPolicy,
): Promise<void> {
	const timeoutError =
		errorPolicy === "degrade-on-non-timeout"
			? new SchemaTimeoutError(ERR_SCHEMA_TIMEOUT("inputSchema", timeoutMs))
			: ERR_SCHEMA_TIMEOUT("inputSchema", timeoutMs);

	let result: ValidationResult;
	try {
		result = await withTimeout(Promise.resolve(validateOutputData(schema, data)), timeoutMs, timeoutError);
	} catch (e) {
		if (errorPolicy === "degrade-on-non-timeout" && !(e instanceof SchemaTimeoutError)) return;
		const f = FAIL_INPUT_VALIDATION(stage.skill, prevSkill, formatError(e));
		throw new StagePreflightError("halt", stage.skill, f.toast, f.error, true);
	}

	if (result.valid) return;

	const f = FAIL_INPUT_VALIDATION(stage.skill, prevSkill, result.failures.map(describeFailure).join("; "));
	throw new StagePreflightError("halt", stage.skill, f.toast, f.error, true);
}

// ---------------------------------------------------------------------------
// Timeout clamp
// ---------------------------------------------------------------------------

/**
 * Clamp `validateTimeoutMs` to the allowed range. Mirror of the clamp in
 * `extraction.ts:retryUntilValid`. Same defense-in-depth posture:
 * `validateWorkflow` rejects out-of-range values at load, but programmatic
 * callers that embed `runWorkflow` can bypass it; clamping here means a
 * misconfigured stage degrades to the spec-default behavior instead of
 * firing a 100 ms timeout before a real I/O probe gets a chance to settle.
 */
function clampValidateTimeoutMs(raw: number | undefined): number {
	return clampRange(
		raw,
		MIN_VALIDATION_RETRY_TIMEOUT_MS,
		DEFAULT_VALIDATION_RETRY_TIMEOUT_MS,
		MAX_VALIDATION_RETRY_TIMEOUT_MS,
	);
}

// ---------------------------------------------------------------------------
// Public validators
// ---------------------------------------------------------------------------

/**
 * Validate upstream output against the stage's declared `inputSchema`.
 * Runs as a `POST_PROMPT_CHECK` in the skill pipeline and directly before
 * `runScript` in the script-stage shortcut.
 *
 * Any validation failure or async schema error → `StagePreflightError`
 * (halt-class). The stage author owns `inputSchema`; if it throws, that's
 * a runtime bug worth halting for.
 */
export async function ensureInputValid(stage: ResolvedStage, run: RunContext): Promise<void> {
	if (!stage.def.inputSchema || run.state.output?.data === undefined) return;
	const timeoutMs = clampValidateTimeoutMs(stage.def.validateTimeoutMs);
	const prevSkill = run.state.output.meta.stage || "unknown";
	await validateOrThrow(stage.def.inputSchema, run.state.output.data, stage, prevSkill, timeoutMs, "halt-on-any");
}

/**
 * Runtime mirror of `checkEdgeSchemaCompat` for the LINEAR `data` channel.
 * When the consumer declares `consumes.data` but the stage has no
 * `inputSchema`, validate upstream `output.data` against the contract
 * schema — the gap `ensureInputValid` leaves. A clean failure HALTS
 * (load-time only warns, being schema-vs-schema). Degrades (returns)
 * when `consumes.data` is not a plain-object schema or the keyword engine
 * throws (author defect), and when there's no registry / contract /
 * `consumes.data`, an `inputSchema`, a raw `prompt`, or upstream data.
 *
 * NAMED-channel (`reads:`) validity is a complete LOAD-TIME guarantee
 * (`checkReadsChannelCompat`), not checked here — a `reads:` stage consumes
 * from `state.named`, never the rolling primary, so it returns early
 * (mirroring the `ensureUpstreamArtifact` reads guard) rather than validating
 * the unrelated primary `output.data` against its `consumes.data`.
 */
export async function ensureContractInputValid(stage: ResolvedStage, run: RunContext): Promise<void> {
	if (stage.def.prompt !== undefined) return;
	if (stage.def.inputSchema) return; // ensureInputValid owns the stage-schema path
	// A `reads:` stage's input comes from `state.named`, not the rolling primary
	// `output.data` — adjudicating that primary against this stage's `consumes.data`
	// would check the wrong source. Named-channel compat is load-time-only
	// (`checkReadsChannelCompat`); mirror `ensureUpstreamArtifact`'s reads guard.
	if (stage.def.reads?.length) return;
	const contract = run.skillContracts?.get(stage.skill);

	if (run.state.output?.data === undefined) return;
	const consumesData = contract?.consumes?.data;
	// Untrusted injected contract — degrade (never HALT) on a non-object schema.
	if (!isJsonSchemaObject(consumesData)) return;
	const schema = jsonSchemaToStandard(consumesData);
	const timeoutMs = clampValidateTimeoutMs(stage.def.validateTimeoutMs);
	const prevSkill = run.state.output.meta.stage || "unknown";
	await validateOrThrow(schema, run.state.output.data, stage, prevSkill, timeoutMs, "degrade-on-non-timeout");
}
