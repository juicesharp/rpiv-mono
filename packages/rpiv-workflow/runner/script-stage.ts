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
 * lifecycle events, and recurses through the injected `advance`.
 *
 * The retry policy is the SHARED `runValidationRetryLoop`
 * (validate-output.ts) — same structure the skill path's extraction runs;
 * success persistence is the SHARED `persistStageSuccess` (audit-rows.ts) —
 * so the audit row shape, the lifecycle fire order (`onStageStart` →
 * `onStageRetry`* → `onStageEnd` | `onStageError`), and the
 * primary-artifact advance behaviour stay aligned across the two
 * stage kinds by construction.
 *
 * Invariants this file relies on (enforced at load time by
 * `validateWorkflow:checkScriptStageInvariants`):
 *   - `stage.skill` is unset.
 *   - `stage.outcome` is unset (no collector to run).
 *   - `stage.loop` is unset (the runner's per-unit machinery doesn't
 *     apply; authors write their own loop inside `run()`).
 *   - `stage.sessionPolicy !== "continue"` (no session to continue).
 */

import type { ScriptContext } from "../api.js";
import { auditCtxFor, failedArgs, recordTerminalFailure, terminate } from "../audit.js";
import { allocateStageNumber, persistStageSuccess } from "../audit-rows.js";
import type { Artifact } from "../handle.js";
import { formatError, nowIso } from "../internal-utils.js";
import { lifecycleCtxFor, scriptStageRef } from "../lifecycle.js";
import {
	FAIL_AUDIT_WRITE,
	FAIL_SCRIPT_THREW,
	FAIL_VALIDATION_EXHAUSTED,
	MSG_STAGE_COMPLETE,
	STATUS_KEY,
	STATUS_STAGE,
} from "../messages.js";
import { finalizeOutput, type Output } from "../output.js";
import type { RunContext, WorkflowHostContext } from "../types.js";
import {
	DEFAULT_VALIDATION_RETRIES,
	describeFailure,
	runValidationRetryLoop,
	validateOutputData,
} from "../validate-output.js";
import type { AdvanceFn, ChainOutcome } from "./failure.js";
import type { ResolvedStage } from "./resolve-stage.js";

/**
 * Drive a script stage: lifecycle-fire `onStageStart`, retry-loop the
 * `run` body against `outputSchema`, then either persist + advance or
 * record a terminal failure. Sole entry point — `runStage` branches
 * here on `mode === "script"`, passing the composed `advance`.
 *
 * Caller pre-conditions (held by `runStage`):
 *   - `ensureInputValid` already passed.
 *   - `mode === "script"` (a script stage cannot carry a `loop`).
 */
export async function runScript(
	curCtx: WorkflowHostContext,
	stage: ResolvedStage,
	idx: number,
	run: RunContext,
	advance: AdvanceFn,
): Promise<ChainOutcome> {
	curCtx.ui.setStatus(STATUS_KEY, STATUS_STAGE(stage.stageNumber, run.totalStages, stage.name));

	const ref = scriptStageRef(stage.name, stage.stageNumber);
	await run.lifecycle.fire(curCtx, "onStageStart", ref, lifecycleCtxFor(run));

	const scriptCtx: ScriptContext = {
		cwd: run.cwd,
		input: run.state.output,
		state: run.state,
	};

	// One allocation per activation, BEFORE any output is built — the
	// envelope, the success/failure row, and lifecycle bookkeeping share it
	// (mirrors `produceAndValidateOutput` on the skill path).
	const stageNumber = allocateStageNumber(run.state);

	// `halt: "recorded"` = invokeRun already recorded the terminal failure.
	const result = await runValidationRetryLoop<Output, "recorded">(
		{
			maxRetries: stage.def.maxRetries ?? DEFAULT_VALIDATION_RETRIES,
			haltOnInvalid: (stage.def.onInvalid ?? "retry") === "halt",
		},
		{
			produce: async () => {
				const invocation = await invokeRun(curCtx, stage, scriptCtx, run, stageNumber);
				if (!invocation.ok) return { ok: false, halt: "recorded" };
				const output = finalizeOutput(invocation.raw, {
					stage: stage.name,
					stageNumber,
					ts: nowIso(),
					runId: run.runId,
				});
				return { ok: true, value: output };
			},
			validate: async (output) => {
				if (!(stage.def.kind === "produces" && stage.def.outputSchema)) {
					return { ok: true, result: { valid: true, failures: [] } };
				}
				// No catch: a throwing author schema propagates to the runner's
				// single catch site (today's contract).
				return { ok: true, result: await Promise.resolve(validateOutputData(stage.def.outputSchema, output.data)) };
			},
			onRetry: async (attempt) => {
				await run.lifecycle.fire(curCtx, "onStageRetry", ref, attempt, lifecycleCtxFor(run));
				return { ok: true };
			},
		},
	);

	if (result.kind === "halt") return "halted";
	if (result.kind === "exhausted") {
		const failureSummary = result.failures.map(describeFailure).join("; ");
		await recordTerminalFailure(
			curCtx,
			scriptAuditCtx(run, stage, stageNumber),
			failedArgs(FAIL_VALIDATION_EXHAUSTED(stage.name, failureSummary)),
		);
		return "halted";
	}

	const output = result.value;
	// `skill` is intentionally absent on script-stage rows — JSON.stringify
	// drops `undefined` so the JSONL row carries no skill field at all.
	const persisted = persistStageSuccess(
		run.state,
		{ cwd: run.cwd, runId: run.runId, stage: stage.name, output, preAllocated: stageNumber },
		stage.def,
	);
	if (!persisted) {
		const auditFailure = FAIL_AUDIT_WRITE(stage.name);
		curCtx.ui.notify(auditFailure.toast, "error");
		terminate(run.state, { status: "failed", error: auditFailure.error });
		return "halted";
	}
	curCtx.ui.notify(MSG_STAGE_COMPLETE(stage.name), "info");

	await run.lifecycle.fire(curCtx, "onStageEnd", ref, output, lifecycleCtxFor(run));
	return advance(curCtx, stage.name, idx, run);
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
	curCtx: WorkflowHostContext,
	stage: ResolvedStage,
	scriptCtx: ScriptContext,
	run: RunContext,
	stageNumber: number,
): Promise<ScriptInvocationResult> {
	try {
		const result = await Promise.resolve(stage.def.run!(scriptCtx));
		const raw =
			stage.def.kind === "produces"
				? (result as { kind: string; artifacts: readonly Artifact[]; data: unknown })
				: { kind: "side-effect", artifacts: [] as readonly Artifact[], data: {} as unknown };
		return { ok: true, raw };
	} catch (e) {
		const reason = formatError(e);
		// `recordTerminalFailure` fires `onStageError` itself — the caller must
		// not fire a second time on the `ok: false` return.
		await recordTerminalFailure(
			curCtx,
			scriptAuditCtx(run, stage, stageNumber),
			failedArgs(FAIL_SCRIPT_THREW(stage.name, reason)),
		);
		return { ok: false };
	}
}

/**
 * Build the `AuditCtx`-shaped object `recordTerminalFailure` needs for
 * a script-stage halt. The `skill` field doubles as the lifecycle
 * `onStageError` ref payload — using `stage.name` keeps the failure
 * attribution aligned with the success row's `stage` identity.
 */
function scriptAuditCtx(run: RunContext, stage: ResolvedStage, stageNumber: number) {
	// `skill` doubles as the notify-message subject (`MSG_VALIDATION_EXHAUSTED`,
	// `MSG_STAGE_FAILED`); set to the stage name so the user sees the stage
	// identity. `isScript: true` ensures the JSONL row drops the field and
	// `onStageError` fires with `scriptStageRef` (no `skill` payload).
	// `allocatedStageNumber` lets a failure row reuse the activation's number.
	return auditCtxFor(run, stage.name, stage.name, { isScript: true, allocatedStageNumber: stageNumber });
}
