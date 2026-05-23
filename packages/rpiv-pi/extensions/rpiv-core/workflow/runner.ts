/**
 * Iterative session runner for the /rpiv workflow command.
 *
 * Each DAG node (one "stage" in the preset sequence) runs in its own session.
 * The session policy controls how that session is created:
 *
 *   - `sessionPolicy: "fresh"` — wraps the node in `ctx.newSession({ withSession })`.
 *     Inside withSession, `freshCtx.sendUserMessage()` awaits the full agent loop.
 *     The next stage's `newSession()` is invoked **on freshCtx** — never on the
 *     outer ctx, which is invalidated by Pi the moment a session is replaced.
 *
 *   - `sessionPolicy: "continue"` — reuses the prior stage's session (no newSession).
 *     Sends the prompt via `pi.sendUserMessage()` (sync, fire-and-forget) then
 *     awaits `ctx.waitForIdle()` with a bounded macrotask poll. Branch entries
 *     accumulate from the prior stage; the runner slices with `branchOffset` to
 *     inspect only entries produced by this stage.
 *
 * Each level of the chain only ever touches the ctx it was handed:
 *   - On `cancelled === true` no replacement happened — the level's curCtx
 *     is still valid for the final notify/append.
 *   - On `cancelled === false` curCtx is stale after newSession returns; all
 *     further work was already performed inside the withSession callback on
 *     freshCtx, and the function simply unwinds.
 *   - On "continue" there is no newSession — curCtx remains valid throughout.
 *
 * The session-spawn body itself lives in `executeSession` — runStage and
 * runImplementPhases are thin shells that build the prompt + labels for it.
 *
 * Vocabulary:
 *   - "stage" = one position in a preset's node sequence (a DAG node).
 *   - "phase" = one `## Phase N:` subdivision *inside an implement plan
 *     artifact* — only meaningful for the `implement` stage.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { clearChildSession, markChildSession } from "./child-session.js";
import type { DagNode, SessionPolicy, WorkflowDag } from "./dag.js";
import { WORKFLOW_DAG } from "./dag.js";
import { artifactMdExtractor, sideEffectExtractor } from "./extractors/index.js";
import { countPhases, runImplementPhases } from "./implement-phases.js";
import {
	type ExtractorCtx,
	type ExtractorFn,
	type ExtractorPayload,
	finalizeManifest,
	type Manifest,
} from "./manifest.js";
import { resolveNextStageId } from "./routing.js";
import {
	appendRoutingDecision,
	appendStage,
	generateRunId,
	readAllStages,
	type WorkflowStage,
	writeHeader,
} from "./state.js";
import { type BranchEntry, extractArtifactPath, hasAssistantMessage, lastAssistantStopReason } from "./transcript.js";
import type { ChainCtx, ExecuteSessionParams, RunContext } from "./types.js";
import {
	DEFAULT_VALIDATION_RETRIES,
	formatValidationFailuresForAgent,
	MAX_VALIDATION_RETRIES,
	validateManifestData,
} from "./validation.js";

// Re-export so existing imports of `extractArtifactPath` and `countPhases`
// from "./runner.js" keep working — production callers and tests both rely
// on this surface.
export { countPhases } from "./implement-phases.js";
export { extractArtifactPath } from "./transcript.js";

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
// Types
// ---------------------------------------------------------------------------

/** Options for running a workflow. */
export interface RunWorkflowOptions {
	/** Preset name (resolved to a linear sequence). */
	preset: string;
	/** User's input text — passed as argument to the first skill. */
	input: string;
	/** The DAG to traverse. Defaults to WORKFLOW_DAG. */
	dag?: WorkflowDag;
	/** ExtensionAPI — needed for "continue" stages that call pi.sendUserMessage(). */
	pi?: ExtensionAPI;
}

/** Result of a completed workflow run. */
export interface RunWorkflowResult {
	/** Total number of stages completed. */
	stagesCompleted: number;
	/** Whether the workflow completed all stages successfully. */
	success: boolean;
	/** The last artifact path produced, if any. */
	lastArtifact?: string;
	/** Error message if the workflow stopped due to failure. */
	error?: string;
}

// ---------------------------------------------------------------------------
// Message constants
// ---------------------------------------------------------------------------

// Persistent status-line state — written via ctx.ui.setStatus, cleared at the
// end of every workflow regardless of outcome. Pi's `notify` is a one-shot
// channel that the `newSession` transition repaints away (see
// session-hooks.ts:120/127 for the canonical setStatus pattern in rpiv-core).
const STATUS_KEY = "rpiv-workflow";

const STATUS_STAGE = (stage: number, total: number, skill: string) => `rpiv: stage ${stage}/${total} — ${skill}`;

// One-shot announcements via `ui.notify` — best-effort visibility; some may be
// repainted by Pi's session transition, but the persistent status line above
// guarantees the user always knows where the workflow currently is.
const MSG_STAGE_COMPLETE = (skill: string) => `✓ ${skill} completed`;

const MSG_STAGE_FAILED = (skill: string) => `✗ ${skill} failed — stopping workflow`;

const MSG_WORKFLOW_COMPLETE = (stages: number) => `rpiv: workflow complete (${stages} stages)`;

const MSG_WORKFLOW_CANCELLED = "rpiv: workflow cancelled";

const MSG_STAGE_ABORTED = (skill: string) => `⏸ ${skill} aborted (ESC) — stopping workflow`;

const MSG_VALIDATION_RETRY = (skill: string, attempt: number) =>
	`rpiv: ${skill} output validation failed — asking agent to fix (attempt ${attempt})`;
const MSG_VALIDATION_EXHAUSTED = (skill: string) => `rpiv: ${skill} output validation exhausted retries`;
const ERR_VALIDATION_FAILED = (skill: string, failures: string) =>
	`${skill} output validation failed after retries: ${failures}`;

const MSG_INPUT_VALIDATION_FAILED = (currentSkill: string, prevSkill: string) =>
	`✗ ${currentSkill} input validation failed — upstream ${prevSkill} produced invalid data`;
const ERR_INPUT_VALIDATION_FAILED = (currentSkill: string, prevSkill: string, failures: string) =>
	`Input validation failed for '${currentSkill}': upstream '${prevSkill}' produced invalid data: ${failures}`;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

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

/**
 * Run a workflow: iterate through a preset's skill sequence, creating a new
 * session for each stage, extracting artifact paths, and advancing.
 *
 * The chain is structured so that each subsequent `newSession()` is invoked
 * on the freshCtx returned from the previous withSession — never on a captured
 * outer ctx (which Pi invalidates as soon as the session is replaced).
 */
export async function runWorkflow(
	ctx: ExtensionCommandContext,
	options: RunWorkflowOptions,
): Promise<RunWorkflowResult> {
	const dag = options.dag ?? WORKFLOW_DAG;
	const stageIds = dag.presets[options.preset];
	if (!stageIds || stageIds.length === 0) {
		return { stagesCompleted: 0, success: false, error: `Unknown preset: ${options.preset}` };
	}

	const cwd = ctx.cwd;
	const runId = generateRunId();
	const totalStages = stageIds.length;

	writeHeader(cwd, {
		runId,
		preset: options.preset,
		input: options.input,
		ts: nowIso(),
	});

	// Mutable state closed-over by the chain. Per-level closures update these
	// while their ctx is still valid; the top-level await returns the snapshot.
	// `originalInput` is frozen — the user's `/rpiv` argument. `artifactPath`
	// starts undefined and only takes a value once a stage actually produces a
	// `.rpiv/artifacts/...` path, so `countPhases` is never handed raw user
	// text masquerading as a file path.
	const state = {
		originalInput: options.input,
		artifactPath: undefined as string | undefined,
		manifest: undefined as Manifest | undefined,
		stagesCompleted: 0,
		jsonlStage: 0,
		success: false,
		error: undefined as string | undefined,
	};

	// Mark every session_start fired by an inner stage as a "child" of this
	// workflow so handlers in rpiv-core and rpiv-advisor can suppress the
	// cosmetic banner that the parent session already printed. Cleared in a
	// finally so a thrown stage doesn't strand the flag.
	markChildSession();
	try {
		await runStage(ctx, 0, { cwd, runId, dag, stageIds, totalStages, state, pi: options.pi });
	} finally {
		clearChildSession();
	}
	return {
		stagesCompleted: state.stagesCompleted,
		success: state.success,
		lastArtifact: state.artifactPath,
		error: state.error,
	};
}

/**
 * Record a stage on disk and bump the in-memory counter only on a successful
 * write — keeps stage numbers in the JSONL file contiguous even if a write
 * silently fails (see `appendStage`'s boolean return).
 */
function recordStage(
	cwd: string,
	runId: string,
	stage: Omit<WorkflowStage, "stageNumber">,
	state: RunContext["state"],
): void {
	const nextStageNumber = state.jsonlStage + 1;
	if (appendStage(cwd, runId, { stageNumber: nextStageNumber, ...stage })) {
		state.jsonlStage = nextStageNumber;
	}
}

/**
 * After a stage fails, surface every artifact recorded so far so the user
 * doesn't have to grep the JSONL to see what survived.
 */
function notifyPartialArtifacts(ctx: ChainCtx, cwd: string, runId: string): void {
	const artifactPaths = readAllStages(cwd, runId)
		.filter((s) => s.artifact)
		.map((s) => `  • ${s.skill}: ${s.artifact}`)
		.join("\n");
	if (artifactPaths) {
		ctx.ui.notify(`Artifacts produced before failure:\n${artifactPaths}`, "info");
	}
}

/**
 * Record a stage as terminally failed (status, audit row, status-line clear,
 * user-visible notify, and `state.error`), then optionally invoke `onFailure`
 * for the partial-artifacts recap. The three early-exit branches in
 * `executeSession` (aborted / failed / no-artifact) all share this shape;
 * collapsing them here keeps the bookkeeping consistent and makes it harder
 * to forget a step when adding a new failure mode.
 *
 * Called on the valid ctx for this path — freshCtx for "fresh" stages,
 * curCtx for "continue" stages. The three failure modes (aborted / failed /
 * no-artifact) share this bookkeeping helper.
 */
function recordTerminalFailure(
	freshCtx: ChainCtx,
	p: ExecuteSessionParams,
	args: {
		status: "failed" | "aborted";
		notifyMsg: string;
		notifyLevel: "warning" | "error";
		errMsg: string;
		callOnFailure: boolean;
	},
): void {
	recordStage(p.cwd, p.runId, { skill: p.skill, status: args.status, ts: nowIso() }, p.state);
	freshCtx.ui.setStatus(STATUS_KEY, undefined);
	freshCtx.ui.notify(args.notifyMsg, args.notifyLevel);
	if (args.callOnFailure) p.onFailure?.(freshCtx);
	p.state.error = args.errMsg;
}

/**
 * Stop classification — what kind of terminal outcome (if any) the branch
 * shows after the agent loop finishes. Maps to the three early-exit branches
 * the stage post-processing flow handles.
 */
type StopOutcome = "ok" | "aborted" | "failed";

function classifyStopOutcome(branch: BranchEntry[]): StopOutcome {
	const stopReason = lastAssistantStopReason(branch);
	if (stopReason === "aborted") return "aborted";
	if (!hasAssistantMessage(branch) || stopReason === "error") return "failed";
	return "ok";
}

/**
 * Snapshot of the agent's output for the stage that just finished — derived
 * once from the live branch and passed into the post-processing helpers so
 * each helper has the same view of what the agent produced.
 */
interface StageOutcome {
	branch: BranchEntry[];
	artifact: string | undefined;
	stop: StopOutcome;
}

/**
 * Read the branch for this stage. Continue policies receive a transcript that
 * accumulates entries from prior stages and must be sliced by `branchOffset`;
 * fresh policies start from index 0.
 */
function readStageOutcome(ctx: ChainCtx, p: ExecuteSessionParams): StageOutcome {
	const fullBranch = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
	const branch = p.sessionPolicy === "continue" ? fullBranch.slice(p.branchOffset ?? 0) : fullBranch;
	return {
		branch,
		artifact: extractArtifactPath(branch),
		stop: classifyStopOutcome(branch),
	};
}

/**
 * Halt the chain because the agent itself stopped abnormally (ESC abort or
 * empty/errored response). Maps the `StopOutcome` to the canonical bookkeeping
 * shape `recordTerminalFailure` consumes.
 */
function recordStopFailure(ctx: ChainCtx, p: ExecuteSessionParams, stop: Exclude<StopOutcome, "ok">): void {
	if (stop === "aborted") {
		recordTerminalFailure(ctx, p, {
			status: "aborted",
			notifyMsg: MSG_STAGE_ABORTED(p.skill),
			notifyLevel: "warning",
			errMsg: `${p.skill} aborted by user (ESC)`,
			callOnFailure: true,
		});
		return;
	}
	recordTerminalFailure(ctx, p, {
		status: "failed",
		notifyMsg: MSG_STAGE_FAILED(p.skill),
		notifyLevel: "error",
		errMsg: p.errorMessage,
		callOnFailure: true,
	});
}

/** Discriminated result of `extractAndValidateManifest`. */
type ExtractionOutcome =
	| { kind: "ok"; manifest: Manifest | undefined }
	| { kind: "fatal"; message: string }
	| { kind: "validation-exhausted"; failureSummary: string };

/**
 * Run the extractor, finalize the envelope with runner-owned `meta`, then
 * run the output-validation retry loop (if the node declares a schema).
 *
 * Centralises the post-stage flow that used to be duplicated across the
 * fresh/continue branches in `executeSession`. The retry loop re-invokes
 * the extractor against the most recent branch after each agent reply, so
 * the function takes a `freshBranch` thunk rather than the static branch
 * captured in `extractorCtx`.
 */
async function extractAndValidateManifest(
	ctx: ChainCtx,
	p: ExecuteSessionParams,
	node: DagNode,
	branch: BranchEntry[],
	freshBranch: () => BranchEntry[],
): Promise<ExtractionOutcome> {
	const extractor = resolveExtractor(node);
	const successSkill = p.successSkill ?? p.skill;
	const extractorBranchOffset = p.sessionPolicy === "continue" ? undefined : p.branchOffset;

	const extractorCtx: ExtractorCtx = {
		cwd: p.cwd,
		runId: p.runId,
		stageIndex: p.stageIndex,
		state: p.state,
		branch,
		branchOffset: extractorBranchOffset,
		snapshot: p.snapshot,
		skill: successSkill,
	};

	const wrap = (payload: ExtractorPayload): Manifest =>
		finalizeManifest(payload, {
			skill: successSkill,
			stage: p.state.jsonlStage + 1,
			ts: nowIso(),
			runId: p.runId,
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
		ctx.ui.notify(MSG_VALIDATION_RETRY(p.skill, attempts), "warning");
		await sendAndAwaitIdle(ctx, formatValidationFailuresForAgent(p.skill, result.failures), {
			sessionPolicy: p.sessionPolicy,
			pi: p.pi,
		});

		const reExtract = await extractor({ ...extractorCtx, branch: freshBranch() });
		if (!reExtract.payload) {
			return {
				kind: "fatal",
				message: reExtract.fatal ?? `${p.skill}: extractor returned no manifest on retry ${attempts}`,
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

/**
 * Commit a successful stage to disk + in-memory state: dual-write artifact
 * path, update `state.manifest`, append the JSONL row. `manifest` is the
 * already-finalized envelope from `extractAndValidateManifest` (or undefined
 * for the implement-phases path that skips extraction).
 */
function persistStageSuccess(
	p: ExecuteSessionParams,
	artifact: string | undefined,
	manifest: Manifest | undefined,
): void {
	if (manifest?.artifact_path) p.state.artifactPath = manifest.artifact_path;
	else if (artifact) p.state.artifactPath = artifact;
	if (manifest) p.state.manifest = manifest;

	recordStage(
		p.cwd,
		p.runId,
		{ skill: p.successSkill ?? p.skill, artifact, status: "completed", ts: nowIso(), manifest },
		p.state,
	);
}

/**
 * Post-stage flow shared by both session policies. Runs after the agent has
 * settled. Branches on `p.node`: with a node we extract → validate → persist;
 * without (the implement-phases path) we persist the bare artifact only.
 */
async function postStage(ctx: ChainCtx, p: ExecuteSessionParams): Promise<void> {
	const outcome = readStageOutcome(ctx, p);

	if (outcome.stop !== "ok") {
		recordStopFailure(ctx, p, outcome.stop);
		return;
	}

	if (!p.node) {
		// implement-phases — no manifest extraction.
		persistStageSuccess(p, outcome.artifact, undefined);
	} else {
		const result = await extractAndValidateManifest(
			ctx,
			p,
			p.node,
			outcome.branch,
			() => ctx.sessionManager.getBranch() as unknown as BranchEntry[],
		);
		if (result.kind === "fatal") {
			recordTerminalFailure(ctx, p, {
				status: "failed",
				notifyMsg: MSG_STAGE_FAILED(p.skill),
				notifyLevel: "error",
				errMsg: result.message,
				callOnFailure: true,
			});
			return;
		}
		if (result.kind === "validation-exhausted") {
			recordTerminalFailure(ctx, p, {
				status: "failed",
				notifyMsg: MSG_VALIDATION_EXHAUSTED(p.skill),
				notifyLevel: "error",
				errMsg: ERR_VALIDATION_FAILED(p.skill, result.failureSummary),
				callOnFailure: true,
			});
			return;
		}
		persistStageSuccess(p, outcome.artifact, result.manifest);
	}

	if (p.emitCompleteOnSuccess) ctx.ui.notify(MSG_STAGE_COMPLETE(p.skill), "info");
	p.state.stagesCompleted++;
	await p.onSuccess(ctx, outcome.artifact);
}

/**
 * Spawn one session for a stage and drive the agent loop. The single
 * `sessionPolicy` switch wraps the session-creation primitive; the entire
 * post-stage flow lives in `postStage`, shared across both branches.
 *
 * Chain recursion happens inside `postStage` via `p.onSuccess`, called on the
 * ctx valid for the current stage — `freshCtx` for "fresh" stages, `curCtx`
 * for "continue" stages.
 */
async function executeSession(curCtx: ChainCtx, p: ExecuteSessionParams): Promise<void> {
	if (p.sessionPolicy === "continue") {
		await sendAndAwaitIdle(curCtx, p.prompt, { sessionPolicy: "continue", pi: p.pi });
		await postStage(curCtx, p);
		return;
	}

	const { cancelled } = await curCtx.newSession({
		withSession: async (freshCtx) => {
			await freshCtx.sendUserMessage(p.prompt);
			await postStage(freshCtx, p);
		},
	});

	if (cancelled) {
		recordStage(p.cwd, p.runId, { skill: p.skill, status: "skipped", ts: nowIso() }, p.state);
		curCtx.ui.setStatus(STATUS_KEY, undefined);
		curCtx.ui.notify(MSG_WORKFLOW_CANCELLED, "info");
		// Distinguish "user cancelled" from "workflow never started" — both
		// land in the caller as `success: false`; the error string is the
		// only signal that disambiguates the two cases.
		p.state.error = `${p.skill} cancelled by user`;
	}
}

/**
 * Build the prompt + status label + audit label for a node based on its kind.
 * Phase 1 only implements `kind: "skill"`; future variants slot in here.
 *
 * The returned `skillLabel` is what gets surfaced in the status line and the
 * JSONL audit row — for skill-kind nodes that's the underlying skill name
 * (matches pre-refactor labels), for future kinds it'll be a kind-specific
 * label derived from the node body.
 */
function dispatchNode(node: DagNode, inputForStage: string): { prompt: string; skillLabel: string } {
	switch (node.kind) {
		case "skill":
			return {
				prompt: `/skill:${node.skill} ${inputForStage}`,
				skillLabel: node.skill,
			};
		default: {
			// Last-resort guard — validateDag should have rejected unknown
			// kinds at config-load time. With only one variant in `DagNode`
			// today the TypeScript exhaustiveness check via `const x: never =
			// node` can't be expressed without an error; once chat/script
			// kinds land, add their cases and switch this default to
			// `assertNever(node)` to get type-level narrowing.
			const unknownKind = (node as { kind?: unknown }).kind;
			throw new Error(`runStage: unsupported node kind: ${String(unknownKind)}`);
		}
	}
}

/**
 * Run a single workflow stage at index `idx`, then chain into the next stage
 * (or finalize) using whichever ctx is valid inside withSession.
 */
async function runStage(curCtx: ChainCtx, idx: number, run: RunContext): Promise<void> {
	const { cwd, runId, dag, stageIds, totalStages, state } = run;

	if (idx >= stageIds.length) {
		curCtx.ui.setStatus(STATUS_KEY, undefined);
		curCtx.ui.notify(MSG_WORKFLOW_COMPLETE(state.stagesCompleted), "info");
		state.success = true;
		return;
	}

	const id = stageIds[idx]!;
	const node = dag.nodes[id];
	if (!node) {
		// validateDag should have caught this — defensive throw for runtime
		// guarantee. Bypassing validation (e.g. via test fixture) lands here.
		throw new Error(`runStage: node id "${id}" referenced by preset but missing from dag.nodes`);
	}
	const stageNumber = idx + 1;

	// Multi-phase expand: when an implement *skill* runs against a plan artifact
	// with `## Phase N:` headings, fan out one session per phase. Keyed on the
	// underlying skill name (not the node id) so any skill-node pointing at
	// "implement" gets the same behavior. Phase-iteration logic lives in
	// implement-phases.ts; we inject the runner's primitives as deps so that
	// module never imports back from runner.ts (cycle-free).
	if (node.kind === "skill" && node.skill === "implement" && state.artifactPath) {
		const phaseCount = countPhases(state.artifactPath, cwd);
		if (phaseCount > 0) {
			await runImplementPhases(curCtx, idx, 1, phaseCount, run, {
				executeSession,
				runNextStage: runStage,
			});
			return;
		}
	}

	// First stage has no prior artifact yet — fall back to the original brief
	// so /skill:<name> gets a meaningful argument.
	const inputForStage = state.artifactPath ?? state.originalInput;
	const { prompt, skillLabel } = dispatchNode(node, inputForStage);

	// Update the persistent status line — survives the `newSession` transition
	// in a way `ui.notify` does not.
	curCtx.ui.setStatus(STATUS_KEY, STATUS_STAGE(stageNumber, totalStages, skillLabel));

	// Block implement + continue — phase fanout assumes per-phase session isolation.
	if (node.kind === "skill" && node.skill === "implement" && node.sessionPolicy === "continue") {
		throw new Error(
			`runStage: implement node "${id}" cannot use sessionPolicy "continue" — ` +
				"phase fanout requires per-phase session isolation",
		);
	}

	// Validate pi is available for continue stages.
	if (node.sessionPolicy === "continue" && !run.pi) {
		throw new Error(
			`runStage: node "${id}" uses sessionPolicy "continue" but no pi (ExtensionAPI) was provided to runWorkflow`,
		);
	}

	// Compute branch offset — entries before this index belong to prior stages.
	const branchOffset =
		node.sessionPolicy === "continue"
			? (curCtx.sessionManager.getBranch() as unknown as BranchEntry[]).length
			: undefined;

	// --- Input validation (Phase 5) ---
	// `node.skill` is only present on SkillNode; narrow before access. Future
	// node kinds (chat/script) get a placeholder label until they grow real ones.
	const nodeLabel = node.kind === "skill" ? node.skill : id;

	if (node.inputSchema && state.manifest?.data !== undefined) {
		const result = validateManifestData(node.inputSchema, state.manifest.data);
		if (!result.valid) {
			const failureSummary = result.failures.map((f) => `${f.path}: ${f.message}`).join("; ");
			const prevSkill = state.manifest.meta.skill || "unknown";

			// Inline halt — same bookkeeping shape as recordTerminalFailure, but
			// using runStage's locals (curCtx, cwd, runId) so we don't need a
			// fabricated ExecuteSessionParams.
			recordStage(cwd, runId, { skill: nodeLabel, status: "failed", ts: nowIso() }, state);
			curCtx.ui.setStatus(STATUS_KEY, undefined);
			curCtx.ui.notify(MSG_INPUT_VALIDATION_FAILED(nodeLabel, prevSkill), "error");
			notifyPartialArtifacts(curCtx, cwd, runId);
			state.error = ERR_INPUT_VALIDATION_FAILED(nodeLabel, prevSkill, failureSummary);
			return;
		}
	}

	// Pre-stage snapshot (if node declares one)
	let snapshotResult: unknown;
	if (node.snapshot) {
		try {
			snapshotResult = await node.snapshot({ cwd, runId, stageIndex: idx, state, pi: run.pi });
		} catch {
			// Fail-soft: snapshot failure doesn't prevent stage execution
		}
	}

	await executeSession(curCtx, {
		cwd,
		runId,
		state,
		prompt,
		skill: skillLabel,
		errorMessage: `${skillLabel} failed`,
		emitCompleteOnSuccess: true,
		sessionPolicy: node.sessionPolicy,
		pi: run.pi,
		branchOffset,
		snapshot: snapshotResult,
		node,
		stageIndex: idx,
		onFailure: (freshCtx) => notifyPartialArtifacts(freshCtx, cwd, runId),
		onSuccess: async (freshCtx) => {
			try {
				const nextId = resolveNextStageId(dag, id, stageIds, idx, state);
				if (!nextId) {
					freshCtx.ui.setStatus(STATUS_KEY, undefined);
					freshCtx.ui.notify(MSG_WORKFLOW_COMPLETE(state.stagesCompleted), "info");
					state.success = true;
					return;
				}
				const nextIdx = stageIds.indexOf(nextId);
				if (nextIdx < 0) throw new Error(`resolveNextStageId returned "${nextId}" not in preset`);

				// Log routing decision if different from linear advance
				const linearNext = stageIds[idx + 1];
				if (nextId !== linearNext) {
					appendRoutingDecision(cwd, runId, {
						type: "routing",
						fromStage: idx + 1,
						fromNode: id,
						decision: nextId,
						ts: nowIso(),
					});
				}

				await runStage(freshCtx, nextIdx, run);
			} catch (e) {
				freshCtx.ui.setStatus(STATUS_KEY, undefined);
				state.error = e instanceof Error ? e.message : String(e);
			}
		},
	});
}
