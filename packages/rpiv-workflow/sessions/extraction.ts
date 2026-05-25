/**
 * Manifest extraction + validation retry loop. Sits between the
 * post-session classifier (which decides "stage finished cleanly?") and
 * the persistence helpers ("record this stage").
 *
 * Public entry: `extractAndValidateManifest`. Returns a tagged outcome
 * — `ok` with the manifest, `fatal` (halt with a wording the outcome
 * supplied), or `validation-exhausted` (halt after the retry budget
 * tripped without a passing schema).
 */

import type { NodeDef, NodeSchema } from "../api.js";
import { nowIso } from "../audit.js";
import { assertNever, withTimeout } from "../internal-utils.js";
import { type ExtractCtx, type ExtractPayload, finalizeManifest, type Manifest, type Outcome } from "../manifest.js";
import { MSG_VALIDATION_RETRY, MSG_VALIDATION_RETRY_PROMPT } from "../messages.js";
import { artifactMdOutcome, sideEffectOutcome } from "../outcomes/index.js";
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

export type ExtractionOutcome =
	| { kind: "ok"; manifest: Manifest | undefined }
	| { kind: "fatal"; message: string }
	| { kind: "validation-exhausted"; failureSummary: string };

/** Retry loop re-extracts against the latest branch after each fix request — `retryUntilValid` reads the branch directly. */
export async function extractAndValidateManifest(
	ctx: RunnerCtx,
	s: StageSession,
	branch: BranchEntry[],
	branchOffset: number | undefined,
): Promise<ExtractionOutcome> {
	const outcome = resolveOutcome(s.node);
	const extractCtx = buildExtractCtx(s, branch, branchOffset);
	const finalize = (payload: ExtractPayload) => wrapManifest(s, payload);

	const first = await runExtract(outcome, extractCtx, finalize);
	if (first.kind === "fatal") return first;
	if (!shouldValidateOutput(s.node, first.manifest)) return first;

	return retryUntilValid(ctx, s, { outcome, extractCtx, finalize }, first.manifest);
}

/** Explicit override > default-by-completionStrategy. Exhaustive — assertNever lights future variants. */
function resolveOutcome(node: NodeDef): Outcome {
	if (node.outcome) return node.outcome;
	switch (node.completionStrategy) {
		case "artifact-emit":
			return artifactMdOutcome;
		case "agent-end":
			return sideEffectOutcome;
		default:
			return assertNever(node.completionStrategy);
	}
}

/**
 * L6-05 contract: `branch` is always the FULL unsliced branch and
 * `branchOffset` is always the policy-derived offset (continue → the
 * stage's captured offset; fresh → undefined). Extractors slice on
 * demand via the `offsetStart` parameter on `extractArtifactPath`. The
 * initial extraction and the retry path use the same offset value — the
 * closed-I4 defect can't re-introduce.
 */
function buildExtractCtx(s: StageSession, branch: BranchEntry[], branchOffset: number | undefined): ExtractCtx {
	return {
		cwd: s.cwd,
		runId: s.runId,
		stageIndex: s.stageIndex,
		state: s.state,
		branch,
		branchOffset,
		baseline: s.baseline,
		skill: s.skill,
	};
}

function wrapManifest(s: StageSession, payload: ExtractPayload): Manifest {
	return finalizeManifest(payload, {
		skill: s.skill,
		stageNumber: s.state.lastAllocatedStageNumber + 1,
		ts: nowIso(),
		runId: s.runId,
	});
}

async function runExtract(
	outcome: Outcome,
	extractCtx: ExtractCtx,
	finalize: (p: ExtractPayload) => Manifest,
): Promise<{ kind: "ok"; manifest: Manifest | undefined } | { kind: "fatal"; message: string }> {
	const result = await outcome.extract(extractCtx);
	if (result.kind === "fatal") return result;
	return { kind: "ok", manifest: result.payload ? finalize(result.payload) : undefined };
}

function shouldValidateOutput(node: NodeDef, manifest: Manifest | undefined): manifest is Manifest {
	return !!(node.outputSchema && manifest?.data);
}

interface RetryDeps {
	outcome: Outcome;
	extractCtx: ExtractCtx;
	finalize: (p: ExtractPayload) => Manifest;
}

async function retryUntilValid(
	ctx: RunnerCtx,
	s: StageSession,
	deps: RetryDeps,
	initial: Manifest,
): Promise<ExtractionOutcome> {
	const schema = s.node.outputSchema!;
	// Defense-in-depth: validateWorkflow's checkNodeSemantics already errors
	// on out-of-range values and command.ts blocks execution on errors, so
	// the runtime should never see them. The lower clamps cover the path
	// where a caller programmatically embeds runWorkflow without going
	// through loadWorkflows. Without them, `maxValidationRetries: -1`
	// silently disables retries and a 100 ms timeout fires before the agent
	// emits its first token.
	const maxRetries = Math.max(
		MIN_VALIDATION_RETRIES,
		Math.min(s.node.maxValidationRetries ?? DEFAULT_VALIDATION_RETRIES, MAX_VALIDATION_RETRIES),
	);
	const timeoutMs = Math.max(
		MIN_VALIDATION_RETRY_TIMEOUT_MS,
		Math.min(s.node.validationRetryTimeoutMs ?? DEFAULT_VALIDATION_RETRY_TIMEOUT_MS, MAX_VALIDATION_RETRY_TIMEOUT_MS),
	);

	let manifest = initial;
	const initialValidation = validateOrFatal(schema, manifest.data, s.skill);
	if (initialValidation.kind === "fatal") return initialValidation;
	let result = initialValidation.result;
	let attempts = 0;

	while (!result.valid && attempts < maxRetries && s.node.onValidationFailure !== "halt") {
		attempts++;
		try {
			await askAgentToFix(ctx, s, attempts, result.failures, timeoutMs);
		} catch (e) {
			// askAgentToFix throws on walltime cap; surface as fatal so the
			// runner halts cleanly instead of the chain unwinding through
			// withSession with an unstructured error.
			const msg = e instanceof Error ? e.message : String(e);
			return { kind: "fatal", message: msg };
		}

		// Re-extract against the latest branch with the SAME offset the initial
		// extraction used (L6-05). `deps.extractCtx.branchOffset` was set
		// once at stage entry via the handler-derived offset, so spreading it
		// over a fresh `readBranch(ctx)` preserves the prior-stage prefix
		// skip and the closed-I4 defect can't re-introduce.
		const retryBranch = readBranch(ctx);
		const retryCtx: ExtractCtx = { ...deps.extractCtx, branch: retryBranch };
		const reExtracted = await runExtract(deps.outcome, retryCtx, deps.finalize);
		if (reExtracted.kind === "fatal") return reExtracted;
		if (!reExtracted.manifest) {
			return { kind: "fatal", message: `${s.skill}: outcome returned no manifest on retry ${attempts}` };
		}

		manifest = reExtracted.manifest;
		const reValidation = validateOrFatal(schema, manifest.data, s.skill);
		if (reValidation.kind === "fatal") return reValidation;
		result = reValidation.result;
	}

	if (!result.valid) return validationExhausted(result.failures);
	return { kind: "ok", manifest };
}

/**
 * Translate a thrown `validateManifestData` (the async-schema runtime check at
 * validate-manifest.ts:70 is the known thrower) into the canonical fatal-extraction
 * outcome. Without this, the throw escapes retryUntilValid → postStage →
 * runStageOrRecordFailure's catch, surfacing as MSG_STAGE_THREW — the wrong error
 * class for a schema-shape constraint the workflow author owns. Routing
 * through `kind: "fatal"` puts the failure through `haltStageWithExtractionError`,
 * which attributes the row to `skill`, fires MSG_STAGE_FAILED, and exits
 * cleanly through the same path validation-exhausted uses.
 *
 * The load-time `isAsyncSchema` probe in validate-workflow.ts is a best-effort UX hint;
 * this is the load-bearing safety net behind it.
 */
function validateOrFatal(
	schema: NodeSchema,
	data: unknown,
	skill: string,
): { kind: "ok"; result: ValidationResult } | { kind: "fatal"; message: string } {
	try {
		return { kind: "ok", result: validateManifestData(schema, data) };
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		return { kind: "fatal", message: `${skill}: ${reason}` };
	}
}

/**
 * Sends the fix request and races settlement against `timeoutMs`. waitForIdle
 * has no abort signal, so on timeout the underlying promise keeps draining in
 * the background; the next stage's `newSession` replaces the ctx and renders
 * it inert.
 */
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
		handlerFor(s.node.sessionPolicy).send(ctx, MSG_VALIDATION_RETRY_PROMPT(s.skill, errorLines), s.pi),
		timeoutMs,
		`${s.skill}: validation retry attempt ${attempt} exceeded ${timeoutMs}ms — agent did not settle`,
	);
}

function validationExhausted(failures: SchemaValidationFailure[]): ExtractionOutcome {
	const failureSummary = failures.map((f) => `${f.path}: ${f.message}`).join("; ");
	return { kind: "validation-exhausted", failureSummary };
}
