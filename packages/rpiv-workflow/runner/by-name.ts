/**
 * `runWorkflowByName` — the ergonomic one-shot entry point.
 *
 * Sugar over the three-step `loadWorkflows` → `findWorkflow` → `runWorkflow`
 * dance for the common "just run this workflow by name" case. Lives in its
 * own module (not `runner.ts`) so the core graph walker stays decoupled from
 * the loader — `runWorkflow` still takes a pre-resolved `Workflow`; only this
 * convenience layer reaches into `load/`.
 *
 * Contract mirrors `command.ts` (the `/wf` handler) so the programmatic path
 * and the slash-command path never diverge:
 *   1. error-severity load issues  → refuse (a broken overlay means the
 *                                     merged set may be partial / wrong)
 *   2. name not found              → failure envelope listing what IS available
 *   3. otherwise                   → delegate to `runWorkflow`
 *
 * Every expected failure is returned as a `RunWorkflowResult` envelope, never
 * thrown — consistent with `runWorkflow`'s own pre-flight rejections and the
 * loader's "never throws" guarantee. Callers branch on `result.success`.
 */

import type { WorkflowHostContext } from "../host.js";
import { findWorkflow, loadWorkflows } from "../load/index.js";
import { type RunWorkflowOptions, type RunWorkflowResult, runWorkflow } from "./runner.js";

/**
 * Options for `runWorkflowByName` — the full `RunWorkflowOptions` surface
 * minus the two fields this helper supplies positionally (`workflow` is
 * resolved by name; `input` is the third argument). Derived via `Omit` so it
 * tracks `RunWorkflowOptions` automatically — new options (host, trigger,
 * lifecycle, caps) flow through with zero edits here.
 */
export type RunWorkflowByNameOptions = Omit<RunWorkflowOptions, "workflow" | "input">;

/**
 * Load the merged overlay for `ctx.cwd`, resolve `name`, and run it.
 *
 *   const result = await runWorkflowByName(ctx, "research", "add dark mode");
 *   if (!result.success) ctx.ui.notify(result.error ?? "failed", "error");
 *
 * Pass `opts` to thread a `host` (required for continue-policy stages), a
 * `trigger`, `lifecycle` listeners, or the iteration caps — same semantics as
 * `runWorkflow`.
 */
export async function runWorkflowByName(
	ctx: WorkflowHostContext,
	name: string,
	input: string,
	opts?: RunWorkflowByNameOptions,
): Promise<RunWorkflowResult> {
	const loaded = await loadWorkflows(ctx.cwd);

	// Gate on load errors exactly as command.ts does: a broken config/pack
	// file can drop or mangle workflows during the layered merge, so running
	// anything off a partial set risks dispatching the wrong thing silently.
	const errors = loaded.issues.filter((i) => i.severity === "error");
	if (errors.length > 0) {
		return {
			stagesCompleted: 0,
			success: false,
			error: `workflow overlay has ${errors.length} load error(s): ${errors.map((i) => i.message).join("; ")}`,
		};
	}

	const workflow = findWorkflow(loaded, name);
	if (!workflow) {
		const available = loaded.workflows.map((w) => w.name);
		return {
			stagesCompleted: 0,
			success: false,
			error: `workflow "${name}" not found (available: ${available.length > 0 ? available.join(", ") : "none"})`,
		};
	}

	return runWorkflow(ctx, { workflow, input, ...opts });
}
