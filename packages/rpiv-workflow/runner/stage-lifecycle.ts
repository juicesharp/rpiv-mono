/**
 * Per-stage lifecycle: resolve the stage node, run the preflight pipeline,
 * prepare the prompt + status + branchOffset, capture the extractor's
 * before-snapshot, and hand off to `runStageSession`.
 *
 * Owns the typed-throw preflight machinery (`StagePreflightError`,
 * `PreflightCheck`, `PRE_PROMPT_CHECKS`, `POST_PROMPT_CHECKS`) and the
 * six bundled preflight checks. `runStageOrRecordFailure` (runner.ts)
 * catches `StagePreflightError` and records the JSONL row.
 */

import type { NodeDef } from "../api.js";
import { notifyPartialArtifacts } from "../audit.js";
import { countPhases, runImplementPhases } from "../implement-phases.js";
import { currentArtifactPath } from "../internal-utils.js";
import {
	ERR_INPUT_VALIDATION_FAILED,
	ERR_MISSING_ARTIFACT,
	ERR_SKILL_NOT_REGISTERED,
	MSG_INPUT_VALIDATION_FAILED,
	MSG_MISSING_ARTIFACT,
	MSG_SKILL_NOT_REGISTERED,
	MSG_STAGE_THREW,
	STATUS_KEY,
	STATUS_STAGE,
} from "../messages.js";
import { runPhaseSession, runStageSession } from "../sessions/index.js";
import { readBranch } from "../transcript.js";
import type { RunContext, RunnerCtx } from "../types.js";
import { validateManifestData } from "../validate-manifest.js";
import { advanceChain } from "./chain-advance.js";

export interface ResolvedStage {
	node: NodeDef;
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
	run(stage: ResolvedStage, run: RunContext): void;
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
 * Slot ordering (load-bearing):
 *
 *   1. tryPhaseFanout            — shortcut: implement-skill expansion handled
 *                                  the stage; subsequent slots skipped.
 *   2. PRE_PROMPT_CHECKS         — preflights that don't need prompt prep.
 *      a. ensureUpstreamArtifact — halt: missing inherited artifact.
 *      b. enforceSessionInvariants — invariant: authoring-time-knowable
 *         throws (precede the registry check so the structural violation
 *         surfaces regardless of the runtime registry).
 *      c. ensureSkillRegistered  — halt: skill not registered in Pi.
 *   3. prompt + status + branchOffset prep.
 *   4. POST_PROMPT_CHECKS        — preflights gated on prompt-prep state.
 *      a. ensureInputValid       — halt: upstream manifest fails inputSchema.
 *   5. captureStageSnapshot      — extractor.before hook (must run before
 *                                  the Pi session so post-stage diffs work).
 *
 * Each `PreflightCheck` throws `StagePreflightError` on failure;
 * `runStageOrRecordFailure` catches and records the JSONL row.
 */
export async function runStage(curCtx: RunnerCtx, currentName: string, idx: number, run: RunContext): Promise<void> {
	const stage = resolveStageNode(currentName, idx, run);

	if (await tryPhaseFanout(curCtx, stage, idx, run)) return;
	for (const check of PRE_PROMPT_CHECKS) check.run(stage, run);

	const isStart = currentName === run.workflow.start;
	const inputForStage = isStart ? run.state.originalInput : currentArtifactPath(run.state)!;
	const prompt = buildPrompt(stage.skill, inputForStage);
	curCtx.ui.setStatus(STATUS_KEY, STATUS_STAGE(stage.stageNumber, run.totalStages, stage.skill));
	const branchOffset = computeBranchOffset(curCtx, stage.node);

	for (const check of POST_PROMPT_CHECKS) check.run(stage, run);

	const snapshot = await captureStageSnapshot(stage.node, idx, run);

	await runStageSession(curCtx, {
		cwd: run.cwd,
		runId: run.runId,
		state: run.state,
		prompt,
		skill: stage.skill,
		node: stage.node,
		stageIndex: idx,
		snapshot,
		pi: run.pi,
		branchOffset,
		onFailure: (freshCtx) => notifyPartialArtifacts(freshCtx, run.cwd, run.runId),
		onSuccess: (freshCtx) => advanceChain(freshCtx, currentName, idx, run),
	});
}

function resolveStageNode(currentName: string, idx: number, run: RunContext): ResolvedStage {
	const node = run.workflow.nodes[currentName];
	if (!node) {
		// validateWorkflow should catch this; defensive for tests bypassing validation.
		throw new Error(`runStage: node "${currentName}" referenced by edges but missing from workflow.nodes`);
	}
	// `skill` defaults to the record key — the common case where node id and
	// Pi skill match doesn't restate the name at the call site.
	return { node, name: currentName, stageNumber: idx + 1, skill: node.skill ?? currentName };
}

/**
 * A node that opts into `fanout: { kind: "plan-phases" }` expands into one
 * session per `## Phase N:` heading found in the inherited artifact. The
 * decision is keyed on the node's authoring surface — NOT on the skill
 * name — so the package stays skill-agnostic: any node a workflow author
 * declares with `fanout: { kind: "plan-phases" }` fans out, regardless of
 * whether the underlying skill is `implement`, `apply`, or anything else.
 * Returns true iff fanout fired — caller then returns without running the
 * single-stage path.
 */
async function tryPhaseFanout(curCtx: RunnerCtx, stage: ResolvedStage, idx: number, run: RunContext): Promise<boolean> {
	const current = currentArtifactPath(run.state);
	if (!(stage.node.fanout?.kind === "plan-phases" && current)) return false;
	const phaseCount = countPhases(current, run.cwd);
	if (phaseCount === 0) return false;
	await runImplementPhases(curCtx, idx, stage.name, stage.skill, 1, phaseCount, run, {
		runPhaseSession,
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
 * `pi` is optional on `RunWorkflowOptions`; when absent we skip the check
 * (we have no command registry to consult). Programmatic callers that opt
 * out of pi opt out of this defense too — same fail-soft posture the rest
 * of the pi-optional surface uses.
 */
function ensureSkillRegistered(stage: ResolvedStage, run: RunContext): void {
	if (!run.pi) return;

	const registered = new Set<string>();
	for (const cmd of run.pi.getCommands()) {
		if (cmd.source !== "skill") continue;
		// Pi prefixes skill-source commands with "skill:" (agent-session.js:1699);
		// match args.ts:333's slice so the comparison key is the bare skill name.
		const name = cmd.name.startsWith("skill:") ? cmd.name.slice("skill:".length) : cmd.name;
		registered.add(name);
	}
	if (registered.has(stage.skill)) return;

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
 */
function ensureUpstreamArtifact(stage: ResolvedStage, run: RunContext): void {
	if (stage.name === run.workflow.start || currentArtifactPath(run.state)) return;
	throw new StagePreflightError(
		"halt",
		stage.skill,
		MSG_MISSING_ARTIFACT(stage.skill),
		ERR_MISSING_ARTIFACT(stage.skill, stage.stageNumber),
		true,
	);
}

function enforceSessionInvariants(stage: ResolvedStage, run: RunContext): void {
	if (stage.node.fanout && stage.node.sessionPolicy === "continue") {
		const reason =
			`runStage: node "${stage.name}" cannot combine fanout with sessionPolicy "continue" — ` +
			"fanout requires per-unit session isolation";
		throw new StagePreflightError("invariant", stage.name, MSG_STAGE_THREW(stage.name, reason), reason, false);
	}
	if (stage.node.sessionPolicy === "continue" && !run.pi) {
		const reason = `runStage: node "${stage.name}" uses sessionPolicy "continue" but no pi (ExtensionAPI) was provided to runWorkflow`;
		throw new StagePreflightError("invariant", stage.name, MSG_STAGE_THREW(stage.name, reason), reason, false);
	}
}

/** Entries before this index belong to prior stages; only meaningful for continue. */
function computeBranchOffset(curCtx: RunnerCtx, node: NodeDef): number | undefined {
	if (node.sessionPolicy !== "continue") return undefined;
	return readBranch(curCtx).length;
}

function ensureInputValid(stage: ResolvedStage, run: RunContext): void {
	if (!stage.node.inputSchema || run.state.manifest?.data === undefined) return;
	const result = validateManifestData(stage.node.inputSchema, run.state.manifest.data);
	if (result.valid) return;

	const failureSummary = result.failures.map((f) => `${f.path}: ${f.message}`).join("; ");
	const prevSkill = run.state.manifest.meta.skill || "unknown";
	throw new StagePreflightError(
		"halt",
		stage.skill,
		MSG_INPUT_VALIDATION_FAILED(stage.skill, prevSkill),
		ERR_INPUT_VALIDATION_FAILED(stage.skill, prevSkill, failureSummary),
		true,
	);
}

async function captureStageSnapshot(node: NodeDef, idx: number, run: RunContext): Promise<unknown> {
	const before = node.extractor?.before;
	if (!before) return undefined;
	try {
		return await before({
			cwd: run.cwd,
			runId: run.runId,
			stageIndex: idx,
			state: run.state,
			pi: run.pi,
		});
	} catch {
		// Snapshot failure doesn't prevent stage execution.
		return undefined;
	}
}

const PRE_PROMPT_CHECKS: readonly PreflightCheck[] = [
	{ name: "ensureUpstreamArtifact", kind: "halt", run: ensureUpstreamArtifact },
	{ name: "enforceSessionInvariants", kind: "invariant", run: enforceSessionInvariants },
	{ name: "ensureSkillRegistered", kind: "halt", run: ensureSkillRegistered },
];

const POST_PROMPT_CHECKS: readonly PreflightCheck[] = [
	{ name: "ensureInputValid", kind: "halt", run: ensureInputValid },
];
