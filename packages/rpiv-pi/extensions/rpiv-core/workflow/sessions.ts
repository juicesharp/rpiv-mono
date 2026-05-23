/**
 * Session execution layer — drives one Pi session per workflow stage / phase.
 *
 * Two public entries (`runStageSession`, `runPhaseSession`) sit on top of the
 * shared `spawnSession` primitive. The session-policy switch (fresh vs continue)
 * lives only in `spawnSession`; everything downstream — stop classification,
 * manifest extraction with validation retry, JSONL persistence, chain advance —
 * is policy-agnostic.
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
	validateManifestData,
} from "./validation.js";

// ---------------------------------------------------------------------------
// Extractor resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the extractor for a node. Priority:
 * 1. Node-declared extractor → use it.
 * 2. stopStrategy "artifact-emit" → artifactMdExtractor.
 * 3. stopStrategy "agent-end" → sideEffectExtractor.
 */
function resolveExtractor(node: DagNode): ExtractorFn {
	if (node.extractor) return node.extractor;
	return node.stopStrategy === "artifact-emit" ? artifactMdExtractor : sideEffectExtractor;
}

// ---------------------------------------------------------------------------
// Send + await idle (used by spawnSession and the validation-retry loop)
// ---------------------------------------------------------------------------

/**
 * Send a user message into the session and block until the agent finishes
 * responding. Branches on session policy:
 * - "fresh": ctx is inside withSession, so sendUserMessage awaits the agent loop.
 * - "continue": uses pi.sendUserMessage (sync) + bounded macrotask poll on isIdle().
 */
async function sendAndAwaitIdle(
	ctx: ChainCtx,
	msg: string,
	opts: { sessionPolicy?: SessionPolicy; pi?: ExtensionAPI },
): Promise<void> {
	if (opts.sessionPolicy === "continue") {
		if (!opts.pi) throw new Error("sendAndAwaitIdle: continue requires pi");
		opts.pi.sendUserMessage(msg);
		const MAX_POLLS = 100;
		let polls = 0;
		while (!(ctx as unknown as { isIdle(): boolean }).isIdle()) {
			if (++polls > MAX_POLLS) throw new Error("sendAndAwaitIdle: timed out");
			await new Promise<void>((r) => setTimeout(r, 0));
		}
	} else {
		// Inside withSession, ctx is ReplacedSessionContext which has sendUserMessage.
		await (ctx as unknown as { sendUserMessage(msg: string): Promise<void> }).sendUserMessage(msg);
	}
}

// ---------------------------------------------------------------------------
// Branch inspection — classify how the agent stopped
// ---------------------------------------------------------------------------

function classifyStopOutcome(branch: BranchEntry[]): "ok" | "aborted" | "failed" {
	const stopReason = lastAssistantStopReason(branch);
	if (stopReason === "aborted") return "aborted";
	if (!hasAssistantMessage(branch) || stopReason === "error") return "failed";
	return "ok";
}

/** Snapshot of the agent's output for the just-finished session. */
interface SessionOutcome {
	branch: BranchEntry[];
	artifact: string | undefined;
	stop: "ok" | "aborted" | "failed";
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

// ---------------------------------------------------------------------------
// Manifest extraction + output validation
// ---------------------------------------------------------------------------

/** Discriminated result of `extractAndValidateManifest`. */
type ExtractionOutcome =
	| { kind: "ok"; manifest: Manifest | undefined }
	| { kind: "fatal"; message: string }
	| { kind: "validation-exhausted"; failureSummary: string };

/**
 * Run the extractor, finalize the envelope with runner-owned `meta`, then
 * run the output-validation retry loop (if the node declares a schema). The
 * retry loop re-invokes the extractor against the most recent branch after
 * each agent reply, hence the `freshBranch` thunk.
 */
async function extractAndValidateManifest(
	ctx: ChainCtx,
	s: StageSession,
	branch: BranchEntry[],
	freshBranch: () => BranchEntry[],
): Promise<ExtractionOutcome> {
	const node = s.node;
	const extractor = resolveExtractor(node);
	const extractorBranchOffset = node.sessionPolicy === "continue" ? undefined : s.branchOffset;

	const extractorCtx: ExtractorCtx = {
		cwd: s.cwd,
		runId: s.runId,
		stageIndex: s.stageIndex,
		state: s.state,
		branch,
		branchOffset: extractorBranchOffset,
		snapshot: s.snapshot,
		skill: s.skill,
	};

	const wrap = (payload: ExtractorPayload): Manifest =>
		finalizeManifest(payload, {
			skill: s.skill,
			stage: s.state.jsonlStage + 1,
			ts: nowIso(),
			runId: s.runId,
		});

	const first = await extractor(extractorCtx);
	if (first.fatal) return { kind: "fatal", message: first.fatal };
	let manifest: Manifest | undefined = first.payload ? wrap(first.payload) : undefined;

	if (!node.outputSchema || !manifest?.data) return { kind: "ok", manifest };

	const maxRetries = Math.min(node.maxValidationRetries ?? DEFAULT_VALIDATION_RETRIES, MAX_VALIDATION_RETRIES);
	let result = validateManifestData(node.outputSchema, manifest.data);
	let attempts = 0;

	while (!result.valid && attempts < maxRetries) {
		if (node.onValidationFailure === "halt") break;
		attempts++;
		ctx.ui.notify(MSG_VALIDATION_RETRY(s.skill, attempts), "warning");
		await sendAndAwaitIdle(ctx, formatValidationFailuresForAgent(s.skill, result.failures), {
			sessionPolicy: node.sessionPolicy,
			pi: s.pi,
		});

		const reExtract = await extractor({ ...extractorCtx, branch: freshBranch() });
		if (!reExtract.payload) {
			return {
				kind: "fatal",
				message: reExtract.fatal ?? `${s.skill}: extractor returned no manifest on retry ${attempts}`,
			};
		}
		manifest = wrap(reExtract.payload);
		result = validateManifestData(node.outputSchema, manifest.data);
	}

	if (!result.valid) {
		const failureSummary = result.failures.map((f) => `${f.path}: ${f.message}`).join("; ");
		return { kind: "validation-exhausted", failureSummary };
	}
	return { kind: "ok", manifest };
}

// ---------------------------------------------------------------------------
// Stage + phase post-processing
// ---------------------------------------------------------------------------

/**
 * Commit a successful stage to disk + in-memory state: dual-write artifact
 * path, update `state.manifest`, append the JSONL row.
 */
function persistStageSuccess(s: StageSession, artifact: string | undefined, manifest: Manifest | undefined): void {
	if (manifest?.artifact_path) s.state.artifactPath = manifest.artifact_path;
	else if (artifact) s.state.artifactPath = artifact;
	if (manifest) s.state.manifest = manifest;

	recordStage(s.cwd, s.runId, { skill: s.skill, artifact, status: "completed", ts: nowIso(), manifest }, s.state);
}

/** Stage post-processing: extract → validate → persist → notify → chain. */
async function postStage(ctx: ChainCtx, s: StageSession): Promise<void> {
	const audit: Audit = { cwd: s.cwd, runId: s.runId, state: s.state, skill: s.skill };
	const outcome = readSessionOutcome(ctx, { sessionPolicy: s.node.sessionPolicy, branchOffset: s.branchOffset });

	if (outcome.stop !== "ok") {
		recordStopFailure(ctx, audit, outcome.stop, `${s.skill} failed`, s.onFailure);
		return;
	}

	const result = await extractAndValidateManifest(
		ctx,
		s,
		outcome.branch,
		() => ctx.sessionManager.getBranch() as unknown as BranchEntry[],
	);
	if (result.kind === "fatal") {
		recordTerminalFailure(
			ctx,
			audit,
			{
				status: "failed",
				notifyMsg: MSG_STAGE_FAILED(s.skill),
				notifyLevel: "error",
				errMsg: result.message,
			},
			s.onFailure,
		);
		return;
	}
	if (result.kind === "validation-exhausted") {
		recordTerminalFailure(
			ctx,
			audit,
			{
				status: "failed",
				notifyMsg: MSG_VALIDATION_EXHAUSTED(s.skill),
				notifyLevel: "error",
				errMsg: ERR_VALIDATION_FAILED(s.skill, result.failureSummary),
			},
			s.onFailure,
		);
		return;
	}

	persistStageSuccess(s, outcome.artifact, result.manifest);
	ctx.ui.notify(MSG_STAGE_COMPLETE(s.skill), "info");
	s.state.stagesCompleted++;
	await s.onSuccess(ctx, outcome.artifact);
}

/** Per-phase JSONL row label, e.g. "implement (phase 2/4)". */
const phaseRowLabel = (s: PhaseSession) => `${s.skill} (phase ${s.phaseIndex}/${s.phaseCount})`;

/** Phase post-processing: no extraction; persist bare row + chain. */
async function postPhase(ctx: ChainCtx, s: PhaseSession): Promise<void> {
	const audit: Audit = { cwd: s.cwd, runId: s.runId, state: s.state, skill: s.skill };
	const outcome = readSessionOutcome(ctx, { sessionPolicy: "fresh" });

	if (outcome.stop !== "ok") {
		recordStopFailure(ctx, audit, outcome.stop, `${s.skill} phase ${s.phaseIndex} failed`);
		return;
	}

	if (outcome.artifact) s.state.artifactPath = outcome.artifact;
	recordStage(
		s.cwd,
		s.runId,
		{ skill: phaseRowLabel(s), artifact: outcome.artifact, status: "completed", ts: nowIso() },
		s.state,
	);
	// Phases hold the MSG_STAGE_COMPLETE notify until the parent stage finishes.
	s.state.stagesCompleted++;
	await s.onSuccess(ctx);
}

// ---------------------------------------------------------------------------
// Session spawn primitive + public entries
// ---------------------------------------------------------------------------

/** Discriminator + payload for `spawnSession`. */
type SessionSpawn = { kind: "fresh" } | { kind: "continue"; pi: ExtensionAPI };

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

/** Execute one DAG stage in its own session. */
export async function runStageSession(ctx: ChainCtx, s: StageSession): Promise<void> {
	const spawn: SessionSpawn =
		s.node.sessionPolicy === "continue" ? { kind: "continue", pi: s.pi! } : { kind: "fresh" };
	const audit: Audit = { cwd: s.cwd, runId: s.runId, state: s.state, skill: s.skill };
	await spawnSession(
		ctx,
		s.prompt,
		spawn,
		(sessionCtx) => postStage(sessionCtx, s),
		() => recordCancellation(ctx, audit),
	);
}

/** Execute one phase iteration of an implement stage. Always fresh. */
export async function runPhaseSession(ctx: ChainCtx, s: PhaseSession): Promise<void> {
	const audit: Audit = { cwd: s.cwd, runId: s.runId, state: s.state, skill: s.skill };
	await spawnSession(
		ctx,
		s.prompt,
		{ kind: "fresh" },
		(sessionCtx) => postPhase(sessionCtx, s),
		() => recordCancellation(ctx, audit),
	);
}
