/**
 * Skillless script stages — the runtime counterpart to
 * `produces.script(...)`, `acts.script(...)`, `terminal.script(...)`.
 *
 * Where the skill path opens a Pi session and lets the agent emit work
 * the runner then collects + parses, the script path calls a TS
 * function and treats its return value AS the work. No session, no
 * skill dispatch, no collector/parser pipeline — `def.run(scriptCtx)`
 * returns `{ kind, artifacts, data }` (`produces.script`) or `void`
 * (`acts.script` / `terminal.script`), and the runner stamps `meta`,
 * persists the JSONL row, advances the rolling primary slot, fires
 * lifecycle events, and recurses through `advanceChain`.
 *
 * The fan-out of responsibilities mirrors `runStageSession` →
 * `recordStageSuccess` for skill stages, deliberately so the audit row
 * shape, the lifecycle fire order (`onStageStart` →
 * `onStageRetry`* → `onStageEnd` | `onStageError`), and the
 * primary-artifact advance behaviour stay aligned across the two
 * stage kinds.
 *
 * Invariants this file relies on (enforced at load time by
 * `validateWorkflow:checkScriptStageInvariants`):
 *   - `stage.skill` is unset.
 *   - `stage.outcome` is unset (no collector to run).
 *   - `stage.fanout` is unset (the runner's per-unit machinery doesn't
 *     apply; authors write their own loop inside `run()`).
 *   - `stage.sessionPolicy !== "continue"` (no session to continue).
 */

import type { ScriptContext, StageDef } from "../api.js";
import { nowIso, recordStage, recordTerminalFailure } from "../audit.js";
import type { Artifact } from "./../handle.js";
import { resolvePublishName } from "../internal-utils.js";
import { scriptStageRef } from "../lifecycle.js";
import {
	ERR_AUDIT_WRITE_FAILED,
	ERR_SCRIPT_THREW,
	ERR_VALIDATION_FAILED,
	MSG_AUDIT_WRITE_FAILED,
	MSG_SCRIPT_THREW,
	MSG_STAGE_COMPLETE,
	MSG_VALIDATION_EXHAUSTED,
	STATUS_KEY,
	STATUS_STAGE,
} from "../messages.js";
import { finalizeOutput, type Output } from "../output.js";
import type { RunContext, RunnerCtx, RunState } from "../types.js";
import { DEFAULT_VALIDATION_RETRIES, validateOutputData } from "../validate-output.js";
import { advanceChain } from "./chain-advance.js";
import { lifecycleCtxFor } from "./runner.js";
import type { ResolvedStage } from "./stage-lifecycle.js";

/**
 * Drive a script stage: lifecycle-fire `onStageStart`, retry-loop the
 * `run` body against `outputSchema`, then either persist + advance or
 * record a terminal failure. Sole entry point — `runStage` branches
 * here when `stage.def.run` is set.
 *
 * Caller pre-conditions (held by `runStage`):
 *   - `ensureInputValid` already passed (post-prompt-checks pipeline).
 *   - `tryFanout` returned `false` (fanout incompatible by validation).
 */
export async function runScript(curCtx: RunnerCtx, stage: ResolvedStage, idx: number, run: RunContext): Promise<void> {
	curCtx.ui.setStatus(STATUS_KEY, STATUS_STAGE(stage.stageNumber, run.totalStages, stage.name));

	const ref = scriptStageRef(stage.name, stage.stageNumber);
	await run.lifecycle.fire(curCtx, "onStageStart", ref, lifecycleCtxFor(run));

	const scriptCtx: ScriptContext = {
		cwd: run.cwd,
		input: run.state.output,
		state: run.state,
	};

	const maxRetries = stage.def.maxRetries ?? DEFAULT_VALIDATION_RETRIES;
	const onInvalid = stage.def.onInvalid ?? "retry";

	for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
		const invocation = await invokeRun(curCtx, stage, scriptCtx, ref, run);
		if (!invocation.ok) return;

		const output = finalizeOutput(invocation.raw, {
			stage: stage.name,
			stageNumber: run.state.lastAllocatedStageNumber + 1,
			ts: nowIso(),
			runId: run.runId,
		});

		if (stage.def.kind === "produces" && stage.def.outputSchema) {
			const validation = await Promise.resolve(validateOutputData(stage.def.outputSchema, output.data));
			if (!validation.valid) {
				const failureSummary = validation.failures.map((f) => `${f.path}: ${f.message}`).join("; ");
				if (attempt > maxRetries || onInvalid === "halt") {
					await recordTerminalFailure(curCtx, scriptAuditCtx(run, stage), {
						status: "failed",
						notifyMsg: MSG_VALIDATION_EXHAUSTED(stage.name),
						notifyLevel: "error",
						errMsg: ERR_VALIDATION_FAILED(stage.name, failureSummary),
					});
					return;
				}
				await run.lifecycle.fire(curCtx, "onStageRetry", ref, attempt, lifecycleCtxFor(run));
				continue;
			}
		}

		if (!recordScriptSuccess(curCtx, stage, output, run.state, run.cwd, run.runId)) return;

		await run.lifecycle.fire(curCtx, "onStageEnd", ref, output, lifecycleCtxFor(run));
		await advanceChain(curCtx, stage.name, idx, run);
		return;
	}
}

type ScriptInvocationResult =
	| { ok: true; raw: { kind: string; artifacts: readonly Artifact[]; data: unknown } }
	| { ok: false };

/**
 * Invoke `stage.def.run` once with `scriptCtx`; coerce the return into
 * the value-channel shape `finalizeOutput` wants. Acts/terminal script
 * stages return `void` — the runner synthesises a `"side-effect"`
 * envelope so the chain stays uniform. A throw becomes a terminal
 * failure attributed via `MSG_SCRIPT_THREW` + `ERR_SCRIPT_THREW`.
 */
async function invokeRun(
	curCtx: RunnerCtx,
	stage: ResolvedStage,
	scriptCtx: ScriptContext,
	ref: ReturnType<typeof scriptStageRef>,
	run: RunContext,
): Promise<ScriptInvocationResult> {
	try {
		const result = await Promise.resolve(stage.def.run!(scriptCtx));
		const raw =
			stage.def.kind === "produces"
				? (result as { kind: string; artifacts: readonly Artifact[]; data: unknown })
				: { kind: "side-effect", artifacts: [] as readonly Artifact[], data: {} as unknown };
		return { ok: true, raw };
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		await recordTerminalFailure(curCtx, scriptAuditCtx(run, stage), {
			status: "failed",
			notifyMsg: MSG_SCRIPT_THREW(stage.name, reason),
			notifyLevel: "error",
			errMsg: ERR_SCRIPT_THREW(stage.name, reason),
		});
		// `recordTerminalFailure` already fired `onStageError`; suppress the
		// `_ref` arg here so the caller doesn't fire a second time.
		void ref;
		return { ok: false };
	}
}

/**
 * Persist the success row + advance the rolling primary-artifact slot.
 * Returns `true` iff the JSONL row landed. Mirrors
 * `tryRecordStage` + `recordStageSuccess` in `sessions/sessions.ts`,
 * specialised for the script path (no SessionContext, no skill field,
 * no `onStageEnd` fire — caller owns lifecycle ordering here).
 */
function recordScriptSuccess(
	curCtx: RunnerCtx,
	stage: ResolvedStage,
	output: Output,
	state: RunState,
	cwd: string,
	runId: string,
): boolean {
	const assigned = recordStage(
		cwd,
		runId,
		// `skill` is intentionally absent on script-stage rows — JSON.stringify
		// drops `undefined` so the JSONL row carries no skill field at all.
		{ stage: stage.name, status: "completed", ts: nowIso(), output },
		state,
	);
	if (assigned === undefined) {
		curCtx.ui.notify(MSG_AUDIT_WRITE_FAILED(stage.name), "error");
		state.termination.error = ERR_AUDIT_WRITE_FAILED(stage.name);
		return false;
	}
	advancePrimaryForScript(state, stage.def, stage.name, output);
	state.output = output;
	state.stagesCompleted++;
	curCtx.ui.notify(MSG_STAGE_COMPLETE(stage.name), "info");
	return true;
}

/**
 * Mirror of `sessions/sessions.ts:maybeAdvancePrimary` for the script
 * path. Kept local instead of extracted to a shared helper: the rule
 * is small (eight lines), and the two call sites live in different
 * folders (`runner/` vs `sessions/`) — extracting would force a
 * runner-imports-sessions or sessions-imports-runner crossing for one
 * predicate.
 *
 *   - `kind: "produces"` → first artifact wins the rolling slot.
 *   - `inheritsArtifacts: false` (`terminal.script`) → clear the slot
 *     so downstream stages start without an inherited handle.
 *   - other `side-effect` → leave the slot untouched (a downstream
 *     stage still inherits whatever the upstream produces stage set).
 */
function advancePrimaryForScript(state: RunState, def: StageDef, stageName: string, output: Output): void {
	if (def.kind === "produces") {
		const next = output.artifacts[0];
		if (next) state.primaryArtifact = next;
		const key = resolvePublishName(def, stageName);
		const slot = state.named[key];
		if (slot) slot.push(output);
		else state.named[key] = [output];
		return;
	}
	if (def.inheritsArtifacts === false) {
		state.primaryArtifact = undefined;
	}
}

/**
 * Build the `AuditCtx`-shaped object `recordTerminalFailure` needs for
 * a script-stage halt. The `skill` field doubles as the lifecycle
 * `onStageError` ref payload — using `stage.name` keeps the failure
 * attribution aligned with the success row's `stage` identity.
 */
function scriptAuditCtx(run: RunContext, stage: ResolvedStage) {
	return {
		cwd: run.cwd,
		runId: run.runId,
		state: run.state,
		stageName: stage.name,
		// `skill` doubles as the notify-message subject (`MSG_VALIDATION_EXHAUSTED`,
		// `MSG_STAGE_FAILED`); set to the stage name so the user sees the stage
		// identity. `isScript: true` ensures the JSONL row drops the field and
		// `onStageError` fires with `scriptStageRef` (no `skill` payload).
		skill: stage.name,
		lifecycle: run.lifecycle,
		runIdentity: { workflow: run.workflow.name, totalStages: run.totalStages, trigger: run.trigger },
		isScript: true,
	};
}
