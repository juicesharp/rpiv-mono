/**
 * Output production + validation retry loop. Sits between the
 * post-session classifier (which decides "stage finished cleanly?") and
 * the persistence helpers ("record this stage").
 *
 * Public entry: `produceAndValidateOutput`. Returns a tagged outcome
 * — `ok` with the output, `fatal` (halt with a wording the
 * collector/parser supplied), or `validation-exhausted` (halt after the
 * retry budget tripped without a passing schema).
 *
 * The two-step contract:
 *   1. `outcome.collector.collect(ctx)` — enumerate artifacts.
 *   2. `outcome.parser?.parse(ctx)`     — shape the typed data channel
 *                                        (default: data = artifacts,
 *                                        kind = "artifacts").
 */

import type { StageDef, StageSchema } from "../api.js";
import { allocateStageNumber, currentStageRef } from "../audit.js";
import { lifecycleCtxFromSession } from "../events.js";
import type { Artifact } from "../handle.js";
import { assertNever, formatError, nowIso, withTimeout } from "../internal-utils.js";
import {
	ERR_COLLECTOR_THREW,
	ERR_PARSER_THREW,
	ERR_SCHEMA_TIMEOUT,
	ERR_VALIDATE_RETRY_UNCHANGED,
} from "../messages.js";
import { sideEffectOutcome } from "../outcomes/index.js";
import { finalizeOutput, type Output, outputMeta } from "../output.js";
import type { CollectContext, Outcome } from "../output-spec.js";
import { effectiveOutputSchemaOf } from "../stage-identity.js";
import { type BranchEntry, readBranch } from "../transcript.js";
import type { StageSessionContext, WorkflowSessionContext } from "../types.js";
import {
	DEFAULT_VALIDATION_RETRIES,
	DEFAULT_VALIDATION_RETRY_TIMEOUT_MS,
	describeFailure,
	MAX_VALIDATION_RETRIES,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRIES,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
	runValidationRetryLoop,
	type SchemaValidationFailure,
	type ValidationResult,
	validateOutputData,
} from "../validate-output.js";
import { clampRange } from "../validation-bounds.js";
import { resolveDigest } from "../worktree-digest.js";
import { resendIntoChild } from "./spawn.js";

/**
 * The fatal arm shared by every extraction-stage outcome — `{ kind: "fatal";
 * message }`. Declared four times inline before (OutputProduction,
 * RunOutcomeResult, enforceCompletionContract, validateOrFatal); the ok arms
 * genuinely differ (OutputProduction carries a validation-exhausted third arm;
 * validateOrFatal's ok payload is a ValidationResult under `result`, not an
 * Output under `output`), so a single generic `FatalOr<T>` would force a field
 * misnomer — the fatal arm is the part that's actually identical, so it's the
 * thing to name once.
 */
type Fatal = { kind: "fatal"; message: string };

export type OutputProduction =
	| { kind: "ok"; output: Output }
	| Fatal
	| { kind: "validation-exhausted"; failureSummary: string };

/** Retry loop re-produces against the latest branch after each fix request. */
export async function produceAndValidateOutput(
	ctx: WorkflowSessionContext,
	s: StageSessionContext,
	branch: BranchEntry[],
	branchOffset: number | undefined,
): Promise<OutputProduction> {
	// Allocate the activation's stage number ONCE, before any output envelope
	// is built — the envelope's `meta.stageNumber`, the eventual audit row
	// (success or failure), and every lifecycle ref share this value.
	s.allocatedStageNumber ??= allocateStageNumber(s.state);
	const outcome = resolveOutcome(s.stage, s.skill);
	const collectCtx = buildCollectCtx(s, branch, branchOffset);
	const finalize = (parts: { kind: string; artifacts: readonly Artifact[]; data: unknown }) => wrapOutput(s, parts);

	const first = await runOutcome(outcome, collectCtx, finalize);
	if (first.kind === "fatal") return first;
	const initialOutput = enforceCompletionContract(s.stage, s.skill, first.output);
	if (initialOutput.kind === "fatal") return initialOutput;

	if (!shouldValidateOutput(s, initialOutput.output)) return initialOutput;

	return retryUntilValid(ctx, s, { outcome, collectCtx, finalize }, initialOutput.output);
}

/**
 * Explicit `stage.outcome` wins. Defaults:
 *  - `side-effect` → `sideEffectOutcome` (universal — emits empty artifacts).
 *  - `produces`    → throws. There is no framework-wide default; the
 *    `.rpiv/artifacts/<bucket>/<file>.md` layout is an rpiv-pi convention
 *    and lives in that package. `validate-workflow.ts` rejects this at
 *    load time; the runtime throw is defense-in-depth for programmatic
 *    embedders that bypassed validation.
 */
function resolveOutcome(stage: StageDef, skill: string): Outcome {
	if (stage.outcome) return stage.outcome;
	switch (stage.kind) {
		case "side-effect":
			return sideEffectOutcome;
		case "produces":
			throw new Error(
				`dispatchStage: stage "${skill}" has kind "produces" but no \`outcome\` — ` +
					"there is no framework default for produces stages (the `.rpiv/artifacts/` layout is " +
					"an rpiv-pi convention). Either wire `outcome: rpivArtifactMdOutcome` (from @juicesharp/rpiv-pi) " +
					"or supply your own `{ collector, parser? }`.",
			);
		default:
			return assertNever(stage.kind);
	}
}

/**
 * Contract: `branch` is always the FULL unsliced branch and
 * `branchOffset` is always the policy-derived offset (continue → the
 * stage's captured offset; fresh → undefined). Collectors slice on
 * demand via the `branchOffset` field. Initial production and retry
 * production use the same offset value.
 */
function buildCollectCtx(
	s: StageSessionContext,
	branch: BranchEntry[],
	branchOffset: number | undefined,
): CollectContext {
	return {
		cwd: s.cwd,
		runId: s.runId,
		stageIndex: s.stageIndex,
		state: s.state,
		branch,
		branchOffset,
		snapshot: s.snapshot,
		skill: s.skill,
	};
}

function wrapOutput(
	s: StageSessionContext,
	parts: { kind: string; artifacts: readonly Artifact[]; data: unknown },
): Output {
	return finalizeOutput(
		parts,
		outputMeta({
			stage: s.stageName,
			skill: s.skill,
			// Pre-allocated by `produceAndValidateOutput` before any finalize runs —
			// no `lastAllocatedStageNumber + 1` peek, no temporal coupling with
			// recordStage.
			stageNumber: s.allocatedStageNumber!,
			ts: nowIso(),
			runId: s.runId,
		}),
	);
}

type RunOutcomeResult = { kind: "ok"; output: Output } | Fatal;

/**
 * The collector → parser pipeline. When `parser` is omitted, the
 * output emits `kind: "artifacts"` with `data = artifacts` — a stage
 * that only needs to enumerate doesn't have to write a parser.
 *
 * `collect`/`parse` are the PRIMARY user extension points, so a throw from
 * either is guarded here and attributed ("collector threw…"), folding into
 * the same fatal arm a tagged `{ kind: "fatal" }` return takes — instead of
 * escaping to the runner's generic catch and reading as a machinery failure.
 */
async function runOutcome(
	outcome: Outcome,
	ctx: CollectContext,
	finalize: (parts: { kind: string; artifacts: readonly Artifact[]; data: unknown }) => Output,
): Promise<RunOutcomeResult> {
	let collected: Awaited<ReturnType<typeof outcome.collector.collect>>;
	try {
		collected = await outcome.collector.collect(ctx);
	} catch (e) {
		return { kind: "fatal", message: ERR_COLLECTOR_THREW(ctx.skill, formatError(e)) };
	}
	if (collected.kind === "fatal") return collected;

	if (!outcome.parser) {
		return {
			kind: "ok",
			output: finalize({ kind: "artifacts", artifacts: collected.artifacts, data: collected.artifacts }),
		};
	}

	let parsed: Awaited<ReturnType<typeof outcome.parser.parse>>;
	try {
		parsed = await outcome.parser.parse({ ...ctx, artifacts: collected.artifacts });
	} catch (e) {
		return { kind: "fatal", message: ERR_PARSER_THREW(ctx.skill, formatError(e)) };
	}
	if (parsed.kind === "fatal") return parsed;
	return {
		kind: "ok",
		output: finalize({
			kind: parsed.payload.kind,
			artifacts: collected.artifacts,
			data: parsed.payload.data,
		}),
	};
}

/**
 * Contract check: `produces` stages MUST emit at least one
 * artifact. The collector/parser pair can succeed structurally
 * (kind: "ok") with zero artifacts — that's a chain halt for
 * `produces` (the stage promised an output and didn't deliver)
 * but a normal pass-through for `side-effect`.
 */
function enforceCompletionContract(
	stage: StageDef,
	skill: string,
	output: Output,
): { kind: "ok"; output: Output } | Fatal {
	if (stage.kind === "produces" && output.artifacts.length === 0) {
		return {
			kind: "fatal",
			message: `${skill} finished without producing any artifact (collector returned an empty list)`,
		};
	}
	return { kind: "ok", output };
}

function shouldValidateOutput(s: StageSessionContext, output: Output): boolean {
	return !!(effectiveOutputSchemaOf(s.stage, s.stageName, s.skillContracts) && output.data !== undefined);
}

export interface RetryDeps {
	outcome: Outcome;
	collectCtx: CollectContext;
	finalize: (parts: { kind: string; artifacts: readonly Artifact[]; data: unknown }) => Output;
}

/**
 * Validation-retry mechanism-1 gate: did the worktree stay byte-identical
 * between the failed validate and the post-fix re-read? An UNCHANGED digest
 * means the agent's fix touched nothing observable (tracked files OR
 * gitignored artifacts under `.rpiv/artifacts/`, both hashed by
 * `computeWorktreeDigest`), so the next `produce` → `validate` cycle would
 * re-run the same failing validation — fail fast instead of looping.
 *
 * An `undefined` baseline (non-repo / git missing — `resolveDigest` degrades
 * to `undefined`) ALWAYS proceeds: degrade on a missing signal, never skip.
 */
export const worktreeUnchangedSince = (baselineDigest: string | undefined, s: StageSessionContext): boolean =>
	baselineDigest !== undefined && resolveDigest(s.worktreeDigest, s.cwd) === baselineDigest;

/**
 * The retry-loop `produce` hook: re-production of the stage's output.
 *
 * `attempt === 0` is the fast-path — the initial output was already produced
 * and contract-checked before the retry loop opened (`produceAndValidateOutput`
 * ran `runOutcome` + `enforceCompletionContract` once), so it returns the
 * `initial` Output WITHOUT re-collection or re-checking the contract.
 *
 * `attempt > 0` re-reads the branch (the agent's fix landed as new messages),
 * re-runs the collector → parser pipeline (`runOutcome`), and re-checks the
 * completion contract. A fatal collector/parser/contract result maps onto
 * the engine's `{ kind: "aborted" }` arm (the loop halts with that message).
 */
export async function produceAttempt(
	ctx: WorkflowSessionContext,
	s: StageSessionContext,
	deps: RetryDeps,
	initial: Output,
	attempt: number,
): Promise<{ kind: "ok"; value: Output } | { kind: "aborted"; abort: Fatal }> {
	if (attempt === 0) return { kind: "ok", value: initial };
	const retryBranch = readBranch(ctx);
	const retryCtx: CollectContext = { ...deps.collectCtx, branch: retryBranch };
	const reRun = await runOutcome(deps.outcome, retryCtx, deps.finalize);
	if (reRun.kind === "fatal") return { kind: "aborted", abort: reRun };
	const contract = enforceCompletionContract(s.stage, s.skill, reRun.output);
	if (contract.kind === "fatal") return { kind: "aborted", abort: contract };
	return { kind: "ok", value: contract.output };
}

/**
 * The retry-loop `validate` hook: run the output schema against the produced
 * data, guarded by `timeoutMs` (the same `validateTimeoutMs` budget that
 * bounds `askAgentToFix`). Maps `validateOrFatal`'s `Fatal` outcome (a
 * thrown/rejected/timed-out schema) onto the engine's `{ kind: "aborted" }`
 * arm so a schema failure halts the loop instead of re-prompting the agent.
 */
export async function validateOutput(
	schema: StageSchema,
	skill: string,
	timeoutMs: number,
	output: Output,
): Promise<{ kind: "ok"; result: ValidationResult } | { kind: "aborted"; abort: Fatal }> {
	const validation = await validateOrFatal(schema, output.data, skill, timeoutMs);
	if (validation.kind === "fatal") return { kind: "aborted", abort: validation };
	return { kind: "ok", result: validation.result };
}

/**
 * The retry-loop `onRetry` hook: fired between a failed validate and the next
 * produce (`attempt` is 1-based). Sequence:
 *   1. Capture the worktree digest AT THE FAILED VALIDATE — nothing mutates
 *      the tree between `validate` failing and `onRetry` opening, so this
 *      equals the digest at the failure. Captured per-retry (NOT once before
 *      the loop): a later retry's "before" state is the tree AFTER the prior
 *      retry's fix, so a single pre-loop baseline would compare against a
 *      stale tree and false-abort every later retry.
 *   2. Fire `onStageRetry` before the agent is re-prompted (the ref shares the
 *      activation's allocator number via `currentStageRef` so listeners
 *      correlate retry ↔ end; graph position `stageIndex + 1` diverges past
 *      any loop).
 *   3. Re-prompt the agent (`askAgentToFix`); a throw becomes an abort.
 *   4. Gate on `worktreeUnchangedSince` — if the fix changed nothing
 *      observable, abort with the unchanged-worktree message instead of
 *      re-running the same failing validation.
 */
export async function handleRetry(
	ctx: WorkflowSessionContext,
	s: StageSessionContext,
	attempt: number,
	failures: SchemaValidationFailure[],
	timeoutMs: number,
): Promise<{ kind: "ok" } | { kind: "aborted"; abort: Fatal }> {
	const baselineDigest = resolveDigest(s.worktreeDigest, s.cwd);
	await s.lifecycle.fire(ctx, "onStageRetry", currentStageRef(s), attempt, lifecycleCtxFromSession(s));
	try {
		await askAgentToFix(ctx, s, attempt, failures, timeoutMs);
	} catch (e) {
		return { kind: "aborted", abort: { kind: "fatal", message: formatError(e) } };
	}
	if (worktreeUnchangedSince(baselineDigest, s)) {
		return {
			kind: "aborted",
			abort: { kind: "fatal", message: ERR_VALIDATE_RETRY_UNCHANGED(s.skill) },
		};
	}
	return { kind: "ok" };
}

async function retryUntilValid(
	ctx: WorkflowSessionContext,
	s: StageSessionContext,
	deps: RetryDeps,
	initial: Output,
): Promise<OutputProduction> {
	const schema = effectiveOutputSchemaOf(s.stage, s.stageName, s.skillContracts)!;
	const maxRetries = clampRange(
		s.stage.maxRetries,
		MIN_VALIDATION_RETRIES,
		DEFAULT_VALIDATION_RETRIES,
		MAX_VALIDATION_RETRIES,
	);
	const timeoutMs = clampRange(
		s.stage.validateTimeoutMs,
		MIN_VALIDATION_RETRY_TIMEOUT_MS,
		DEFAULT_VALIDATION_RETRY_TIMEOUT_MS,
		MAX_VALIDATION_RETRY_TIMEOUT_MS,
	);

	// The retry policy delegates to the SHARED `runValidationRetryLoop` engine
	// (validate-output.ts) — the same produce → validate → retry structure the
	// script path runs. The three hooks are short named delegations:
	//   - `produceAttempt` — `produce(0)` returns the already-produced `initial`;
	//     `produce(n>0)` re-reads the branch, re-runs the collector/parser, and
	//     re-checks the completion contract.
	//   - `validateOutput` — `validateOrFatal`, mapping its `Fatal` onto the
	//     engine's `{ kind: "aborted" }` abort arm.
	//   - `handleRetry` — `onStageRetry` + `askAgentToFix`; a throw becomes an
	//     abort, and the `worktreeUnchangedSince` gate aborts a no-op fix.
	// `failFast` mirrors the script path's stop-flag polarity —
	// `(onInvalid ?? "retry") === "halt"` is byte-identical to today's
	// `onInvalid !== "halt"` loop-continue condition, just expressed as the
	// engine's stop flag. Total productions stay bounded by `maxRetries + 1`.
	const outcome = await runValidationRetryLoop<Output, Fatal>(
		{ maxRetries, failFast: (s.stage.onInvalid ?? "retry") === "halt" },
		{
			produce: (attempt) => produceAttempt(ctx, s, deps, initial, attempt),
			validate: (output) => validateOutput(schema, s.skill, timeoutMs, output),
			onRetry: (attempt, failures) => handleRetry(ctx, s, attempt, failures, timeoutMs),
		},
	);

	if (outcome.kind === "aborted") return outcome.abort;
	if (outcome.kind === "exhausted") return validationExhausted(outcome.failures);
	return { kind: "ok", output: outcome.value };
}

/**
 * Sent to the AGENT as a follow-up message when an output-schema validation
 * fails — instructs it to re-write the artifact at the same path with a
 * corrected frontmatter. Lives beside its only consumer (this is
 * model-facing prompt text, not a UI constant). `errorLines` is a pre-joined
 * bullet list (one line per failure) so the factory stays single-arg-typed.
 */
const MSG_VALIDATION_RETRY_PROMPT = (skill: string, errorLines: string) =>
	`The ${skill} artifact's frontmatter doesn't satisfy the expected output schema. ` +
	"Fix only the fields listed below, then re-write the artifact at the same path (don't move it):\n\n" +
	`${errorLines}`;

/**
 * Translate a thrown `validateOutputData` (user-authored schemas may throw
 * synchronously or reject their Promise) into the canonical fatal-extraction
 * outcome. Async schemas are guarded by `timeoutMs` — the same
 * `validateTimeoutMs` budget that bounds the agent-settle step on a
 * retry.
 */
async function validateOrFatal(
	schema: StageSchema,
	data: unknown,
	skill: string,
	timeoutMs: number,
): Promise<{ kind: "ok"; result: ValidationResult } | Fatal> {
	try {
		const result = await withTimeout(
			Promise.resolve(validateOutputData(schema, data)),
			timeoutMs,
			ERR_SCHEMA_TIMEOUT("outputSchema", timeoutMs),
		);
		return { kind: "ok", result };
	} catch (e) {
		return { kind: "fatal", message: `${skill}: ${formatError(e)}` };
	}
}

async function askAgentToFix(
	ctx: WorkflowSessionContext,
	s: StageSessionContext,
	attempt: number,
	failures: SchemaValidationFailure[],
	timeoutMs: number,
): Promise<void> {
	const errorLines = failures.map((f) => ` • ${describeFailure(f)}`).join("\n");
	await withTimeout(
		resendIntoChild(ctx, MSG_VALIDATION_RETRY_PROMPT(s.skill, errorLines)),
		timeoutMs,
		`${s.skill}: validation retry attempt ${attempt} exceeded ${timeoutMs}ms — agent did not settle`,
	);
}

function validationExhausted(failures: SchemaValidationFailure[]): OutputProduction {
	const failureSummary = failures.map(describeFailure).join("; ");
	return { kind: "validation-exhausted", failureSummary };
}
