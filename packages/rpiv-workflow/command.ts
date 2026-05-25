/** /wf slash command: parse → loadWorkflows → runWorkflow. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { renderConfigLayer } from "./layers.js";
import { findWorkflow, type Issue, loadWorkflows } from "./load/index.js";
import {
	CMD_DESCRIPTION,
	MSG_INTERACTIVE_ONLY,
	MSG_LOAD_ABORTED,
	MSG_WORKFLOW_NOT_FOUND,
	MSG_WORKFLOW_THREW,
} from "./messages.js";
import { formatWorkflowDetails, formatWorkflowList } from "./preview.js";
import { runWorkflow } from "./runner.js";

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function registerWorkflowCommand(pi: ExtensionAPI): void {
	pi.registerCommand("wf", {
		description: CMD_DESCRIPTION,
		handler: (args: string, ctx: ExtensionCommandContext) => handleWorkflowCommand(pi, args, ctx),
	});
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function handleWorkflowCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(MSG_INTERACTIVE_ONLY, "error");
		return;
	}

	const loaded = await loadWorkflows(ctx.cwd);
	surfaceIssues(ctx, loaded.issues);

	const workflowNames = new Set(loaded.workflows.map((w) => w.name));
	const { workflow: workflowName, input } = parseArgs(args, { workflowNames, default: loaded.default });

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

	const workflow = findWorkflow(loaded, workflowName);
	if (!workflow) {
		ctx.ui.notify(MSG_WORKFLOW_NOT_FOUND(workflowName), "error");
		return;
	}

	// runWorkflow returns a result envelope rather than throwing — but a
	// thrown predicate or invariant could still bubble. Catch so Pi's
	// dispatcher doesn't print a raw stack.
	try {
		await runWorkflow(ctx, { workflow, input, pi });
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		ctx.ui.notify(MSG_WORKFLOW_THREW(reason), "error");
	}
}

// ---------------------------------------------------------------------------
// Arg parsing (exported for tests)
// ---------------------------------------------------------------------------

/** First token is a workflow name iff recognised; otherwise the whole arg is input + default. */
export function parseArgs(
	args: string,
	loaded: { workflowNames: ReadonlySet<string>; default: string },
): { workflow: string; input: string } {
	const trimmed = args.trim();
	if (!trimmed) {
		return { workflow: loaded.default, input: "" };
	}

	const firstSpace = trimmed.indexOf(" ");
	const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);

	if (loaded.workflowNames.has(firstToken)) {
		const remaining = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
		return { workflow: firstToken, input: remaining };
	}

	return { workflow: loaded.default, input: trimmed };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Surface every load + validation issue as a notify, prefixed by severity. */
function surfaceIssues(ctx: ExtensionCommandContext, issues: readonly Issue[]): void {
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
	const nodeTag = issue.node ? ` — node "${issue.node}"` : "";
	const pathTag = issue.path ? ` (${issue.path})` : "";
	return `[${renderConfigLayer(issue.layer)} config${pathTag}] workflow "${issue.workflow}"${nodeTag}: ${issue.message}`;
}
