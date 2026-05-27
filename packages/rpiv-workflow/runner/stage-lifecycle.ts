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
import { notifyPartialArtifacts } from "../audit.js";
import { runFanout } from "../fanout.js";
import { handleToString } from "../handle.js";
import { currentPrimaryArtifact, withTimeout } from "../internal-utils.js";
import { skillStageRef } from "../lifecycle.js";
import {
	ERR_INPUT_VALIDATION_FAILED,
	ERR_MISSING_ARTIFACT,
	ERR_MISSING_NAMED_READ,
	ERR_SCHEMA_TIMEOUT,
	ERR_SKILL_NOT_REGISTERED,
	MSG_INPUT_VALIDATION_FAILED,
	MSG_MISSING_ARTIFACT,
	MSG_MISSING_NAMED_READ,
	MSG_SKILL_NOT_REGISTERED,
	MSG_STAGE_THREW,
	STATUS_KEY,
	STATUS_STAGE,
} from "../messages.js";
import { runFanoutSession, runStageSession } from "../sessions/index.js";
import { readBranch } from "../transcript.js";
import type { RunContext, RunnerCtx } from "../types.js";
import {
	DEFAULT_VALIDATION_RETRY_TIMEOUT_MS,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
	type ValidationResult,
	validateOutputData,
} from "../validate-output.js";
import { advanceChain } from "./chain-advance.js";
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
 * The arg string the stage's `/skill:<name> <args>` prompt carries. Four
 * cases (checked in order):
 *   1. The start stage always receives `originalInput` (the user's brief).
 *   2. A stage opting out of inheritance (`inheritsArtifacts: false`, i.e.
 *      authored via `terminal()`) also receives `originalInput` — the
 *      `ensureUpstreamArtifact` preflight is bypassed for the same opt-out.
 *   3. A stage with `reads: [...]` receives a labelled multi-flag form:
 *      `--<name1> <handle1> --<name2> <handle2> …`. Each name resolves
 *      against `state.named[name].at(-1)` (the latest entry). When that
 *      entry's `artifacts` array carries multiple handles, the flag
 *      repeats: `--<name> <h1> --<name> <h2>`. The `ensureNamedReads`
 *      preflight has already verified every name resolves; the `!` is safe.
 *   4. Otherwise: the upstream primary artifact's handle string. The
 *      `ensureUpstreamArtifact` preflight guarantees the slot is set; the
 *      `!` is safe.
 */
function inputForStage(stage: ResolvedStage, run: RunContext): string {
	const isStart = stage.name === run.workflow.start;
	if (isStart) return run.state.originalInput;
	if (stage.def.inheritsArtifacts === false) return run.state.originalInput;
	if (stage.def.reads?.length) return formatNamedInputs(stage.def.reads, run);
	return handleToString(currentPrimaryArtifact(run.state)!.handle);
}

/**
 * Build the labelled-flag prompt body for a `reads:`-style stage. Iterates
 * declared names in author-supplied order, resolves each to the latest
 * `Output` accumulated in `state.named`, and emits one `--<name> <handle>`
 * pair per artifact in that output (so multi-artifact stages get
 * flag-repetition rather than space-collision).
 *
 * Pre-condition: every name resolves (enforced by `ensureNamedReads`).
 */
function formatNamedInputs(names: ReadonlyArray<string>, run: RunContext): string {
	const parts: string[] = [];
	for (const name of names) {
		const latest = run.state.named[name]?.at(-1);
		if (!latest) continue; // unreachable given preflight; defensive
		for (const artifact of latest.artifacts) {
			parts.push(`--${name}`, handleToString(artifact.handle));
		}
	}
	return parts.join(" ");
}

/**
 * Slot ordering (load-bearing):
 *
 *   1. tryFanout                 — shortcut: the stage's FanoutFn returned
 *                                  units, runner ran them; subsequent
 *                                  slots skipped for this stage.
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
export async function runStage(curCtx: RunnerCtx, currentName: string, idx: number, run: RunContext): Promise<void> {
	const stage = resolveStage(currentName, idx, run);

	if (await tryFanout(curCtx, stage, idx, run)) return;

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

	const prompt = buildPrompt(stage.skill, inputForStage(stage, run));
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
		runIdentity: { workflow: run.workflow.name, totalStages: run.totalStages, trigger: run.trigger },
		stage: stage.def,
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
	// `skill` defaults to the record key — the common case where stage id and
	// Pi skill match doesn't restate the name at the call site.
	return { def, name: currentName, stageNumber: idx + 1, skill: def.skill ?? currentName };
}

/**
 * A stage that opts into fanout via `StageDef.fanout` expands into one Pi
 * session per unit returned by the user's `FanoutFn`. The runner is
 * convention-agnostic: it never inspects the artifact, never counts
 * headings, never names a skill — every per-unit decision lives in the
 * FanoutFn. Returns true iff fanout fired (i.e. at least one unit was
 * returned) — caller then returns without running the single-stage path.
 */
async function tryFanout(curCtx: RunnerCtx, stage: ResolvedStage, idx: number, run: RunContext): Promise<boolean> {
	if (!stage.def.fanout) return false;
	const primary = currentPrimaryArtifact(run.state);
	const units = await stage.def.fanout({
		cwd: run.cwd,
		artifact: primary,
		state: run.state,
	});
	if (units.length === 0) return false;
	// Fire both onStageStart (the parent fanout stage IS starting) and
	// onFanoutStart so listeners receive a coherent stream: every stage gets
	// onStageStart, fanout stages additionally get onFanoutStart with the
	// unit list.
	const ref = skillStageRef(stage.name, stage.stageNumber, stage.skill);
	await run.lifecycle.fire(curCtx, "onStageStart", ref, lifecycleCtxFor(run));
	await run.lifecycle.fire(curCtx, "onFanoutStart", ref, units, lifecycleCtxFor(run));
	await runFanout(curCtx, idx, stage.name, stage.skill, 1, units, run, {
		runFanoutSession,
		advanceAfter: (freshCtx, name, completedIdx, ctx) => advanceChain(freshCtx, name, completedIdx, ctx),
	});
	return true;
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
	if (stage.def.fanout && stage.def.sessionPolicy === "continue") {
		const reason =
			`runStage: stage "${stage.name}" cannot combine fanout with sessionPolicy "continue" — ` +
			"fanout requires per-unit session isolation";
		throw new StagePreflightError("invariant", stage.name, MSG_STAGE_THREW(stage.name, reason), reason, false);
	}
	if (stage.def.sessionPolicy === "continue" && !run.continueHost) {
		const reason = `runStage: stage "${stage.name}" uses sessionPolicy "continue" but no workflow host was provided to runWorkflow`;
		throw new StagePreflightError("invariant", stage.name, MSG_STAGE_THREW(stage.name, reason), reason, false);
	}
}

/** Entries before this index belong to prior stages; only meaningful for continue. */
function computeBranchOffset(curCtx: RunnerCtx, def: StageDef): number | undefined {
	if (def.sessionPolicy !== "continue") return undefined;
	return readBranch(curCtx).length;
}

async function ensureInputValid(stage: ResolvedStage, run: RunContext): Promise<void> {
	if (!stage.def.inputSchema || run.state.output?.data === undefined) return;
	const timeoutMs = clampValidateTimeoutMs(stage.def.validateTimeoutMs);
	const prevSkill = run.state.output.meta.stage || "unknown";

	let result: ValidationResult;
	try {
		result = await withTimeout(
			Promise.resolve(validateOutputData(stage.def.inputSchema, run.state.output.data)),
			timeoutMs,
			ERR_SCHEMA_TIMEOUT("inputSchema", timeoutMs),
		);
	} catch (e) {
		// Async schema rejected, or schema timed out. Same fatal-extraction
		// posture as the outputSchema seam — surface as a halt-class
		// StagePreflightError so the row attribution and notify message
		// match every other preflight failure.
		const reason = e instanceof Error ? e.message : String(e);
		throw new StagePreflightError(
			"halt",
			stage.skill,
			MSG_INPUT_VALIDATION_FAILED(stage.skill, prevSkill),
			ERR_INPUT_VALIDATION_FAILED(stage.skill, prevSkill, reason),
			true,
		);
	}

	if (result.valid) return;

	const failureSummary = result.failures.map((f) => `${f.path}: ${f.message}`).join("; ");
	throw new StagePreflightError(
		"halt",
		stage.skill,
		MSG_INPUT_VALIDATION_FAILED(stage.skill, prevSkill),
		ERR_INPUT_VALIDATION_FAILED(stage.skill, prevSkill, failureSummary),
		true,
	);
}

/**
 * Mirror of the clamp in extraction.ts:retryUntilValid. Same defense-in-depth
 * posture: validateWorkflow rejects out-of-range values at load, but
 * programmatic callers that embed runWorkflow can bypass it; clamping here
 * means a misconfigured stage degrades to the spec-default behavior instead
 * of firing a 100 ms timeout before a real I/O probe gets a chance to settle.
 */
function clampValidateTimeoutMs(raw: number | undefined): number {
	return Math.max(
		MIN_VALIDATION_RETRY_TIMEOUT_MS,
		Math.min(raw ?? DEFAULT_VALIDATION_RETRY_TIMEOUT_MS, MAX_VALIDATION_RETRY_TIMEOUT_MS),
	);
}

async function captureStageSnapshot(def: StageDef, idx: number, run: RunContext): Promise<unknown> {
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
];
