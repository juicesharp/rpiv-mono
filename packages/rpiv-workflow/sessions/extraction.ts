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
import type { Artifact } from "../handle.js";
import { assertNever, formatError, nowIso, withTimeout } from "../internal-utils.js";
import { isJsonSchemaObject, jsonSchemaToStandard } from "../json-schema.js";
import { lifecycleCtxFromSession } from "../lifecycle.js";
import { ERR_COLLECTOR_THREW, ERR_PARSER_THREW, ERR_SCHEMA_TIMEOUT, MSG_VALIDATION_RETRY } from "../messages.js";
import { sideEffectOutcome } from "../outcomes/index.js";
import { finalizeOutput, type Output } from "../output.js";
import type { CollectCtx, Outcome } from "../output-spec.js";
import { type BranchEntry, readBranch } from "../transcript.js";
import type { StageSession, WorkflowHostContext } from "../types.js";
import {
	DEFAULT_VALIDATION_RETRIES,
	DEFAULT_VALIDATION_RETRY_TIMEOUT_MS,
	describeFailure,
	MAX_VALIDATION_RETRIES,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRIES,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
	type SchemaValidationFailure,
	type ValidationResult,
	validateOutputData,
} from "../validate-output.js";
import { handlerFor } from "./spawn.js";

export type OutputProduction =
	| { kind: "ok"; output: Output }
	| { kind: "fatal"; message: string }
	| { kind: "validation-exhausted"; failureSummary: string };

/** Retry loop re-produces against the latest branch after each fix request. */
export async function produceAndValidateOutput(
	ctx: WorkflowHostContext,
	s: StageSession,
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
				`runStage: stage "${skill}" has kind "produces" but no \`outcome\` — ` +
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
function buildCollectCtx(s: StageSession, branch: BranchEntry[], branchOffset: number | undefined): CollectCtx {
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

function wrapOutput(s: StageSession, parts: { kind: string; artifacts: readonly Artifact[]; data: unknown }): Output {
	return finalizeOutput(parts, {
		stage: s.stageName,
		skill: s.skill,
		// Pre-allocated by `produceAndValidateOutput` before any finalize runs —
		// no `lastAllocatedStageNumber + 1` peek, no temporal coupling with
		// recordStage.
		stageNumber: s.allocatedStageNumber!,
		ts: nowIso(),
		runId: s.runId,
	});
}

type RunOutcomeResult = { kind: "ok"; output: Output } | { kind: "fatal"; message: string };

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
	ctx: CollectCtx,
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
): { kind: "ok"; output: Output } | { kind: "fatal"; message: string } {
	if (stage.kind === "produces" && output.artifacts.length === 0) {
		return {
			kind: "fatal",
			message: `${skill} finished without producing any artifact (collector returned an empty list)`,
		};
	}
	return { kind: "ok", output };
}

/**
 * The schema output is validated against: the stage's own `outputSchema` if it
 * declares one, otherwise the dispatched skill's contract `produces.data`
 * (sourced from the declared/injected registry threaded onto the session).
 *
 * Degrades exactly like the input-side runtime mirror (`ensureContractInputValid`):
 * a non-object / unparseable `produces.data` is treated as absent (no schema),
 * never thrown. Returns `undefined` when neither source supplies a schema.
 */
function effectiveOutputSchema(s: StageSession): StageSchema | undefined {
	if (s.stage.outputSchema) return s.stage.outputSchema;
	// `s.skill` is resolved via `resolveSkill(def, stageName)` in `resolveStage`
	// (stage-lifecycle.ts), matching the contract map key used by
	// `validate-workflow.ts` and `harvestStageContracts`. The single helper
	// ensures load-time lint and runtime agree on which contract covers the stage.
	const producesData = s.skillContracts?.get(s.skill)?.produces?.data;
	if (!isJsonSchemaObject(producesData)) return undefined;
	return jsonSchemaToStandard(producesData);
}

function shouldValidateOutput(s: StageSession, output: Output): boolean {
	return !!(effectiveOutputSchema(s) && output.data !== undefined);
}

interface RetryDeps {
	outcome: Outcome;
	collectCtx: CollectCtx;
	finalize: (parts: { kind: string; artifacts: readonly Artifact[]; data: unknown }) => Output;
}

async function retryUntilValid(
	ctx: WorkflowHostContext,
	s: StageSession,
	deps: RetryDeps,
	initial: Output,
): Promise<OutputProduction> {
	const schema = effectiveOutputSchema(s)!;
	const maxRetries = Math.max(
		MIN_VALIDATION_RETRIES,
		Math.min(s.stage.maxRetries ?? DEFAULT_VALIDATION_RETRIES, MAX_VALIDATION_RETRIES),
	);
	const timeoutMs = Math.max(
		MIN_VALIDATION_RETRY_TIMEOUT_MS,
		Math.min(s.stage.validateTimeoutMs ?? DEFAULT_VALIDATION_RETRY_TIMEOUT_MS, MAX_VALIDATION_RETRY_TIMEOUT_MS),
	);

	let output = initial;
	const initialValidation = await validateOrFatal(schema, output.data, s.skill, timeoutMs);
	if (initialValidation.kind === "fatal") return initialValidation;
	let result = initialValidation.result;
	let attempts = 0;

	while (!result.valid && attempts < maxRetries && s.stage.onInvalid !== "halt") {
		attempts++;
		// onStageRetry fires before the agent is re-prompted; `attempt` is 1-based.
		// Ref shares the activation's ALLOCATOR number (currentStageRef) so
		// listeners can correlate this retry with the end/error event it
		// belongs to — graph position (`stageIndex + 1`) diverges past any loop.
		await s.lifecycle.fire(ctx, "onStageRetry", currentStageRef(s), attempts, lifecycleCtxFromSession(s));
		try {
			await askAgentToFix(ctx, s, attempts, result.failures, timeoutMs);
		} catch (e) {
			return { kind: "fatal", message: formatError(e) };
		}

		const retryBranch = readBranch(ctx);
		const retryCtx: CollectCtx = { ...deps.collectCtx, branch: retryBranch };
		const reRun = await runOutcome(deps.outcome, retryCtx, deps.finalize);
		if (reRun.kind === "fatal") return reRun;
		const contract = enforceCompletionContract(s.stage, s.skill, reRun.output);
		if (contract.kind === "fatal") return contract;

		output = contract.output;
		const reValidation = await validateOrFatal(schema, output.data, s.skill, timeoutMs);
		if (reValidation.kind === "fatal") return reValidation;
		result = reValidation.result;
	}

	if (!result.valid) return validationExhausted(result.failures);
	return { kind: "ok", output };
}

/**
 * Sent to the AGENT as a follow-up message when an output-schema validation
 * fails — instructs it to re-write the artifact at the same path with a
 * corrected frontmatter. Lives beside its only consumer (M8: this is
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
): Promise<{ kind: "ok"; result: ValidationResult } | { kind: "fatal"; message: string }> {
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
	ctx: WorkflowHostContext,
	s: StageSession,
	attempt: number,
	failures: SchemaValidationFailure[],
	timeoutMs: number,
): Promise<void> {
	ctx.ui.notify(MSG_VALIDATION_RETRY(s.skill, attempt), "warning");
	const errorLines = failures.map((f) => ` • ${describeFailure(f)}`).join("\n");
	await withTimeout(
		handlerFor(s.stage.sessionPolicy).send(ctx, MSG_VALIDATION_RETRY_PROMPT(s.skill, errorLines), s.continueHost),
		timeoutMs,
		`${s.skill}: validation retry attempt ${attempt} exceeded ${timeoutMs}ms — agent did not settle`,
	);
}

function validationExhausted(failures: SchemaValidationFailure[]): OutputProduction {
	const failureSummary = failures.map(describeFailure).join("; ");
	return { kind: "validation-exhausted", failureSummary };
}
