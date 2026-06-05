/**
 * /wf run-path: parse → loadWorkflows → runWorkflow. Statically imports the
 * heavy runtime (runner + loader); reached only via the dynamic import in
 * `./command.ts`, so it evaluates lazily on first `/wf`, not at startup.
 */

import { parseArgs } from "./command.js";
import type { WorkflowHost, WorkflowHostContext } from "./host.js";
import { renderConfigLayer } from "./layers.js";
import { findWorkflow, type Issue, loadWorkflows } from "./load/index.js";
import {
	MSG_INTERACTIVE_ONLY,
	MSG_LOAD_ABORTED,
	MSG_NAME_IGNORED_ON_RESUME,
	MSG_NAME_INVALID,
	MSG_NO_WORKFLOWS_REGISTERED,
	MSG_RESUME_USAGE,
	MSG_WORKFLOW_NOT_FOUND,
	MSG_WORKFLOW_THREW,
} from "./messages.js";
import { formatWorkflowDetails, formatWorkflowList } from "./preview.js";
import { resumeWorkflowByRunId, runWorkflow } from "./runner/index.js";
import { isValidName } from "./state/index.js";

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function handleWorkflowCommand(host: WorkflowHost, args: string, ctx: WorkflowHostContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(MSG_INTERACTIVE_ONLY, "error");
		return;
	}

	const loaded = await loadWorkflows(ctx.cwd);
	surfaceIssues(ctx, loaded.issues);

	const workflowNames = new Set(loaded.workflows.map((w) => w.name));
	const parsed = parseArgs(args, { workflowNames, default: loaded.default });

	if (parsed.kind === "resume") {
		if (parsed.droppedName !== undefined) {
			ctx.ui.notify(MSG_NAME_IGNORED_ON_RESUME, "warning");
		}
		await handleResume(host, ctx, parsed.ref);
		return;
	}

	const { workflow: workflowName, input, name } = parsed;

	if (name !== undefined && !isValidName(name)) {
		ctx.ui.notify(MSG_NAME_INVALID(name), "error");
		return;
	}

	if (!input) {
		const trimmed = args.trim();
		const previewing = trimmed.length > 0 && workflowNames.has(trimmed);
		ctx.ui.notify(previewing ? formatWorkflowDetails(loaded, trimmed) : formatWorkflowList(loaded), "info");
		return;
	}

	// Block execution on load errors — running a partially-loaded workflow set
	// would silently mask the user's intent (e.g. their preferred workflow
	// failed to import).
	const errorCount = loaded.issues.filter((i) => i.severity === "error").length;
	if (errorCount > 0) {
		ctx.ui.notify(MSG_LOAD_ABORTED(errorCount), "error");
		return;
	}

	// Standalone install: rpiv-workflow ships zero workflows; if nothing else
	// registered one, there's nothing to run. parseArgs returns "" for the
	// workflow name in this case (no default + first token didn't match) —
	// surface the empty-registry verdict instead of falling through to a
	// generic not-found notify.
	if (!workflowName) {
		ctx.ui.notify(MSG_NO_WORKFLOWS_REGISTERED, "error");
		return;
	}

	const workflow = findWorkflow(loaded, workflowName);
	if (!workflow) {
		ctx.ui.notify(MSG_WORKFLOW_NOT_FOUND(workflowName), "error");
		return;
	}

	// runWorkflow returns a result envelope rather than throwing — but a
	// thrown predicate or invariant could still bubble. Catch so Pi's
	// dispatcher doesn't print a raw stack.
	try {
		const result = await runWorkflow(ctx, {
			workflow,
			input,
			host,
			trigger: { kind: "command", name: "wf" },
			name,
		});
		// Surface pre-flight rejections (collision, etc.) — no runId means no JSONL on disk.
		if (!result.success && result.runId === undefined && result.error) {
			ctx.ui.notify(result.error, "error");
		}
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		ctx.ui.notify(MSG_WORKFLOW_THREW(reason), "error");
	}
}

// ---------------------------------------------------------------------------
// Resume handler
// ---------------------------------------------------------------------------

async function handleResume(host: WorkflowHost, ctx: WorkflowHostContext, ref: string): Promise<void> {
	if (!ref) {
		ctx.ui.notify(MSG_RESUME_USAGE, "error");
		return;
	}
	try {
		const result = await resumeWorkflowByRunId(ctx, ref, { host });
		// A failure with no runId is a no-JSONL refusal (run-id didn't resolve,
		// load error, workflow gone, or an unreconstructable trail) — nothing else
		// surfaces it, so notify here. An in-run failure carries a runId and was
		// already notified by the stage machinery via its JSONL failure row;
		// re-notifying would double up.
		if (!result.success && result.runId === undefined && result.error) {
			ctx.ui.notify(result.error, "error");
		}
	} catch (e) {
		ctx.ui.notify(MSG_WORKFLOW_THREW(e instanceof Error ? e.message : String(e)), "error");
	}
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Surface every load + validation issue as a notify, prefixed by severity. */
function surfaceIssues(ctx: WorkflowHostContext, issues: readonly Issue[]): void {
	for (const issue of issues) {
		const level: "warning" | "error" = issue.severity === "error" ? "error" : "warning";
		ctx.ui.notify(formatIssue(issue), level);
	}
}

function formatIssue(issue: Issue): string {
	if (issue.kind === "load") {
		const where = issue.path ? ` (${issue.path})` : "";
		return `[${renderConfigLayer(issue.layer)} config${where}] ${issue.message}`;
	}
	const stageTag = issue.stage ? ` — stage "${issue.stage}"` : "";
	const pathTag = issue.path ? ` (${issue.path})` : "";
	return `[${renderConfigLayer(issue.layer)} config${pathTag}] workflow "${issue.workflow}"${stageTag}: ${issue.message}`;
}
