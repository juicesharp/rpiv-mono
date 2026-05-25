/**
 * Manifest production + validation retry loop. Sits between the
 * post-session classifier (which decides "stage finished cleanly?") and
 * the persistence helpers ("record this stage").
 *
 * Public entry: `produceAndValidateManifest`. Returns a tagged outcome
 * — `ok` with the manifest, `fatal` (halt with a wording the
 * resolver/reader supplied), or `validation-exhausted` (halt after the
 * retry budget tripped without a passing schema).
 *
 * The two-step contract:
 *   1. `outcome.collector.collect(ctx)` — enumerate artifacts.
 *   2. `outcome.parser?.parse(ctx)`     — shape the typed data channel
 *                                        (default: data = artifacts,
 *                                        kind = "artifacts").
 */

import type { StageDef, StageSchema } from "../api.js";
import { nowIso } from "../audit.js";
import type { Artifact } from "../handle.js";
import { assertNever, withTimeout } from "../internal-utils.js";
import { finalizeManifest, type Manifest } from "../manifest.js";
import { ERR_SCHEMA_TIMEOUT, MSG_VALIDATION_RETRY, MSG_VALIDATION_RETRY_PROMPT } from "../messages.js";
import type { CollectCtx, OutputSpec } from "../outcome-types.js";
import { sideEffectOutcome } from "../outcomes/index.js";
import { type BranchEntry, readBranch } from "../transcript.js";
import type { RunnerCtx, StageSession } from "../types.js";
import {
	DEFAULT_VALIDATION_RETRIES,
	DEFAULT_VALIDATION_RETRY_TIMEOUT_MS,
	MAX_VALIDATION_RETRIES,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRIES,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
	type SchemaValidationFailure,
	type ValidationResult,
	validateManifestData,
} from "../validate-manifest.js";
import { handlerFor } from "./spawn.js";

export type ManifestProduction =
	| { kind: "ok"; manifest: Manifest }
	| { kind: "fatal"; message: string }
	| { kind: "validation-exhausted"; failureSummary: string };

/** Retry loop re-produces against the latest branch after each fix request. */
export async function produceAndValidateManifest(
	ctx: RunnerCtx,
	s: StageSession,
	branch: BranchEntry[],
	branchOffset: number | undefined,
): Promise<ManifestProduction> {
	const outcome = resolveOutcome(s.stage, s.skill);
	const collectCtx = buildCollectCtx(s, branch, branchOffset);
	const finalize = (parts: { kind: string; artifacts: readonly Artifact[]; data: unknown }) => wrapManifest(s, parts);

	const first = await runOutcome(outcome, collectCtx, finalize);
	if (first.kind === "fatal") return first;
	const initialManifest = enforceCompletionContract(s.stage, s.skill, first.manifest);
	if (initialManifest.kind === "fatal") return initialManifest;

	if (!shouldValidateOutput(s.stage, initialManifest.manifest)) return initialManifest;

	return retryUntilValid(ctx, s, { outcome, collectCtx, finalize }, initialManifest.manifest);
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
function resolveOutcome(stage: StageDef, skill: string): OutputSpec {
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
 * L6-05 contract: `branch` is always the FULL unsliced branch and
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

function wrapManifest(
	s: StageSession,
	parts: { kind: string; artifacts: readonly Artifact[]; data: unknown },
): Manifest {
	return finalizeManifest(parts, {
		skill: s.skill,
		stageNumber: s.state.lastAllocatedStageNumber + 1,
		ts: nowIso(),
		runId: s.runId,
	});
}

type RunOutcomeResult = { kind: "ok"; manifest: Manifest } | { kind: "fatal"; message: string };

/**
 * The collector → parser pipeline. When `parser` is omitted, the
 * manifest emits `kind: "artifacts"` with `data = artifacts` — a stage
 * that only needs to enumerate doesn't have to write a parser.
 */
async function runOutcome(
	outcome: OutputSpec,
	ctx: CollectCtx,
	finalize: (parts: { kind: string; artifacts: readonly Artifact[]; data: unknown }) => Manifest,
): Promise<RunOutcomeResult> {
	const collected = await outcome.collector.collect(ctx);
	if (collected.kind === "fatal") return collected;

	if (!outcome.parser) {
		return {
			kind: "ok",
			manifest: finalize({ kind: "artifacts", artifacts: collected.artifacts, data: collected.artifacts }),
		};
	}

	const parsed = await outcome.parser.parse({ ...ctx, artifacts: collected.artifacts });
	if (parsed.kind === "fatal") return parsed;
	return {
		kind: "ok",
		manifest: finalize({
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
	manifest: Manifest,
): { kind: "ok"; manifest: Manifest } | { kind: "fatal"; message: string } {
	if (stage.kind === "produces" && manifest.artifacts.length === 0) {
		return {
			kind: "fatal",
			message: `${skill} finished without producing any artifact (collector returned an empty list)`,
		};
	}
	return { kind: "ok", manifest };
}

function shouldValidateOutput(stage: StageDef, manifest: Manifest): boolean {
	return !!(stage.outputSchema && manifest.data !== undefined);
}

interface RetryDeps {
	outcome: OutputSpec;
	collectCtx: CollectCtx;
	finalize: (parts: { kind: string; artifacts: readonly Artifact[]; data: unknown }) => Manifest;
}

async function retryUntilValid(
	ctx: RunnerCtx,
	s: StageSession,
	deps: RetryDeps,
	initial: Manifest,
): Promise<ManifestProduction> {
	const schema = s.stage.outputSchema!;
	const maxRetries = Math.max(
		MIN_VALIDATION_RETRIES,
		Math.min(s.stage.maxRetries ?? DEFAULT_VALIDATION_RETRIES, MAX_VALIDATION_RETRIES),
	);
	const timeoutMs = Math.max(
		MIN_VALIDATION_RETRY_TIMEOUT_MS,
		Math.min(s.stage.validateTimeoutMs ?? DEFAULT_VALIDATION_RETRY_TIMEOUT_MS, MAX_VALIDATION_RETRY_TIMEOUT_MS),
	);

	let manifest = initial;
	const initialValidation = await validateOrFatal(schema, manifest.data, s.skill, timeoutMs);
	if (initialValidation.kind === "fatal") return initialValidation;
	let result = initialValidation.result;
	let attempts = 0;

	while (!result.valid && attempts < maxRetries && s.stage.onInvalid !== "halt") {
		attempts++;
		try {
			await askAgentToFix(ctx, s, attempts, result.failures, timeoutMs);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { kind: "fatal", message: msg };
		}

		const retryBranch = readBranch(ctx);
		const retryCtx: CollectCtx = { ...deps.collectCtx, branch: retryBranch };
		const reRun = await runOutcome(deps.outcome, retryCtx, deps.finalize);
		if (reRun.kind === "fatal") return reRun;
		const contract = enforceCompletionContract(s.stage, s.skill, reRun.manifest);
		if (contract.kind === "fatal") return contract;

		manifest = contract.manifest;
		const reValidation = await validateOrFatal(schema, manifest.data, s.skill, timeoutMs);
		if (reValidation.kind === "fatal") return reValidation;
		result = reValidation.result;
	}

	if (!result.valid) return validationExhausted(result.failures);
	return { kind: "ok", manifest };
}

/**
 * Translate a thrown `validateManifestData` (user-authored schemas may throw
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
			Promise.resolve(validateManifestData(schema, data)),
			timeoutMs,
			ERR_SCHEMA_TIMEOUT("outputSchema", timeoutMs),
		);
		return { kind: "ok", result };
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		return { kind: "fatal", message: `${skill}: ${reason}` };
	}
}

async function askAgentToFix(
	ctx: RunnerCtx,
	s: StageSession,
	attempt: number,
	failures: SchemaValidationFailure[],
	timeoutMs: number,
): Promise<void> {
	ctx.ui.notify(MSG_VALIDATION_RETRY(s.skill, attempt), "warning");
	const errorLines = failures.map((f) => ` • ${f.path} — ${f.message}`).join("\n");
	await withTimeout(
		handlerFor(s.stage.sessionPolicy).send(ctx, MSG_VALIDATION_RETRY_PROMPT(s.skill, errorLines), s.host),
		timeoutMs,
		`${s.skill}: validation retry attempt ${attempt} exceeded ${timeoutMs}ms — agent did not settle`,
	);
}

function validationExhausted(failures: SchemaValidationFailure[]): ManifestProduction {
	const failureSummary = failures.map((f) => `${f.path}: ${f.message}`).join("; ");
	return { kind: "validation-exhausted", failureSummary };
}
