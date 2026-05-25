/**
 * Session execution — one Pi session per workflow stage / phase.
 * `runStageSession` and `runPhaseSession` are the two public entries.
 * The fresh-vs-continue branch lives only in spawnSession; everything
 * downstream (stop classification, extraction, validation, JSONL,
 * chain advance) is policy-agnostic.
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
import type { PhaseSession, RunnerCtx, StageSession } from "./types.js";
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
	await spawnSession(
		ctx,
		s.prompt,
		spawnPolicyFor(s),
		(sessionCtx) => postStage(sessionCtx, s),
		() => recordCancellation(ctx, auditFor(s)),
	);
}

/** Execute one phase iteration of an implement stage. Always fresh. */
export async function runPhaseSession(ctx: RunnerCtx, s: PhaseSession): Promise<void> {
	await spawnSession(
		ctx,
		s.prompt,
		{ kind: "fresh" },
		(sessionCtx) => postPhase(sessionCtx, s),
		() => recordCancellation(ctx, auditFor(s)),
	);
}

// ===========================================================================
// POST-PROCESSING — runs after the agent loop settles
// ===========================================================================

/** Stage post-processing: classify outcome → extract & validate → persist → chain. */
async function postStage(ctx: RunnerCtx, s: StageSession): Promise<void> {
	const outcome = readStageOutcome(ctx, s);
	if (outcome.stop !== "stop") return haltStage(ctx, s, outcome.stop);

	const result = await extractAndValidateManifest(ctx, s, outcome.branch, freshBranchOf(ctx));
	if (result.kind === "fatal") return haltStageWithExtractionError(ctx, s, result.message);
	if (result.kind === "validation-exhausted") return haltStageWithValidationFailure(ctx, s, result.failureSummary);

	if (!recordStageSuccess(ctx, s, outcome.artifact, result.manifest)) return;
	await s.onSuccess(ctx, outcome.artifact);
}

/** Phase post-processing: classify outcome → persist bare row → chain. */
async function postPhase(ctx: RunnerCtx, s: PhaseSession): Promise<void> {
	const outcome = readPhaseOutcome(ctx);
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

/** Retry loop re-extracts against the latest branch after each fix request — hence `freshBranch`. */
async function extractAndValidateManifest(
	ctx: RunnerCtx,
	s: StageSession,
	branch: BranchEntry[],
	freshBranch: () => BranchEntry[],
): Promise<ExtractionOutcome> {
	const extractor = resolveExtractor(s.node);
	const extractorCtx = buildExtractorCtx(s, branch);
	const finalize = (payload: ExtractorPayload) => wrapManifest(s, payload);

	const first = await runExtractor(extractor, extractorCtx, finalize);
	if (first.kind === "fatal") return first;
	if (!shouldValidateOutput(s.node, first.manifest)) return first;

	return retryUntilValid(ctx, s, { extractor, extractorCtx, finalize, freshBranch }, first.manifest);
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
	const assigned = recordStage(
		s.cwd,
		s.runId,
		{ skill: s.skill, artifact, status: "completed", ts: nowIso(), manifest },
		s.state,
	);
	if (assigned === undefined) {
		ctx.ui.notify(MSG_AUDIT_WRITE_FAILED(s.skill), "error");
		s.state.termination.error = ERR_AUDIT_WRITE_FAILED(s.skill);
		return false;
	}
	// Manifest is set whenever present; fallback only carries the bare
	// transcript path when the manifest doesn't already supply one (e.g.
	// sideEffectExtractor with no upstream artifact_path). currentArtifactPath
	// prefers the manifest field and falls through to fallback otherwise.
	if (manifest) s.state.manifest = manifest;
	if (!manifest?.artifact_path && artifact) s.state.fallbackArtifactPath = artifact;
	s.state.stagesCompleted++;
	ctx.ui.notify(MSG_STAGE_COMPLETE(s.skill), "info");
	return true;
}

/** Phase rows never notify — parent stage holds MSG_STAGE_COMPLETE until all phases finish. */
function recordPhaseSuccess(s: PhaseSession, artifact: string | undefined): boolean {
	const assigned = recordStage(
		s.cwd,
		s.runId,
		{ skill: phaseRowLabel(s), artifact, status: "completed", ts: nowIso() },
		s.state,
	);
	if (assigned === undefined) {
		s.state.termination.error = ERR_AUDIT_WRITE_FAILED(phaseRowLabel(s));
		return false;
	}
	// Phases never carry manifests — write goes through the fallback slot,
	// which currentArtifactPath surfaces when no manifest is on hand.
	if (artifact) s.state.fallbackArtifactPath = artifact;
	s.state.stagesCompleted++;
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

function readStageOutcome(ctx: RunnerCtx, s: StageSession): SessionOutcome {
	return readSessionOutcome(ctx, { sessionPolicy: s.node.sessionPolicy, branchOffset: s.branchOffset });
}

function readPhaseOutcome(ctx: RunnerCtx): SessionOutcome {
	return readSessionOutcome(ctx, { sessionPolicy: "fresh" });
}

/** Continue policies must slice the prior-stage prefix via `branchOffset`. */
function readSessionOutcome(
	ctx: RunnerCtx,
	opts: { sessionPolicy?: SessionPolicy; branchOffset?: number },
): SessionOutcome {
	const fullBranch = readBranch(ctx);
	const branch = opts.sessionPolicy === "continue" ? fullBranch.slice(opts.branchOffset ?? 0) : fullBranch;
	return {
		branch,
		artifact: extractArtifactPath(branch),
		stop: classifyStop(branch),
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

function buildExtractorCtx(s: StageSession, branch: BranchEntry[]): ExtractorCtx {
	return {
		cwd: s.cwd,
		runId: s.runId,
		stageIndex: s.stageIndex,
		state: s.state,
		branch,
		// Continue branch is already sliced upstream — undefined here so
		// extractArtifactPath doesn't double-slice.
		branchOffset: s.node.sessionPolicy === "continue" ? undefined : s.branchOffset,
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
	if (result.fatal) return { kind: "fatal", message: result.fatal };
	return { kind: "ok", manifest: result.payload ? finalize(result.payload) : undefined };
}

function shouldValidateOutput(node: NodeDef, manifest: Manifest | undefined): manifest is Manifest {
	return !!(node.outputSchema && manifest?.data);
}

interface RetryDeps {
	extractor: Extractor;
	extractorCtx: ExtractorCtx;
	finalize: (p: ExtractorPayload) => Manifest;
	freshBranch: () => BranchEntry[];
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

		// Re-extract against the latest branch. For continue policy, freshBranch
		// returns the UNSLICED branch (readBranch over the shared ctx), but
		// extractorCtx.branchOffset is undefined because the FIRST extraction
		// received a pre-sliced branch. Pass the originally-captured s.branchOffset
		// here so extractArtifactPath skips the prior-stage prefix instead of
		// re-finding the upstream artifact and silently passing the validation
		// retry while routing on stale state. (Closes I4 from the 2026-05-24
		// review — artifact-emit + continue retry inherited prior path.)
		const retryBranch = deps.freshBranch();
		const retryCtx =
			s.node.sessionPolicy === "continue"
				? { ...deps.extractorCtx, branch: retryBranch, branchOffset: s.branchOffset }
				: { ...deps.extractorCtx, branch: retryBranch };
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
		sendAndAwaitIdle(ctx, MSG_VALIDATION_RETRY_PROMPT(s.skill, errorLines), {
			sessionPolicy: s.node.sessionPolicy,
			pi: s.pi,
		}),
		timeoutMs,
		`${s.skill}: validation retry attempt ${attempt} exceeded ${timeoutMs}ms — agent did not settle`,
	);
}

function validationExhausted(failures: SchemaValidationFailure[]): ExtractionOutcome {
	const failureSummary = failures.map((f) => `${f.path}: ${f.message}`).join("; ");
	return { kind: "validation-exhausted", failureSummary };
}

// ===========================================================================
// SESSION SPAWN PRIMITIVE
// ===========================================================================

type SessionSpawn = { kind: "fresh" } | { kind: "continue"; pi: ExtensionAPI };

function spawnPolicyFor(s: StageSession): SessionSpawn {
	return s.node.sessionPolicy === "continue" ? { kind: "continue", pi: s.pi! } : { kind: "fresh" };
}

/**
 * `body` runs on the ctx that's valid for the spawned session — `freshCtx`
 * inside `withSession` for fresh, the supplied `ctx` for continue.
 * `onCancelled` fires only when a fresh session is cancelled pre-withSession.
 */
async function spawnSession(
	ctx: RunnerCtx,
	prompt: string,
	spawn: SessionSpawn,
	body: (sessionCtx: RunnerCtx) => Promise<void>,
	onCancelled?: () => void,
): Promise<void> {
	if (spawn.kind === "continue") {
		await sendAndAwaitIdle(ctx, prompt, { sessionPolicy: "continue", pi: spawn.pi });
		await body(ctx);
		return;
	}

	const { cancelled } = await ctx.newSession({
		withSession: async (freshCtx) => {
			await freshCtx.sendUserMessage(prompt);
			await body(freshCtx);
		},
	});

	if (cancelled && onCancelled) onCancelled();
}

/**
 * Fresh ctx is ReplacedSessionContext (sendUserMessage awaits the agent loop);
 * continue path uses pi.sendUserMessage + ctx.waitForIdle().
 */
async function sendAndAwaitIdle(
	ctx: RunnerCtx,
	msg: string,
	opts: { sessionPolicy?: SessionPolicy; pi?: ExtensionAPI },
): Promise<void> {
	if (opts.sessionPolicy === "continue") {
		if (!opts.pi) throw new Error("sendAndAwaitIdle: continue requires pi");
		// `pi.sendUserMessage` returns a Promise — pre-I5b we discarded it,
		// so a rejected send (e.g. transport closed, agent SDK fault)
		// surfaced as unhandledRejection past the stage boundary and the
		// runner kept walking the chain blind. Await so the rejection lands
		// on this stage's halt path. We don't `await ctx.waitForIdle({ signal })`
		// because Pi's SDK doesn't expose an abort signal yet — abandoned
		// waitForIdle from a prior retry can still settle on the next
		// continue stage's ctx (tracked, not fixed here).
		await opts.pi.sendUserMessage(msg);
		await ctx.waitForIdle();
	} else {
		await (ctx as unknown as { sendUserMessage(msg: string): Promise<void> }).sendUserMessage(msg);
	}
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

/** Thunk that re-reads the current branch — used by the retry loop after each agent reply. */
const freshBranchOf = (ctx: RunnerCtx) => () => readBranch(ctx);
