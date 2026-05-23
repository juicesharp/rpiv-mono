/**
 * Session execution layer — drives one Pi session per workflow stage / phase.
 *
 * Two public entries (`runStageSession`, `runPhaseSession`) sit on top of the
 * shared `spawnSession` primitive. The session-policy switch (fresh vs continue)
 * lives only in `spawnSession`; everything downstream — stop classification,
 * manifest extraction with validation retry, JSONL persistence, chain advance —
 * is policy-agnostic.
 *
 * Top-level functions (`postStage`, `postPhase`, `extractAndValidateManifest`)
 * are written programming-by-intention: every line at their top level is a
 * single named action at the same abstraction level. The "what to do" reads
 * top-to-bottom; the "how" lives in the named helpers below.
 *
 * Imports the audit layer (record* / Audit) and message constants; never the
 * orchestration layer (`runner.ts`). The orchestration layer drives this
 * module by building `StageSession` / `PhaseSession` and awaiting the entry.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Audit,
	nowIso,
	recordCancellation,
	recordStage,
	recordStopFailure,
	recordTerminalFailure,
	type StopOutcome,
} from "./audit.js";
import type { DagNode, SessionPolicy } from "./dag.js";
import { artifactMdExtractor, sideEffectExtractor } from "./extractors/index.js";
import {
	type ExtractorCtx,
	type ExtractorFn,
	type ExtractorPayload,
	finalizeManifest,
	type Manifest,
} from "./manifest.js";
import {
	ERR_VALIDATION_FAILED,
	MSG_STAGE_COMPLETE,
	MSG_STAGE_FAILED,
	MSG_VALIDATION_EXHAUSTED,
	MSG_VALIDATION_RETRY,
} from "./messages.js";
import { type BranchEntry, extractArtifactPath, hasAssistantMessage, lastAssistantStopReason } from "./transcript.js";
import type { ChainCtx, PhaseSession, StageSession } from "./types.js";
import {
	DEFAULT_VALIDATION_RETRIES,
	formatValidationFailuresForAgent,
	MAX_VALIDATION_RETRIES,
	type ValidationFailure,
	validateManifestData,
} from "./validation.js";

// ===========================================================================
// PUBLIC ENTRIES — what the orchestrator calls
// ===========================================================================

/** Execute one DAG stage in its own session. */
export async function runStageSession(ctx: ChainCtx, s: StageSession): Promise<void> {
	await spawnSession(
		ctx,
		s.prompt,
		spawnPolicyFor(s),
		(sessionCtx) => postStage(sessionCtx, s),
		() => recordCancellation(ctx, auditFor(s)),
	);
}

/** Execute one phase iteration of an implement stage. Always fresh. */
export async function runPhaseSession(ctx: ChainCtx, s: PhaseSession): Promise<void> {
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
async function postStage(ctx: ChainCtx, s: StageSession): Promise<void> {
	const outcome = readStageOutcome(ctx, s);
	if (outcome.stop !== "ok") return haltStage(ctx, s, outcome.stop);

	const result = await extractAndValidateManifest(ctx, s, outcome.branch, freshBranchOf(ctx));
	if (result.kind === "fatal") return haltStageWithExtractionError(ctx, s, result.message);
	if (result.kind === "validation-exhausted") return haltStageWithValidationFailure(ctx, s, result.failureSummary);

	recordStageSuccess(ctx, s, outcome.artifact, result.manifest);
	await s.onSuccess(ctx, outcome.artifact);
}

/** Phase post-processing: classify outcome → persist bare row → chain. */
async function postPhase(ctx: ChainCtx, s: PhaseSession): Promise<void> {
	const outcome = readPhaseOutcome(ctx);
	if (outcome.stop !== "ok") return haltPhase(ctx, s, outcome.stop);

	recordPhaseSuccess(s, outcome.artifact);
	await s.onSuccess(ctx);
}

// ===========================================================================
// MANIFEST EXTRACTION + VALIDATION
// ===========================================================================

/** Discriminated result of `extractAndValidateManifest`. */
type ExtractionOutcome =
	| { kind: "ok"; manifest: Manifest | undefined }
	| { kind: "fatal"; message: string }
	| { kind: "validation-exhausted"; failureSummary: string };

/**
 * Run the extractor, finalize the envelope with runner-owned `meta`, then run
 * the output-validation retry loop (if the node declares a schema). The retry
 * loop re-invokes the extractor against the most recent branch after each
 * agent reply, hence the `freshBranch` thunk.
 */
async function extractAndValidateManifest(
	ctx: ChainCtx,
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

function haltStage(ctx: ChainCtx, s: StageSession, stop: Exclude<StopOutcome, "ok">): void {
	recordStopFailure(ctx, auditFor(s), stop, `${s.skill} failed`, s.onFailure);
}

function haltStageWithExtractionError(ctx: ChainCtx, s: StageSession, message: string): void {
	recordTerminalFailure(
		ctx,
		auditFor(s),
		{ status: "failed", notifyMsg: MSG_STAGE_FAILED(s.skill), notifyLevel: "error", errMsg: message },
		s.onFailure,
	);
}

function haltStageWithValidationFailure(ctx: ChainCtx, s: StageSession, failureSummary: string): void {
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

function haltPhase(ctx: ChainCtx, s: PhaseSession, stop: Exclude<StopOutcome, "ok">): void {
	recordStopFailure(ctx, auditFor(s), stop, `${s.skill} phase ${s.phaseIndex} failed`);
}

// ===========================================================================
// SUCCESS-PERSISTENCE HELPERS
// ===========================================================================

/** Stage success: dual-write artifact path, set state.manifest, write JSONL row, notify + bump counter. */
function recordStageSuccess(
	ctx: ChainCtx,
	s: StageSession,
	artifact: string | undefined,
	manifest: Manifest | undefined,
): void {
	if (manifest?.artifact_path) s.state.artifactPath = manifest.artifact_path;
	else if (artifact) s.state.artifactPath = artifact;
	if (manifest) s.state.manifest = manifest;

	recordStage(s.cwd, s.runId, { skill: s.skill, artifact, status: "completed", ts: nowIso(), manifest }, s.state);
	ctx.ui.notify(MSG_STAGE_COMPLETE(s.skill), "info");
	s.state.stagesCompleted++;
}

/**
 * Phase success: inherit artifact, write JSONL row, bump counter. The MSG_STAGE_COMPLETE
 * notify is suppressed — phases hold it until the parent stage finishes.
 */
function recordPhaseSuccess(s: PhaseSession, artifact: string | undefined): void {
	if (artifact) s.state.artifactPath = artifact;
	recordStage(s.cwd, s.runId, { skill: phaseRowLabel(s), artifact, status: "completed", ts: nowIso() }, s.state);
	s.state.stagesCompleted++;
}

// ===========================================================================
// BRANCH INSPECTION — classify how the agent stopped
// ===========================================================================

/** Snapshot of the agent's output for the just-finished session. */
interface SessionOutcome {
	branch: BranchEntry[];
	artifact: string | undefined;
	stop: StopOutcome;
}

function readStageOutcome(ctx: ChainCtx, s: StageSession): SessionOutcome {
	return readSessionOutcome(ctx, { sessionPolicy: s.node.sessionPolicy, branchOffset: s.branchOffset });
}

function readPhaseOutcome(ctx: ChainCtx): SessionOutcome {
	return readSessionOutcome(ctx, { sessionPolicy: "fresh" });
}

/**
 * Read the branch for this session. "continue" policies inherit prior-stage
 * entries and must be sliced by `branchOffset`; fresh sessions start at 0.
 */
function readSessionOutcome(
	ctx: ChainCtx,
	opts: { sessionPolicy?: SessionPolicy; branchOffset?: number },
): SessionOutcome {
	const fullBranch = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
	const branch = opts.sessionPolicy === "continue" ? fullBranch.slice(opts.branchOffset ?? 0) : fullBranch;
	return {
		branch,
		artifact: extractArtifactPath(branch),
		stop: classifyStopOutcome(branch),
	};
}

function classifyStopOutcome(branch: BranchEntry[]): StopOutcome {
	const stopReason = lastAssistantStopReason(branch);
	if (stopReason === "aborted") return "aborted";
	if (!hasAssistantMessage(branch) || stopReason === "error") return "failed";
	return "ok";
}

// ===========================================================================
// EXTRACTION INTERNALS
// ===========================================================================

/** Resolve the extractor for a node — explicit > artifact-emit default > agent-end default. */
function resolveExtractor(node: DagNode): ExtractorFn {
	if (node.extractor) return node.extractor;
	return node.stopStrategy === "artifact-emit" ? artifactMdExtractor : sideEffectExtractor;
}

/** Build the per-stage ExtractorCtx — slicing semantics differ for continue policies. */
function buildExtractorCtx(s: StageSession, branch: BranchEntry[]): ExtractorCtx {
	return {
		cwd: s.cwd,
		runId: s.runId,
		stageIndex: s.stageIndex,
		state: s.state,
		branch,
		// For continue stages, branch is already sliced; pass undefined so extractors
		// (which call extractArtifactPath) don't double-slice.
		branchOffset: s.node.sessionPolicy === "continue" ? undefined : s.branchOffset,
		snapshot: s.snapshot,
		skill: s.skill,
	};
}

/** Wrap a freshly-extracted payload in a full Manifest, sourcing meta from the session. */
function wrapManifest(s: StageSession, payload: ExtractorPayload): Manifest {
	return finalizeManifest(payload, {
		skill: s.skill,
		stage: s.state.jsonlStage + 1,
		ts: nowIso(),
		runId: s.runId,
	});
}

/** Invoke the extractor once; normalise the result into ExtractionOutcome-without-validation-exhausted. */
async function runExtractor(
	extractor: ExtractorFn,
	extractorCtx: ExtractorCtx,
	finalize: (p: ExtractorPayload) => Manifest,
): Promise<{ kind: "ok"; manifest: Manifest | undefined } | { kind: "fatal"; message: string }> {
	const result = await extractor(extractorCtx);
	if (result.fatal) return { kind: "fatal", message: result.fatal };
	return { kind: "ok", manifest: result.payload ? finalize(result.payload) : undefined };
}

/** When the node has no schema (or extraction produced no payload), skip validation. */
function shouldValidateOutput(node: DagNode, manifest: Manifest | undefined): manifest is Manifest {
	return !!(node.outputSchema && manifest?.data);
}

/** Tools the validation loop needs from the caller, grouped so the loop signature stays readable. */
interface RetryDeps {
	extractor: ExtractorFn;
	extractorCtx: ExtractorCtx;
	finalize: (p: ExtractorPayload) => Manifest;
	freshBranch: () => BranchEntry[];
}

/**
 * Validate the extracted manifest, asking the agent to fix and re-extracting
 * up to `maxValidationRetries` times. Returns the validated manifest or one of
 * the two terminal failure kinds.
 */
async function retryUntilValid(
	ctx: ChainCtx,
	s: StageSession,
	deps: RetryDeps,
	initial: Manifest,
): Promise<ExtractionOutcome> {
	const schema = s.node.outputSchema!;
	const maxRetries = Math.min(s.node.maxValidationRetries ?? DEFAULT_VALIDATION_RETRIES, MAX_VALIDATION_RETRIES);

	let manifest = initial;
	let result = validateManifestData(schema, manifest.data);
	let attempts = 0;

	while (!result.valid && attempts < maxRetries && s.node.onValidationFailure !== "halt") {
		attempts++;
		await askAgentToFix(ctx, s, attempts, result.failures);

		const reExtracted = await runExtractor(
			deps.extractor,
			{ ...deps.extractorCtx, branch: deps.freshBranch() },
			deps.finalize,
		);
		if (reExtracted.kind === "fatal") return reExtracted;
		if (!reExtracted.manifest) {
			return { kind: "fatal", message: `${s.skill}: extractor returned no manifest on retry ${attempts}` };
		}

		manifest = reExtracted.manifest;
		result = validateManifestData(schema, manifest.data);
	}

	if (!result.valid) return validationExhausted(result.failures);
	return { kind: "ok", manifest };
}

/** Notify the user + send the agent a fix request, blocking until the agent settles. */
async function askAgentToFix(
	ctx: ChainCtx,
	s: StageSession,
	attempt: number,
	failures: ValidationFailure[],
): Promise<void> {
	ctx.ui.notify(MSG_VALIDATION_RETRY(s.skill, attempt), "warning");
	await sendAndAwaitIdle(ctx, formatValidationFailuresForAgent(s.skill, failures), {
		sessionPolicy: s.node.sessionPolicy,
		pi: s.pi,
	});
}

/** Build the validation-exhausted outcome from accumulated failures. */
function validationExhausted(failures: ValidationFailure[]): ExtractionOutcome {
	const failureSummary = failures.map((f) => `${f.path}: ${f.message}`).join("; ");
	return { kind: "validation-exhausted", failureSummary };
}

// ===========================================================================
// SESSION SPAWN PRIMITIVE
// ===========================================================================

/** Discriminator + payload for `spawnSession`. */
type SessionSpawn = { kind: "fresh" } | { kind: "continue"; pi: ExtensionAPI };

function spawnPolicyFor(s: StageSession): SessionSpawn {
	return s.node.sessionPolicy === "continue" ? { kind: "continue", pi: s.pi! } : { kind: "fresh" };
}

/**
 * Drive one Pi session: send the prompt + await idle, then run `body` on the
 * ctx that's valid for the spawned session — `freshCtx` inside `withSession`
 * for fresh policies, the supplied `ctx` for continue policies.
 *
 * `onCancelled` fires only when a fresh session is cancelled before
 * `withSession` returned.
 */
async function spawnSession(
	ctx: ChainCtx,
	prompt: string,
	spawn: SessionSpawn,
	body: (sessionCtx: ChainCtx) => Promise<void>,
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
 * Send a user message into the session and block until the agent finishes
 * responding. Branches on session policy:
 * - "fresh": ctx is inside withSession, so sendUserMessage awaits the agent loop.
 * - "continue": uses pi.sendUserMessage (sync, fire-and-forget) + awaits
 *   `ctx.waitForIdle()`, which the SDK resolves when streaming finishes.
 */
async function sendAndAwaitIdle(
	ctx: ChainCtx,
	msg: string,
	opts: { sessionPolicy?: SessionPolicy; pi?: ExtensionAPI },
): Promise<void> {
	if (opts.sessionPolicy === "continue") {
		if (!opts.pi) throw new Error("sendAndAwaitIdle: continue requires pi");
		opts.pi.sendUserMessage(msg);
		await ctx.waitForIdle();
	} else {
		// Inside withSession, ctx is ReplacedSessionContext which has sendUserMessage.
		await (ctx as unknown as { sendUserMessage(msg: string): Promise<void> }).sendUserMessage(msg);
	}
}

// ===========================================================================
// SHARED MICRO-HELPERS
// ===========================================================================

/** Collapse a session struct down to the audit-layer's minimal shape. */
const auditFor = (s: StageSession | PhaseSession): Audit => ({
	cwd: s.cwd,
	runId: s.runId,
	state: s.state,
	skill: s.skill,
});

/** Thunk that re-reads the current branch — used by the retry loop after each agent reply. */
const freshBranchOf = (ctx: ChainCtx) => () => ctx.sessionManager.getBranch() as unknown as BranchEntry[];

/** Per-phase JSONL row label, e.g. "implement (phase 2/4)". */
const phaseRowLabel = (s: PhaseSession) => `${s.skill} (phase ${s.phaseIndex}/${s.phaseCount})`;
