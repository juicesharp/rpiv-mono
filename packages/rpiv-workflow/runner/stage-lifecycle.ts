/**
 * Per-stage lifecycle: resolve the stage def, run the preflight pipeline,
 * prepare the prompt + status + branchOffset, capture the outcome's
 * snapshot, and hand off to `runStageSession`.
 *
 * Owns the typed-throw preflight machinery (`StagePreflightError`,
 * `PreflightCheck`, `PRE_PROMPT_CHECKS`, `POST_PROMPT_CHECKS`) and the
 * six bundled preflight checks. `runStageOrRecordFailure` (runner.ts)
 * catches `StagePreflightError` and records the JSONL row.
 */

import type { StageDef } from "../api.js";
import { auditCtxFor, notifyPartialArtifacts, recordTerminalFailure, runIdentityOf } from "../audit.js";
import { effectiveLoopOf } from "../control-flow.js";
import { currentPrimaryArtifact, resolveSkill, resolveStagePrompt, stageEntryArgs } from "../internal-utils.js";
import type { Judge } from "../judge.js";
import { skillStageRef } from "../lifecycle.js";
import { freshCursor, type LoopDeps, type LoopEntry, runLoop } from "../loop.js";
import {
	ERR_LOOP_CAP_HALT,
	ERR_MISSING_ARTIFACT,
	ERR_MISSING_NAMED_READ,
	ERR_SKILL_NOT_REGISTERED,
	ERR_VERIFY_FAILED,
	MSG_LOOP_CAP_HALT,
	MSG_MISSING_ARTIFACT,
	MSG_MISSING_NAMED_READ,
	MSG_SKILL_NOT_REGISTERED,
	MSG_STAGE_THREW,
	MSG_VERIFY_FAILED,
	STATUS_KEY,
	STATUS_STAGE,
} from "../messages.js";
import { runStageSession } from "../sessions/index.js";
import { readBranch } from "../transcript.js";
import type { RunContext, WorkflowHostContext } from "../types.js";
import { advanceChain } from "./chain-advance.js";
import { ensureContractInputValid, ensureInputValid } from "./input-validation.js";
import { lifecycleCtxFor } from "./runner.js";
import { runScript } from "./script-stage.js";

export interface ResolvedStage {
	def: StageDef;
	name: string;
	/** 1-based; for status line + audit row. */
	stageNumber: number;
	/** Label written to JSONL + the status line. */
	skill: string;
}

/**
 * Thrown by a `PreflightCheck` on failure; carries the recorded-row
 * attribution + notify/err messages so `runStageOrRecordFailure` can land
 * a uniform JSONL row regardless of which slot tripped.
 *
 * `kind` annotates the violation class for diagnostics only — control
 * flow at the catch site is uniform:
 *   - `"halt"`     — runtime-state failure (skill not registered, missing
 *                    upstream artifact, schema mismatch).
 *   - `"invariant"` — authoring-time-knowable violation that
 *                    `validateWorkflow` should reject at load. A throw
 *                    here means validation was bypassed or the rule lives
 *                    only in the runner (continue-without-pi).
 */
export class StagePreflightError extends Error {
	constructor(
		public readonly kind: "halt" | "invariant",
		public readonly skill: string,
		public readonly notifyMsg: string,
		public readonly errMsg: string,
		public readonly notifyPartial: boolean,
	) {
		super(errMsg);
		this.name = "StagePreflightError";
	}
}

interface PreflightCheck {
	name: string;
	kind: "halt" | "invariant";
	/**
	 * Checks may be sync (`enforceSessionInvariants`, `ensureSkillRegistered`,
	 * `ensureUpstreamArtifact`) or async (`ensureInputValid` once schemas may
	 * be async). `runStage` awaits the return value, so sync checks pay only
	 * one microtask and async checks (filesystem-backed, registry-backed,
	 * async-by-default schema libs) round-trip cleanly.
	 */
	run(stage: ResolvedStage, run: RunContext): void | Promise<void>;
}

/**
 * Builds the `/skill:<name> <args>` line sent into the session. The audit
 * label (which used to round-trip through here) is read off `stage.skill`
 * by the caller — single source.
 */
function buildPrompt(skill: string, inputForStage: string): string {
	return `/skill:${skill} ${inputForStage}`;
}

/**
 * The arg string the stage's `/skill:<name> <args>` prompt carries — a thin
 * wrapper over the `stageEntryArgs` authority (internal-utils.ts), which the
 * resume fold also consumes at loop-generation open so live and resume can't
 * drift. The preflights (`ensureUpstreamArtifact` / `ensureNamedReads`)
 * guarantee every projection input on this path, so the authority's
 * `undefined` arm is unreachable here; the `!` is safe.
 */
export function inputForStage(stage: ResolvedStage, run: RunContext): string {
	return stageEntryArgs(stage.def, stage.name, run.workflow.start, run.state)!;
}

/**
 * Slot ordering (load-bearing):
 *
 *   1. tryLoop                   — shortcut: a `loop`-field stage expands into
 *                                  one session per unit through the ONE driver
 *                                  (loop.ts); subsequent slots skipped for this
 *                                  stage. A push loop whose unit source returned
 *                                  an empty list falls through to the
 *                                  single-stage path (return false).
 *   2. PRE_PROMPT_CHECKS         — preflights that don't need prompt prep.
 *      a. ensureUpstreamArtifact — halt: missing inherited artifact.
 *      b. enforceSessionInvariants — invariant: authoring-time-knowable
 *         throws (precede the registry check so the structural violation
 *         surfaces regardless of the runtime registry).
 *      c. ensureSkillRegistered  — halt: skill not registered in Pi.
 *   3. prompt + status + branchOffset prep.
 *   4. POST_PROMPT_CHECKS        — preflights gated on prompt-prep state.
 *      a. ensureInputValid       — halt: upstream output fails inputSchema.
 *   5. captureStageSnapshot      — outcome.collector.snapshot hook (must run
 *                                  before the Pi session so post-stage diffs work).
 *
 * Each `PreflightCheck` throws `StagePreflightError` on failure;
 * `runStageOrRecordFailure` catches and records the JSONL row.
 */
export async function runStage(
	curCtx: WorkflowHostContext,
	currentName: string,
	idx: number,
	run: RunContext,
): Promise<void> {
	const stage = resolveStage(currentName, idx, run);

	// Unit-loop driver: checked FIRST. A `loop`-field stage runs through the ONE
	// driver (loop.ts) — one session per unit.
	if (await tryLoop(curCtx, stage, idx, run)) return;

	// Script stages (`stage.def.run` set) skip the entire skill pipeline —
	// no `/skill:<name>` prompt to build, no skill-registry check, no
	// session to open, no outcome/collector to snapshot. Input-schema
	// validation still applies (`ensureInputValid` runs upstream output
	// against `inputSchema` if declared); the script-stage runner owns
	// its own status line + lifecycle fires from here.
	if (stage.def.run) {
		await ensureInputValid(stage, run);
		await runScript(curCtx, stage, idx, run);
		return;
	}

	for (const check of PRE_PROMPT_CHECKS) await check.run(stage, run);

	// Dispatch: a `prompt` stage sends author-owned raw text (resolved by the
	// shared `resolveStagePrompt` authority — the loop driver's round-0 producer
	// uses the same resolver); a skill stage sends `/skill:<name>
	// <inputForStage>`. `stage.skill` already equals the record key for a
	// prompt stage (it cannot set an explicit skill — load validation forbids
	// it), so the status/session/audit labels are correct for both without a
	// separate label. A PromptFn throw propagates to
	// `runStageOrRecordFailure`, which records a terminal failure.
	const prompt =
		stage.def.prompt !== undefined
			? await resolveStagePrompt(stage.def.prompt, run.cwd, run.state)
			: buildPrompt(stage.skill, inputForStage(stage, run));
	curCtx.ui.setStatus(STATUS_KEY, STATUS_STAGE(stage.stageNumber, run.totalStages, stage.skill));
	const branchOffset = computeBranchOffset(curCtx, stage.def);

	for (const check of POST_PROMPT_CHECKS) await check.run(stage, run);

	const snapshot = await captureStageSnapshot(stage.def, idx, run);

	// onStageStart fires after preflight, before the Pi session opens.
	await run.lifecycle.fire(
		curCtx,
		"onStageStart",
		skillStageRef(stage.name, stage.stageNumber, stage.skill),
		lifecycleCtxFor(run),
	);

	await runStageSession(curCtx, {
		cwd: run.cwd,
		runId: run.runId,
		state: run.state,
		prompt,
		stageName: stage.name,
		skill: stage.skill,
		lifecycle: run.lifecycle,
		runIdentity: runIdentityOf(run),
		stage: stage.def,
		skillContracts: run.skillContracts,
		stageIndex: idx,
		snapshot,
		continueHost: run.continueHost,
		branchOffset,
		onFailure: (freshCtx) => notifyPartialArtifacts(freshCtx, run.cwd, run.runId),
		onSuccess: (freshCtx) => advanceChain(freshCtx, currentName, idx, run),
	});
}

function resolveStage(currentName: string, idx: number, run: RunContext): ResolvedStage {
	const def = run.workflow.stages[currentName];
	if (!def) {
		// validateWorkflow should catch this; defensive for tests bypassing validation.
		throw new Error(`runStage: stage "${currentName}" referenced by edges but missing from workflow.stages`);
	}
	// `skill` defaults to the record key; `resolveSkill` is the shared derivation
	// the load-time contract lookups also use, so runtime and load can't disagree.
	return { def, name: currentName, stageNumber: idx + 1, skill: resolveSkill(def, currentName) };
}

/**
 * A stage with `def.loop` expands into one session per unit through the ONE
 * driver. Returns true iff the loop fired; a push loop whose unit source
 * returned an empty list falls through to the single-stage path (return
 * false) — that path runs its own preflights, so e.g. a missing named read
 * still halts with the targeted message (today's consumer contract).
 *
 * Preflights run UNIFORMLY here (the old shortcuts bypassed them: a ≥1-unit
 * fanout ran none; iterate ran none; assess re-ran two inline):
 *   - continue guard (one rule — runtime mirror of load validation);
 *   - ensureNamedReads + ensureSkillRegistered for ALL loops (every loop's
 *     units dispatch `/skill:<skill>`, and generators read declared channels);
 *   - ensureUpstreamArtifact for ASSESS ONLY — the round-0 producer arg is
 *     the one loop input that consumes the rolling primary (fanout/iterate
 *     unit prompts are author-built; an entry-point loop with no primary is
 *     legal for them, as today);
 *   - judge-skill registry check for any loop carrying a `.skill` judge.
 *
 * Capture semantics (pinned): `entryArtifact`, `entryArgs`, and `entryPair`
 * are frozen HERE, before unit 1; per-unit snapshots are captured by the
 * driver immediately before each unit's session.
 *
 * A `verify`-bearing stage enters here too (the desugar — `effectiveLoopOf`);
 * its onLoopStart reports `kind: "verify"` so listeners aren't told it's an
 * assess loop.
 *
 * A prompt-dispatch assess/verify stage also enters here: the skill-registry
 * and upstream-artifact preflights already skip prompt stages, and its
 * `entryArgs` freezes to `""` (the `stageEntryArgs` prompt arm) — the round-0
 * message is the stage's own `prompt`, resolved by the driver at dispatch.
 */
async function tryLoop(
	curCtx: WorkflowHostContext,
	stage: ResolvedStage,
	idx: number,
	run: RunContext,
): Promise<boolean> {
	const loop = effectiveLoopOf(stage.def);
	if (!loop) return false;

	if (stage.def.sessionPolicy === "continue") {
		const reason =
			`runStage: stage "${stage.name}" cannot combine loop with sessionPolicy "continue" — ` +
			"each unit requires an isolated session";
		throw new StagePreflightError("invariant", stage.name, MSG_STAGE_THREW(stage.name, reason), reason, false);
	}

	// Push loops compute units FIRST (a throw — incl. a consumer haltPreflight —
	// propagates with its own attribution; empty ⇒ single-stage fall-through).
	let units: readonly import("../api.js").Unit[] | undefined;
	if (loop.kind === "fanout") {
		units = await loop.units({ cwd: run.cwd, artifact: currentPrimaryArtifact(run.state), state: run.state });
		if (units.length === 0) return false;
	}

	ensureNamedReads(stage, run);
	ensureSkillRegistered(stage, run);
	if (loop.kind === "assess") {
		ensureUpstreamArtifact(stage, run);
		ensureJudgeSkillRegistered(loop.judge, stage, run);
	}

	const entryArgs = loop.kind === "assess" ? inputForStage(stage, run) : "";
	const entryArtifact = currentPrimaryArtifact(run.state);
	const entryPair = { output: run.state.output, primaryArtifact: run.state.primaryArtifact };

	const presentedKind = stage.def.verify ? ("verify" as const) : loop.kind;
	const ref = skillStageRef(stage.name, stage.stageNumber, stage.skill);
	await run.lifecycle.fire(curCtx, "onStageStart", ref, lifecycleCtxFor(run));
	await run.lifecycle.fire(
		curCtx,
		"onLoopStart",
		ref,
		{ kind: presentedKind, ...(units ? { units } : {}) },
		lifecycleCtxFor(run),
	);

	await runLoop(
		curCtx,
		{
			stageIdx: idx,
			name: stage.name,
			skill: stage.skill,
			def: stage.def,
			loop,
			entryArtifact,
			entryArgs,
			entryPair,
			units,
		},
		freshCursor(),
		run,
		buildLoopDeps(),
	);
	return true;
}

/**
 * Registry preflight for a Judge carrying `.skill` — `ensureSkillRegistered`
 * only inspects `stage.skill`. Fail-soft when `registeredSkills` is undefined
 * (hostless embedder). Generalized: any future Judge site (verify, panel)
 * calls the same helper.
 */
export function ensureJudgeSkillRegistered(judge: Judge, stage: ResolvedStage, run: RunContext): void {
	if (judge.skill === undefined || run.registeredSkills === undefined) return;
	if (run.registeredSkills.has(judge.skill)) return;
	throw new StagePreflightError(
		"halt",
		judge.skill,
		MSG_SKILL_NOT_REGISTERED(judge.skill),
		ERR_SKILL_NOT_REGISTERED(judge.skill, stage.stageNumber),
		true,
	);
}

/**
 * THE loop deps bundle — built identically by the live path and resume
 * (`selectResumeEntry`), so the two can't drift (the old per-primitive
 * bundles were rebuilt by hand in both places).
 */
export function buildLoopDeps(): LoopDeps {
	return {
		runStageSession,
		advanceAfter: (freshCtx, name, completedIdx, ctx) => advanceChain(freshCtx, name, completedIdx, ctx),
		captureSnapshot: (def, i, r) => captureStageSnapshot(def, i, r),
		haltLoop,
	};
}

/**
 * Terminal failure when a loop's `onCap: "halt"` trips. Verify stages get
 * the verification-failed wording — the author declared a post-condition,
 * not a loop, so "loop cap exceeded" would misattribute the failure.
 */
export async function haltLoop(
	curCtx: WorkflowHostContext,
	run: RunContext,
	e: Pick<LoopEntry, "name" | "def">,
	count: number,
	cap: number,
): Promise<void> {
	const args = e.def.verify
		? {
				status: "failed" as const,
				notifyMsg: MSG_VERIFY_FAILED(e.name, cap),
				notifyLevel: "error" as const,
				errMsg: ERR_VERIFY_FAILED(e.name, cap),
			}
		: {
				status: "failed" as const,
				notifyMsg: MSG_LOOP_CAP_HALT(count, cap),
				notifyLevel: "error" as const,
				errMsg: ERR_LOOP_CAP_HALT(count, cap),
			};
	await recordTerminalFailure(curCtx, auditCtxFor(run, e.name, e.name), args);
}

/**
 * Verify `stage.skill` resolves to a Pi-registered skill BEFORE the prompt
 * is dispatched. The workflow runner emits `/skill:<name>` text via
 * `sendUserMessage` (the programmatic path), which goes through
 * `prompt({expandPromptTemplates: false})` — meaning Pi's built-in
 * `_expandSkillCommand` is skipped and `rpiv-args` is the ONLY expander.
 * If the skill isn't registered, `rpiv-args` returns `{action:"continue"}`
 * and the raw `/skill:<name> …` text reaches the LLM as a bare user-message
 * imperative outside the `<skill>...</skill>` contract — silent LLM-prompt
 * corruption with no diagnostic. Catching it here turns that silent failure
 * into a properly-attributed stage halt.
 *
 * Reads the snapshot in `run.registeredSkills` rather than calling
 * `host.getCommands()` mid-run, because Pi marks the `WorkflowHost` handle
 * stale on the first `ctx.newSession()` — a registry call after research's
 * fresh session opens throws "extension ctx is stale". The snapshot is
 * built once in `runWorkflow` before any session replaces the outer ctx.
 *
 * `registeredSkills` is undefined when the embedder didn't pass a host —
 * skip the check (same fail-soft posture as the rest of the host-optional
 * surface).
 */
function ensureSkillRegistered(stage: ResolvedStage, run: RunContext): void {
	// A prompt stage dispatches raw text, not /skill:<name> — there is no skill
	// to verify. (Mirrors how the script-stage path skips this check entirely.)
	if (stage.def.prompt !== undefined) return;
	if (!run.registeredSkills) return;
	if (run.registeredSkills.has(stage.skill)) return;

	throw new StagePreflightError(
		"halt",
		stage.skill,
		MSG_SKILL_NOT_REGISTERED(stage.skill),
		ERR_SKILL_NOT_REGISTERED(stage.skill, stage.stageNumber),
		true,
	);
}

/**
 * The start node consumes the user's brief; subsequent stages MUST inherit
 * an upstream artifactPath. Falling back to originalInput past the start
 * would silently hand a downstream skill the raw feature description.
 *
 * Two opt-outs skip the check:
 *   - `inheritsArtifacts: false` (authored via `terminal()`) — stage consumes
 *     `originalInput` by design.
 *   - `reads: [...]` — stage builds its prompt from the named-publish
 *     registry instead of the rolling primary slot; `ensureNamedReads`
 *     enforces its own coverage rule.
 */
function ensureUpstreamArtifact(stage: ResolvedStage, run: RunContext): void {
	if (stage.name === run.workflow.start) return;
	if (stage.def.inheritsArtifacts === false) return;
	if (stage.def.reads?.length) return;
	// A prompt stage builds its own text and never consumes the rolling primary
	// as an arg, so it doesn't require an upstream artifact (a continue chat
	// turn typically leans on session context, not a handle).
	if (stage.def.prompt !== undefined) return;
	if (currentPrimaryArtifact(run.state)) return;
	throw new StagePreflightError(
		"halt",
		stage.skill,
		MSG_MISSING_ARTIFACT(stage.skill),
		ERR_MISSING_ARTIFACT(stage.skill, stage.stageNumber),
		true,
	);
}

/**
 * A stage declaring `reads: [...]` must find every name filled in
 * `state.named` before the prompt is built. `validateWorkflow` already
 * confirms the names CAN exist (some upstream stage publishes them); this
 * catches the runtime path where the producer hasn't fired yet — e.g.
 * the stage was placed before its producer in the edge graph.
 */
function ensureNamedReads(stage: ResolvedStage, run: RunContext): void {
	const reads = stage.def.reads;
	if (!reads?.length) return;
	for (const name of reads) {
		if (run.state.named[name]?.length) continue;
		throw new StagePreflightError(
			"halt",
			stage.skill,
			MSG_MISSING_NAMED_READ(stage.skill, name),
			ERR_MISSING_NAMED_READ(stage.skill, name, stage.stageNumber),
			true,
		);
	}
}

function enforceSessionInvariants(stage: ResolvedStage, run: RunContext): void {
	if (stage.def.sessionPolicy === "continue" && !run.continueHost) {
		const reason = `runStage: stage "${stage.name}" uses sessionPolicy "continue" but no workflow host was provided to runWorkflow`;
		throw new StagePreflightError("invariant", stage.name, MSG_STAGE_THREW(stage.name, reason), reason, false);
	}
}

/** Entries before this index belong to prior stages; only meaningful for continue. */
function computeBranchOffset(curCtx: WorkflowHostContext, def: StageDef): number | undefined {
	if (def.sessionPolicy !== "continue") return undefined;
	return readBranch(curCtx).length;
}

export async function captureStageSnapshot(def: StageDef, idx: number, run: RunContext): Promise<unknown> {
	const snapshot = def.outcome?.collector.snapshot;
	if (!snapshot) return undefined;
	try {
		return await snapshot({
			cwd: run.cwd,
			runId: run.runId,
			stageIndex: idx,
			state: run.state,
		});
	} catch {
		// Snapshot capture failure doesn't prevent stage execution.
		return undefined;
	}
}

const PRE_PROMPT_CHECKS: readonly PreflightCheck[] = [
	{ name: "ensureUpstreamArtifact", kind: "halt", run: ensureUpstreamArtifact },
	{ name: "ensureNamedReads", kind: "halt", run: ensureNamedReads },
	{ name: "enforceSessionInvariants", kind: "invariant", run: enforceSessionInvariants },
	{ name: "ensureSkillRegistered", kind: "halt", run: ensureSkillRegistered },
];

const POST_PROMPT_CHECKS: readonly PreflightCheck[] = [
	{ name: "ensureInputValid", kind: "halt", run: ensureInputValid },
	{ name: "ensureContractInputValid", kind: "halt", run: ensureContractInputValid },
];
