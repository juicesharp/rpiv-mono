/**
 * Session execution — one Pi session per workflow stage / phase.
 * `runStageSession` and `runPhaseSession` are the two public entries.
 * The fresh-vs-continue branch lives only in spawnSession; everything
 * downstream (stop classification, extraction, validation, JSONL,
 * chain advance) is policy-agnostic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AuditCtx,
	nowIso,
	recordCancellation,
	recordStage,
	recordStopFailure,
	recordTerminalFailure,
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
import {
	assertNever,
	type BranchEntry,
	classifyStop,
	extractArtifactPath,
	readBranch,
	type StopSignal,
} from "./transcript.js";
import type { ChainCtx, PhaseSession, StageSession } from "./types.js";
import {
	DEFAULT_VALIDATION_RETRIES,
	DEFAULT_VALIDATION_RETRY_TIMEOUT_MS,
	formatValidationFailuresForAgent,
	MAX_VALIDATION_RETRIES,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	type ValidationFailure,
	validateManifestData,
	withTimeout,
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
	if (outcome.stop !== "stop") return haltStage(ctx, s, outcome.stop);

	const result = await extractAndValidateManifest(ctx, s, outcome.branch, freshBranchOf(ctx));
	if (result.kind === "fatal") return haltStageWithExtractionError(ctx, s, result.message);
	if (result.kind === "validation-exhausted") return haltStageWithValidationFailure(ctx, s, result.failureSummary);

	recordStageSuccess(ctx, s, outcome.artifact, result.manifest);
	await s.onSuccess(ctx, outcome.artifact);
}

/** Phase post-processing: classify outcome → persist bare row → chain. */
async function postPhase(ctx: ChainCtx, s: PhaseSession): Promise<void> {
	const outcome = readPhaseOutcome(ctx);
	if (outcome.stop !== "stop") return haltPhase(ctx, s, outcome.stop);

	recordPhaseSuccess(s, outcome.artifact);
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

function haltStage(ctx: ChainCtx, s: StageSession, stop: Exclude<StopSignal, "stop">): void {
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

function haltPhase(ctx: ChainCtx, s: PhaseSession, stop: Exclude<StopSignal, "stop">): void {
	recordStopFailure(ctx, auditFor(s), stop, `${s.skill} phase ${s.phaseIndex} failed`);
}

// ===========================================================================
// SUCCESS-PERSISTENCE HELPERS
// ===========================================================================

/** Bumps `stagesCompleted` only on disk-write success — keeps result.stagesCompleted aligned with row count. */
function recordStageSuccess(
	ctx: ChainCtx,
	s: StageSession,
	artifact: string | undefined,
	manifest: Manifest | undefined,
): void {
	if (manifest?.artifact_path) s.state.artifactPath = manifest.artifact_path;
	else if (artifact) s.state.artifactPath = artifact;
	if (manifest) s.state.manifest = manifest;

	const assigned = recordStage(
		s.cwd,
		s.runId,
		{ skill: s.skill, artifact, status: "completed", ts: nowIso(), manifest },
		s.state,
	);
	ctx.ui.notify(MSG_STAGE_COMPLETE(s.skill), "info");
	if (assigned !== undefined) s.state.stagesCompleted++;
}

/** Phase rows never notify — parent stage holds MSG_STAGE_COMPLETE until all phases finish. */
function recordPhaseSuccess(s: PhaseSession, artifact: string | undefined): void {
	if (artifact) s.state.artifactPath = artifact;
	const assigned = recordStage(
		s.cwd,
		s.runId,
		{ skill: phaseRowLabel(s), artifact, status: "completed", ts: nowIso() },
		s.state,
	);
	if (assigned !== undefined) s.state.stagesCompleted++;
}

// ===========================================================================
// BRANCH INSPECTION — read how the agent stopped
// ===========================================================================

interface SessionOutcome {
	branch: BranchEntry[];
	artifact: string | undefined;
	stop: StopSignal;
}

function readStageOutcome(ctx: ChainCtx, s: StageSession): SessionOutcome {
	return readSessionOutcome(ctx, { sessionPolicy: s.node.sessionPolicy, branchOffset: s.branchOffset });
}

function readPhaseOutcome(ctx: ChainCtx): SessionOutcome {
	return readSessionOutcome(ctx, { sessionPolicy: "fresh" });
}

/** Continue policies must slice the prior-stage prefix via `branchOffset`. */
function readSessionOutcome(
	ctx: ChainCtx,
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
function resolveExtractor(node: DagNode): ExtractorFn {
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
		stageNumber: s.state.lastStageNumber + 1,
		ts: nowIso(),
		runId: s.runId,
	});
}

async function runExtractor(
	extractor: ExtractorFn,
	extractorCtx: ExtractorCtx,
	finalize: (p: ExtractorPayload) => Manifest,
): Promise<{ kind: "ok"; manifest: Manifest | undefined } | { kind: "fatal"; message: string }> {
	const result = await extractor(extractorCtx);
	if (result.fatal) return { kind: "fatal", message: result.fatal };
	return { kind: "ok", manifest: result.payload ? finalize(result.payload) : undefined };
}

function shouldValidateOutput(node: DagNode, manifest: Manifest | undefined): manifest is Manifest {
	return !!(node.outputSchema && manifest?.data);
}

interface RetryDeps {
	extractor: ExtractorFn;
	extractorCtx: ExtractorCtx;
	finalize: (p: ExtractorPayload) => Manifest;
	freshBranch: () => BranchEntry[];
}

async function retryUntilValid(
	ctx: ChainCtx,
	s: StageSession,
	deps: RetryDeps,
	initial: Manifest,
): Promise<ExtractionOutcome> {
	const schema = s.node.outputSchema!;
	const maxRetries = Math.min(s.node.maxValidationRetries ?? DEFAULT_VALIDATION_RETRIES, MAX_VALIDATION_RETRIES);
	const timeoutMs = Math.min(
		s.node.validationRetryTimeoutMs ?? DEFAULT_VALIDATION_RETRY_TIMEOUT_MS,
		MAX_VALIDATION_RETRY_TIMEOUT_MS,
	);

	let manifest = initial;
	let result = validateManifestData(schema, manifest.data);
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

/**
 * Sends the fix request and races settlement against `timeoutMs`. waitForIdle
 * has no abort signal, so on timeout the underlying promise keeps draining in
 * the background; the next stage's `newSession` replaces the ctx and renders
 * it inert.
 */
async function askAgentToFix(
	ctx: ChainCtx,
	s: StageSession,
	attempt: number,
	failures: ValidationFailure[],
	timeoutMs: number,
): Promise<void> {
	ctx.ui.notify(MSG_VALIDATION_RETRY(s.skill, attempt), "warning");
	await withTimeout(
		sendAndAwaitIdle(ctx, formatValidationFailuresForAgent(s.skill, failures), {
			sessionPolicy: s.node.sessionPolicy,
			pi: s.pi,
		}),
		timeoutMs,
		`${s.skill}: validation retry attempt ${attempt} exceeded ${timeoutMs}ms — agent did not settle`,
	);
}

function validationExhausted(failures: ValidationFailure[]): ExtractionOutcome {
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
 * Fresh ctx is ReplacedSessionContext (sendUserMessage awaits the agent loop);
 * continue path uses pi.sendUserMessage + ctx.waitForIdle().
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
const freshBranchOf = (ctx: ChainCtx) => () => readBranch(ctx);

/** Per-phase JSONL row label, e.g. "implement (phase 2/4)". */
const phaseRowLabel = (s: PhaseSession) => `${s.skill} (phase ${s.phaseIndex}/${s.phaseCount})`;
