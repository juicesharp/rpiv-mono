/**
 * Runtime preflights for the per-stage pipeline — every check that gates a
 * stage BEFORE its body dispatches. Each check throws `StagePreflightError`
 * on failure; `runStageOrRecordFailure` (run-stage.ts) catches and
 * records the JSONL row. Schema-backed input validation (the two POST-prompt
 * checks) lives beside this in `input-validation.ts`.
 *
 * Checks switch on the resolved `dispatch` mode (resolve-stage.ts) instead
 * of re-probing `def.prompt` — the slot-priority rule lives in one place.
 */

import { currentPrimaryArtifact } from "../chain-state.js";
import { type AnyJudge, panelMembers } from "../judge.js";
import {
	FAIL_MISSING_ARTIFACT,
	FAIL_MISSING_NAMED_READ,
	FAIL_SKILL_NOT_REGISTERED,
	MSG_STAGE_THREW,
} from "../messages.js";
import { readName } from "../stage-def.js";
import type { RunContext } from "../types.js";
import { StagePreflightError } from "./errors.js";
import type { ResolvedStage } from "./resolve-stage.js";

/**
 * The skill-path preflight sequence, in its load-bearing order:
 *   1. ensureUpstreamArtifact   — halt: missing inherited artifact.
 *   2. ensureNamedReads         — halt: a `reads:` name has no published entry.
 *   3. enforceSessionInvariants — invariant: authoring-time-knowable throws
 *      (precede the registry check so the structural violation surfaces
 *      regardless of the runtime registry).
 *   4. ensureSkillRegistered    — halt: skill not registered in Pi.
 * (Input-schema validation runs after prompt prep — see input-validation.ts.)
 */
export function runSingleStagePreflights(stage: ResolvedStage, run: RunContext): void {
	ensureUpstreamArtifact(stage, run);
	ensureNamedReads(stage, run);
	enforceSessionInvariants(stage, run);
	ensureSkillRegistered(stage, run);
}

/**
 * The loop ⊕ continue exclusion — runtime mirror of load validation; checked
 * BEFORE the push loop's unit compute (which is itself pinned to run before
 * the remaining loop preflights — a `units()` throw carries its own
 * attribution and must beat any other preflight's halt).
 */
export function ensureLoopNotContinue(stage: ResolvedStage): void {
	if (stage.def.sessionPolicy !== "continue") return;
	const reason =
		`runStage: stage "${stage.name}" cannot combine loop with sessionPolicy "continue" — ` +
		"each unit requires an isolated session";
	throw new StagePreflightError("invariant", stage.name, MSG_STAGE_THREW(stage.name, reason), reason, false);
}

/**
 * Loop-stage preflights, run UNIFORMLY for every loop kind (the old
 * shortcuts bypassed them: a ≥1-unit fanout ran none; iterate ran none;
 * assess re-ran two inline):
 *   - ensureNamedReads + ensureSkillRegistered for ALL loops (every loop's
 *     units dispatch `/skill:<skill>`, and generators read declared channels);
 *   - ensureUpstreamArtifact for ASSESS ONLY — the round-0 producer arg is
 *     the one loop input that consumes the rolling primary (fanout/iterate
 *     unit prompts are author-built; an entry-point loop with no primary is
 *     legal for them);
 *   - judge-skill registry check for any loop carrying a `.skill` judge.
 */
export function runLoopPreflights(stage: ResolvedStage, run: RunContext): void {
	const loop = stage.loop!; // mode === "loop" ⇒ resolveStage set it
	ensureNamedReads(stage, run);
	ensureSkillRegistered(stage, run);
	if (loop.kind === "assess") {
		ensureUpstreamArtifact(stage, run);
		ensureJudgeSkillRegistered(loop.judge, stage, run);
	}
}

/**
 * Registry preflight for a judge SLOT (`AnyJudge`) — walks `panelMembers`, so a
 * single judge checks its one `.skill` and a panel checks EVERY member's skill
 * (the first unregistered member halts). `ensureSkillRegistered` only inspects
 * `stage.skill`; this covers the judge dispatch. Fail-soft when
 * `registeredSkills` is undefined (hostless embedder); members without a
 * `.skill` (prompt judges) are skipped.
 */
export function ensureJudgeSkillRegistered(judge: AnyJudge, stage: ResolvedStage, run: RunContext): void {
	if (run.registeredSkills === undefined) return;
	for (const member of panelMembers(judge)) {
		if (member.skill === undefined) continue;
		if (run.registeredSkills.has(member.skill)) continue;
		const f = FAIL_SKILL_NOT_REGISTERED(member.skill, stage.stageNumber);
		throw new StagePreflightError("halt", member.skill, f.toast, f.error, true);
	}
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
 * stale on the first `ctx.newSession()` — the snapshot is built once in
 * `buildRunContext` before any session replaces the outer ctx.
 *
 * Skipped for non-skill dispatch (a prompt stage sends raw text — there is
 * no skill to verify) and when `registeredSkills` is undefined (hostless
 * embedder — same fail-soft posture as the rest of the host-optional
 * surface).
 */
function ensureSkillRegistered(stage: ResolvedStage, run: RunContext): void {
	if (stage.dispatch !== "skill") return;
	if (!run.registeredSkills) return;
	if (run.registeredSkills.has(stage.skill)) return;

	const f = FAIL_SKILL_NOT_REGISTERED(stage.skill, stage.stageNumber);
	throw new StagePreflightError("halt", stage.skill, f.toast, f.error, true);
}

/**
 * The start node consumes the user's brief; subsequent stages MUST inherit
 * an upstream artifactPath. Falling back to originalInput past the start
 * would silently hand a downstream skill the raw feature description.
 *
 * Three opt-outs skip the check:
 *   - `inheritsArtifacts: false` (authored via `terminal()`) — stage consumes
 *     `originalInput` by design.
 *   - `reads: [...]` — stage builds its prompt from the named-publish
 *     registry instead of the rolling primary slot; `ensureNamedReads`
 *     enforces its own coverage rule.
 *   - prompt dispatch — the stage builds its own text and never consumes the
 *     rolling primary as an arg (a continue chat turn typically leans on
 *     session context, not a handle).
 */
function ensureUpstreamArtifact(stage: ResolvedStage, run: RunContext): void {
	if (stage.name === run.workflow.start) return;
	if (stage.def.inheritsArtifacts === false) return;
	if (stage.def.reads?.length) return;
	if (stage.dispatch === "prompt") return;
	if (currentPrimaryArtifact(run.state)) return;
	const f = FAIL_MISSING_ARTIFACT(stage.skill, stage.stageNumber);
	throw new StagePreflightError("halt", stage.skill, f.toast, f.error, true);
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
	for (const read of reads) {
		const name = readName(read);
		if (run.state.named[name]?.length) continue;
		const f = FAIL_MISSING_NAMED_READ(stage.skill, name, stage.stageNumber);
		throw new StagePreflightError("halt", stage.skill, f.toast, f.error, true);
	}
}

function enforceSessionInvariants(stage: ResolvedStage, run: RunContext): void {
	if (stage.def.sessionPolicy === "continue" && !run.continueHost) {
		const reason = `runStage: stage "${stage.name}" uses sessionPolicy "continue" but no workflow host was provided to runWorkflow`;
		throw new StagePreflightError("invariant", stage.name, MSG_STAGE_THREW(stage.name, reason), reason, false);
	}
}
