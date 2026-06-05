/**
 * `resumeWorkflowByRunId` — the ergonomic one-shot resume entry point.
 *
 * Sugar over the `resolveRun` → `loadWorkflows` → `findWorkflow` →
 * `resumeWorkflow` dance, the resume-side counterpart to `runWorkflowByName`.
 * Lives in its own module (not `runner.ts`) so the core graph walker stays
 * decoupled from the loader + state reads — `resumeWorkflow` still takes a
 * pre-resolved `Workflow` + `WorkflowHeader`; only this convenience layer
 * reaches into `load/` and `state/`.
 *
 * Naming: the suffix names the identifier the caller hands in.
 * `runWorkflowByName` resolves a *workflow* by name (you're starting a run, so
 * you say which workflow); `resumeWorkflowByRunId` resolves a specific past
 * *run* by its reference — a human-readable name (assigned via `--name`) or a
 * literal run-id slug. `resolveRun` handles both.
 *
 * The run header already names its workflow, so the lookup is free — the caller
 * supplies only the reference.
 *
 * Contract mirrors `command.ts`'s former resume guards so the programmatic path
 * and the `/wf @<ref>` path never diverge:
 *   1. ref doesn't resolve to a run             → failure envelope (`MSG_RUN_NOT_FOUND`)
 *   2. error-severity load issues                → refuse (a broken overlay may
 *                                                  mis-resolve the workflow) (`MSG_LOAD_ABORTED`)
 *   3. header's workflow no longer loaded        → failure envelope (`MSG_RESUME_WORKFLOW_GONE`)
 *   4. otherwise                                → delegate to `resumeWorkflow`
 *
 * Pure, like `runWorkflowByName` and `resumeWorkflow`: every expected failure is
 * returned in the `RunWorkflowResult` envelope, never thrown and never
 * self-notified. Callers branch on `result.success` and surface `result.error`
 * themselves (see `command.ts`'s `!result.runId` discriminator, which notifies
 * no-JSONL refusals once while leaving in-run failures to the stage machinery).
 */

import type { WorkflowHostContext } from "../host.js";
import { findWorkflow, loadWorkflows } from "../load/index.js";
import { MSG_LOAD_ABORTED, MSG_RESUME_WORKFLOW_GONE, MSG_RUN_NOT_FOUND } from "../messages.js";
import { resolveRun } from "../state/index.js";
import { type ResumeWorkflowOptions, type RunWorkflowResult, resumeWorkflow } from "./runner.js";

/**
 * Options for `resumeWorkflowByRunId` — the full `ResumeWorkflowOptions` surface
 * minus the three fields this helper resolves itself (`workflow` from the
 * header, `header` from the run-id, `ref` supplied as the run-id). Derived via
 * `Omit` so it tracks `ResumeWorkflowOptions` automatically — new options
 * (host, lifecycle, caps) flow through with zero edits here.
 */
export type ResumeWorkflowByRunIdOptions = Omit<ResumeWorkflowOptions, "workflow" | "header" | "ref">;

/**
 * Resolve `ref` to a run header, load the merged overlay for `ctx.cwd`, find
 * the run's workflow, and resume it.
 *
 *   const result = await resumeWorkflowByRunId(ctx, "my-ref", { host });
 *   // or with a literal run-id:
 *   const result = await resumeWorkflowByRunId(ctx, "2026-06-03_07-30-00-ab12", { host });
 *
 * `ref` may be either a human-readable name (assigned via `--name`) or a
 * literal run-id slug. Resolution is handled by `resolveRun` — callers pass
 * whatever the user supplied after the `@` sigil.
 *
 * Pass `opts` to thread a `host` (required for continue-policy stages),
 * `lifecycle` listeners, or the iteration caps — same semantics as
 * `resumeWorkflow`.
 */
export async function resumeWorkflowByRunId(
	ctx: WorkflowHostContext,
	ref: string,
	opts?: ResumeWorkflowByRunIdOptions,
): Promise<RunWorkflowResult> {
	const header = resolveRun(ctx.cwd, ref);
	if (!header) {
		return { stagesCompleted: 0, success: false, error: MSG_RUN_NOT_FOUND(ref) };
	}

	const loaded = await loadWorkflows(ctx.cwd);

	// Gate on load errors exactly as the run-by-name path does: a broken
	// config/pack file can drop or mangle workflows during the layered merge, so
	// resolving the run's workflow off a partial set risks resuming the wrong thing.
	const errors = loaded.issues.filter((i) => i.severity === "error");
	if (errors.length > 0) {
		return { stagesCompleted: 0, success: false, error: MSG_LOAD_ABORTED(errors.length) };
	}

	const workflow = findWorkflow(loaded, header.workflow);
	if (!workflow) {
		return { stagesCompleted: 0, success: false, error: MSG_RESUME_WORKFLOW_GONE(header.workflow, ref) };
	}

	// `ref` is the run-id or name here — it surfaces in `trigger.meta.resumedFrom`.
	return resumeWorkflow(ctx, { workflow, header, ref, ...opts });
}
