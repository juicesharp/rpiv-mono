/**
 * Session execution — one Pi session per workflow stage / phase.
 * `runStageSession` and `runPhaseSession` are the two public entries.
 *
 * The fresh-vs-continue policy split is owned by `SessionPolicyHandler`:
 * `FRESH_HANDLER` and `CONTINUE_HANDLER` implement the three
 * policy-specific decisions (branch offset for extraction, spawn shape,
 * send-into-existing-session). Everything else — stop classification,
 * extraction, validation, JSONL, chain advance — is policy-agnostic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NodeDef, NodeSchema, SessionPolicy } from "./api.js";
import {
	type AuditCtx,
	nowIso,
	phaseRowLabel,
	recordCancellation,
	recordStage,
	recordStopFailure,
	recordTerminalFailure,
} from "./audit.js";
import { artifactMdExtractor, sideEffectExtractor } from "./extractors/index.js";
import { assertNever, withTimeout } from "./internal-utils.js";
import {
	type Extractor,
	type ExtractorCtx,
	type ExtractorPayload,
	finalizeManifest,
	type Manifest,
} from "./manifest.js";
import {
	ERR_AUDIT_WRITE_FAILED,
	ERR_VALIDATION_FAILED,
	MSG_AUDIT_WRITE_FAILED,
	MSG_STAGE_COMPLETE,
	MSG_STAGE_FAILED,
	MSG_VALIDATION_EXHAUSTED,
	MSG_VALIDATION_RETRY,
	MSG_VALIDATION_RETRY_PROMPT,
} from "./messages.js";
import { type BranchEntry, classifyStop, extractArtifactPath, readBranch, type StopSignal } from "./transcript.js";
import type { PhaseSession, RunnerCtx, SessionContext, StageSession } from "./types.js";
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
} from "./validate-manifest.js";

// ===========================================================================
// PUBLIC ENTRIES — what the orchestrator calls
// ===========================================================================

/** Execute one DAG stage in its own session. */
export async function runStageSession(ctx: RunnerCtx, s: StageSession): Promise<void> {
	const handler = handlerFor(s.node.sessionPolicy);
	const { cancelled } = await handler.spawn(ctx, s.prompt, (sessionCtx) => postStage(sessionCtx, s), s.pi);
	if (cancelled) recordCancellation(ctx, auditFor(s));
}

/** Execute one phase iteration of an implement stage. Always fresh. */
export async function runPhaseSession(ctx: RunnerCtx, s: PhaseSession): Promise<void> {
	const { cancelled } = await FRESH_HANDLER.spawn(ctx, s.prompt, (sessionCtx) => postPhase(sessionCtx, s));
	if (cancelled) recordCancellation(ctx, auditFor(s));
}

// ===========================================================================
// POST-PROCESSING — runs after the agent loop settles
// ===========================================================================

/** Stage post-processing: classify outcome → extract & validate → persist → chain. */
async function postStage(ctx: RunnerCtx, s: StageSession): Promise<void> {
	const handler = handlerFor(s.node.sessionPolicy);
	const offset = handler.branchOffset(s.branchOffset);
	const outcome = readSessionOutcome(ctx, offset);
	if (outcome.stop !== "stop") return haltStage(ctx, s, outcome.stop);

	const result = await extractAndValidateManifest(ctx, s, outcome.branch, offset);
	if (result.kind === "fatal") return haltStageWithExtractionError(ctx, s, result.message);
	if (result.kind === "validation-exhausted") return haltStageWithValidationFailure(ctx, s, result.failureSummary);

	if (!recordStageSuccess(ctx, s, outcome.artifact, result.manifest)) return;
	await s.onSuccess(ctx, outcome.artifact);
}

/** Phase post-processing: classify outcome → persist bare row → chain. */
async function postPhase(ctx: RunnerCtx, s: PhaseSession): Promise<void> {
	const outcome = readSessionOutcome(ctx, undefined);
	if (outcome.stop !== "stop") return haltPhase(ctx, s, outcome.stop);

	if (!recordPhaseSuccess(s, outcome.artifact)) return;
	await s.onSuccess(ctx);
}

// ===========================================================================
// MANIFEST EXTRACTION + VALIDATION
// ===========================================================================

type ExtractionOutcome =
	| { kind: "ok"; manifest: Manifest | undefined }
	| { kind: "fatal"; message: string }
	| { kind: "validation-exhausted"; failureSummary: string };

/** Retry loop re-extracts against the latest branch after each fix request — `retryUntilValid` reads the branch directly. */
async function extractAndValidateManifest(
	ctx: RunnerCtx,
	s: StageSession,
	branch: BranchEntry[],
	branchOffset: number | undefined,
): Promise<ExtractionOutcome> {
	const extractor = resolveExtractor(s.node);
	const extractorCtx = buildExtractorCtx(s, branch, branchOffset);
	const finalize = (payload: ExtractorPayload) => wrapManifest(s, payload);

	const first = await runExtractor(extractor, extractorCtx, finalize);
	if (first.kind === "fatal") return first;
	if (!shouldValidateOutput(s.node, first.manifest)) return first;

	return retryUntilValid(ctx, s, { extractor, extractorCtx, finalize }, first.manifest);
}

// ===========================================================================
// HALT HELPERS — turn a halt reason into the right audit-layer call
// ===========================================================================

function haltStage(ctx: RunnerCtx, s: StageSession, stop: Exclude<StopSignal, "stop">): void {
	recordStopFailure(ctx, auditFor(s), stop, `${s.skill} failed`, s.onFailure);
}

function haltStageWithExtractionError(ctx: RunnerCtx, s: StageSession, message: string): void {
	recordTerminalFailure(
		ctx,
		auditFor(s),
		{ status: "failed", notifyMsg: MSG_STAGE_FAILED(s.skill), notifyLevel: "error", errMsg: message },
		s.onFailure,
	);
}

function haltStageWithValidationFailure(ctx: RunnerCtx, s: StageSession, failureSummary: string): void {
	recordTerminalFailure(
		ctx,
		auditFor(s),
		{
			status: "failed",
			notifyMsg: MSG_VALIDATION_EXHAUSTED(s.skill),
			notifyLevel: "error",
			errMsg: ERR_VALIDATION_FAILED(s.skill, failureSummary),
		},
		s.onFailure,
	);
}

function haltPhase(ctx: RunnerCtx, s: PhaseSession, stop: Exclude<StopSignal, "stop">): void {
	recordStopFailure(ctx, auditFor(s), stop, `${s.skill} phase ${s.phaseIndex} failed`);
}

// ===========================================================================
// SUCCESS-PERSISTENCE HELPERS
// ===========================================================================

/**
 * Write + counter-increment guard shared by `recordStageSuccess` and
 * `recordPhaseSuccess`. Returns `true` iff the JSONL row landed. Manifest
 * assignment lives here so both callers get the same "manifest is set iff
 * the row that carried it landed" invariant. Caller-specific bits (notify,
 * `state.termination.error`, `state.fallbackArtifactPath`) stay outside.
 */
function tryRecordStage(s: SessionContext, label: string, args: { artifact?: string; manifest?: Manifest }): boolean {
	const assigned = recordStage(
		s.cwd,
		s.runId,
		{
			skill: label,
			artifact: args.artifact,
			status: "completed",
			ts: nowIso(),
			manifest: args.manifest,
		},
		s.state,
	);
	if (assigned === undefined) return false;
	if (args.manifest) s.state.manifest = args.manifest;
	s.state.stagesCompleted++;
	return true;
}

/**
 * Returns true on successful write — caller gates `onSuccess` on this so the
 * chain advances only when the audit row landed. On failure, leaves
 * `state.manifest` / `state.fallbackArtifactPath` at their prior values (the
 * disk has no row for what just completed, so the in-memory pointers must not
 * advance past it) and sets `state.termination.error` to halt the run.
 */
function recordStageSuccess(
	ctx: RunnerCtx,
	s: StageSession,
	artifact: string | undefined,
	manifest: Manifest | undefined,
): boolean {
	if (!tryRecordStage(s, s.skill, { artifact, manifest })) {
		ctx.ui.notify(MSG_AUDIT_WRITE_FAILED(s.skill), "error");
		s.state.termination.error = ERR_AUDIT_WRITE_FAILED(s.skill);
		return false;
	}
	// Fallback path carries the bare transcript artifact when the manifest
	// doesn't supply its own — currentArtifactPath prefers the manifest
	// field and falls through to fallback otherwise.
	if (!manifest?.artifact_path && artifact) s.state.fallbackArtifactPath = artifact;
	ctx.ui.notify(MSG_STAGE_COMPLETE(s.skill), "info");
	return true;
}

/** Phase rows never notify — parent stage holds MSG_STAGE_COMPLETE until all phases finish. */
function recordPhaseSuccess(s: PhaseSession, artifact: string | undefined): boolean {
	if (!tryRecordStage(s, phaseRowLabel(s), { artifact })) {
		s.state.termination.error = ERR_AUDIT_WRITE_FAILED(phaseRowLabel(s));
		return false;
	}
	// Phases never carry manifests — write goes through the fallback slot,
	// which currentArtifactPath surfaces when no manifest is on hand.
	if (artifact) s.state.fallbackArtifactPath = artifact;
	return true;
}

// ===========================================================================
// BRANCH INSPECTION — read how the agent stopped
// ===========================================================================

interface SessionOutcome {
	branch: BranchEntry[];
	artifact: string | undefined;
	stop: StopSignal;
}

/**
 * Always reads the full unsliced branch + applies the policy-derived
 * `branchOffset` to the helpers that need it. The slice is no longer
 * materialised — `classifyStop` and `extractArtifactPath` both accept an
 * `offsetStart` so they skip the prior-stage prefix in place. Same offset
 * value flows through to the extractor (L6-05: initial == retry).
 */
function readSessionOutcome(ctx: RunnerCtx, branchOffset: number | undefined): SessionOutcome {
	const branch = readBranch(ctx);
	return {
		branch,
		artifact: extractArtifactPath(branch, branchOffset),
		stop: classifyStop(branch, branchOffset),
	};
}

// ===========================================================================
// EXTRACTION INTERNALS
// ===========================================================================

/** Explicit override > default-by-completionStrategy. Exhaustive — assertNever lights future variants. */
function resolveExtractor(node: NodeDef): Extractor {
	if (node.extractor) return node.extractor;
	switch (node.completionStrategy) {
		case "artifact-emit":
			return artifactMdExtractor;
		case "agent-end":
			return sideEffectExtractor;
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
function buildExtractorCtx(s: StageSession, branch: BranchEntry[], branchOffset: number | undefined): ExtractorCtx {
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

function wrapManifest(s: StageSession, payload: ExtractorPayload): Manifest {
	return finalizeManifest(payload, {
		skill: s.skill,
		stageNumber: s.state.lastAllocatedStageNumber + 1,
		ts: nowIso(),
		runId: s.runId,
	});
}

async function runExtractor(
	extractor: Extractor,
	extractorCtx: ExtractorCtx,
	finalize: (p: ExtractorPayload) => Manifest,
): Promise<{ kind: "ok"; manifest: Manifest | undefined } | { kind: "fatal"; message: string }> {
	const result = await extractor.extract(extractorCtx);
	if (result.kind === "fatal") return result;
	return { kind: "ok", manifest: result.payload ? finalize(result.payload) : undefined };
}

function shouldValidateOutput(node: NodeDef, manifest: Manifest | undefined): manifest is Manifest {
	return !!(node.outputSchema && manifest?.data);
}

interface RetryDeps {
	extractor: Extractor;
	extractorCtx: ExtractorCtx;
	finalize: (p: ExtractorPayload) => Manifest;
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
		// extraction used (L6-05). `deps.extractorCtx.branchOffset` was set
		// once at stage entry via the handler-derived offset, so spreading it
		// over a fresh `readBranch(ctx)` preserves the prior-stage prefix
		// skip and the closed-I4 defect can't re-introduce.
		const retryBranch = readBranch(ctx);
		const retryCtx: ExtractorCtx = { ...deps.extractorCtx, branch: retryBranch };
		const reExtracted = await runExtractor(deps.extractor, retryCtx, deps.finalize);
		if (reExtracted.kind === "fatal") return reExtracted;
		if (!reExtracted.manifest) {
			return { kind: "fatal", message: `${s.skill}: extractor returned no manifest on retry ${attempts}` };
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

// ===========================================================================
// SESSION POLICY HANDLER — owns every fresh-vs-continue decision
// ===========================================================================

/**
 * Three policy-specific decisions that used to live as five ternaries
 * scattered across this file:
 *
 *   - `branchOffset(captured)` — the offset extractors apply to skip
 *     the prior-stage prefix in continue sessions. Fresh ignores the
 *     stage-side captured value (it's `undefined` from
 *     `computeBranchOffset` for fresh stages anyway); continue returns
 *     it as-is.
 *   - `spawn(ctx, prompt, body, pi?)` — open the session and run `body`
 *     on whichever ctx is valid for that policy (fresh → freshCtx
 *     inside `withSession`; continue → the supplied ctx, after a
 *     send+waitForIdle settles the existing session). `cancelled: true`
 *     means a fresh session was cancelled before `withSession` ran.
 *   - `send(ctx, msg, pi?)` — send into an already-established session
 *     and wait for it to settle (used by the validation-retry path).
 *
 * `pi` is required for continue (caller passes `s.pi`; the start-of-run
 * preflight has already rejected any workflow that needs continue
 * without pi). Fresh ignores the `pi` parameter.
 */
interface SessionPolicyHandler {
	branchOffset(capturedOffset: number | undefined): number | undefined;
	spawn(
		ctx: RunnerCtx,
		prompt: string,
		body: (sessionCtx: RunnerCtx) => Promise<void>,
		pi?: ExtensionAPI,
	): Promise<{ cancelled: boolean }>;
	send(ctx: RunnerCtx, msg: string, pi?: ExtensionAPI): Promise<void>;
}

const FRESH_HANDLER: SessionPolicyHandler = {
	branchOffset: () => undefined,
	async spawn(ctx, prompt, body) {
		const { cancelled } = await ctx.newSession({
			withSession: async (freshCtx) => {
				await freshCtx.sendUserMessage(prompt);
				await body(freshCtx);
			},
		});
		return { cancelled };
	},
	async send(ctx, msg) {
		await (ctx as unknown as { sendUserMessage(m: string): Promise<void> }).sendUserMessage(msg);
	},
};

const CONTINUE_HANDLER: SessionPolicyHandler = {
	branchOffset: (captured) => captured,
	async spawn(ctx, prompt, body, pi) {
		if (!pi) throw new Error("CONTINUE_HANDLER.spawn: continue policy requires pi (ExtensionAPI)");
		// `pi.sendUserMessage` returns a Promise — pre-I5b we discarded it,
		// so a rejected send (e.g. transport closed, agent SDK fault)
		// surfaced as unhandledRejection past the stage boundary and the
		// runner kept walking the chain blind. Await so the rejection lands
		// on this stage's halt path. We don't `await ctx.waitForIdle({ signal })`
		// because Pi's SDK doesn't expose an abort signal yet — abandoned
		// waitForIdle from a prior retry can still settle on the next
		// continue stage's ctx (tracked, not fixed here).
		await pi.sendUserMessage(prompt);
		await ctx.waitForIdle();
		await body(ctx);
		return { cancelled: false };
	},
	async send(ctx, msg, pi) {
		if (!pi) throw new Error("CONTINUE_HANDLER.send: continue policy requires pi (ExtensionAPI)");
		await pi.sendUserMessage(msg);
		await ctx.waitForIdle();
	},
};

function handlerFor(policy: SessionPolicy | undefined): SessionPolicyHandler {
	return policy === "continue" ? CONTINUE_HANDLER : FRESH_HANDLER;
}

// ===========================================================================
// Helpers
// ===========================================================================

const auditFor = (s: StageSession | PhaseSession): AuditCtx => ({
	cwd: s.cwd,
	runId: s.runId,
	state: s.state,
	skill: s.skill,
});
