/**
 * /wf run-path: parse → loadWorkflows → runWorkflow. Statically imports the
 * heavy runtime (runner + loader); reached only via the dynamic import in
 * `./command.ts`, so it evaluates lazily on first `/wf`, not at startup.
 */

import { flushBuiltInProviders } from "./built-ins.js";
import { parseArgs } from "./command.js";
import type { WorkflowHost, WorkflowHostContext } from "./host.js";
import { formatError } from "./internal-utils.js";
import { renderConfigLayer } from "./layers.js";
import { findWorkflow, type Issue, loadWorkflows } from "./load/index.js";
import {
	MSG_FLAG_REPEATED,
	MSG_INTERACTIVE_ONLY,
	MSG_JUMP_CAP_ABOVE_LAP_CEILING,
	MSG_LOAD_ABORTED,
	MSG_NAME_FLAG_MID_INPUT,
	MSG_NAME_IGNORED_ON_RESUME,
	MSG_NAME_INVALID,
	MSG_NO_WORKFLOWS_REGISTERED,
	MSG_RESUME_USAGE,
	MSG_WORKFLOW_NOT_FOUND,
	MSG_WORKFLOW_THREW,
} from "./messages.js";
import { formatWorkflowDetails, formatWorkflowList } from "./preview.js";
import { resumeWorkflowByRunId, runWorkflow } from "./runner/index.js";
// The warning thresholds come from the constants module DIRECTLY, not the
// runner barrel: the handler suites mock the barrel wholesale (the float
// boundary), and a barrel import would let those suites pin a stale 3/8 pair
// while the real defaults drifted.
import { MAX_BACKWARD_JUMPS, MAX_LAPS } from "./runner/run-context.js";
import { flushSkillContractProviders } from "./skill-contracts/index.js";
import { isValidName } from "./state/index.js";

// ---------------------------------------------------------------------------
// Pre-warm
// ---------------------------------------------------------------------------

/**
 * Flush the lazy provider registries ahead of the first `/wf` — both are
 * memoized one-shot latches, so `loadWorkflows` later awaits the same
 * settled promises. Built-in providers carry the heaviest first-call work
 * (the sibling's authoring-DSL graph builds here); measured ~550ms of the
 * first `/wf`'s `loadWorkflows` is dominated by these flushes. Called by
 * the post-registration pre-warm in `command.ts` right after the module
 * graph import; never from the run path (loadWorkflows flushes on its own).
 */
export async function prewarmWorkflowRuntime(): Promise<void> {
	await flushBuiltInProviders();
	await flushSkillContractProviders();
}

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

	if (parsed.nameFlagIgnored) {
		ctx.ui.notify(MSG_NAME_FLAG_MID_INPUT, "warning");
	}
	for (const flag of parsed.duplicateFlags ?? []) {
		// A doubled --name on @resume: the winner is about to be dropped anyway
		// (MSG_NAME_IGNORED_ON_RESUME below), so "the first value wins" would be
		// a false promise stacked on the ignore toast — one warning, not two.
		if (parsed.kind === "resume" && flag === "--name") continue;
		ctx.ui.notify(MSG_FLAG_REPEATED(flag), "warning");
	}
	// The ceiling is arbitrated before the cap and counts every re-entry
	// (`revisits ≤ laps`), so a cap at or above the ceiling can never trip —
	// `--max-jumps 20` alone silently delivers MAX_LAPS re-entries. Warn on
	// the EFFECTIVE pair (a flag absent ⇒ its default) before either arm runs;
	// the run still proceeds, bounded by the ceiling.
	const effectiveCap = parsed.maxBackwardJumps ?? MAX_BACKWARD_JUMPS;
	const effectiveCeiling = parsed.maxLaps ?? MAX_LAPS;
	if (effectiveCap >= effectiveCeiling) {
		ctx.ui.notify(MSG_JUMP_CAP_ABOVE_LAP_CEILING(effectiveCap, effectiveCeiling), "warning");
	}

	if (parsed.kind === "resume") {
		if (parsed.droppedName !== undefined) {
			ctx.ui.notify(MSG_NAME_IGNORED_ON_RESUME, "warning");
		}
		await handleResume(host, ctx, parsed.ref, parsed.maxBackwardJumps, parsed.maxLaps);
		return;
	}

	// Name validity is checked on run AND preview (a preview with a malformed
	// --name still refuses, as it always did) — never on resume, where the
	// name is dropped with its own warning above.
	if (parsed.name !== undefined && !isValidName(parsed.name)) {
		ctx.ui.notify(MSG_NAME_INVALID(parsed.name), "error");
		return;
	}

	if (parsed.kind === "preview") {
		// The parser decided list-vs-details on the flag-stripped residual;
		// re-testing the raw line here would miss `/wf --max-jumps 6 review`.
		ctx.ui.notify(
			parsed.workflow !== undefined ? formatWorkflowDetails(loaded, parsed.workflow) : formatWorkflowList(loaded),
			"info",
		);
		return;
	}

	const { workflow: workflowName, input, name } = parsed;

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

	// Float the run off the prompt: /wf returns immediately; the run executes
	// detached and appears as a lane. runWorkflow returns an envelope (never throws on
	// run failure), but a thrown predicate/invariant could still bubble — .catch keeps
	// Pi's dispatcher from printing a raw stack AND a floated promise from going
	// unhandled (NFR). Both tails settle on the ctx captured HERE, possibly long
	// after pi replaced the launcher session — notify via notifyOrDropIfStale so a
	// stale ctx drops the toast instead of throwing out of the tail (which would
	// be an unhandled rejection → uncaughtException → pi exits).
	void runWorkflow(ctx, {
		workflow,
		input,
		host,
		trigger: { kind: "command", name: "wf" },
		name,
		maxBackwardJumps: parsed.maxBackwardJumps,
		maxLaps: parsed.maxLaps,
	})
		.then((result) => {
			// Surface pre-flight rejections (collision, etc.) — no runId means no JSONL on disk.
			if (!result.success && result.runId === undefined && result.error) {
				notifyOrDropIfStale(ctx, result.error, "error");
			}
		})
		.catch((e) => {
			notifyOrDropIfStale(ctx, MSG_WORKFLOW_THREW(formatError(e)), "error");
		});
}

// ---------------------------------------------------------------------------
// Resume handler
// ---------------------------------------------------------------------------

async function handleResume(
	host: WorkflowHost,
	ctx: WorkflowHostContext,
	ref: string,
	maxBackwardJumps?: number,
	maxLaps?: number,
): Promise<void> {
	if (!ref) {
		ctx.ui.notify(MSG_RESUME_USAGE, "error");
		return;
	}
	// Float the resume off the prompt — identical shape to the run path,
	// including the stale-safe settle tails.
	void resumeWorkflowByRunId(ctx, ref, { host, maxBackwardJumps, maxLaps })
		.then((result) => {
			// A failure with no runId is a no-JSONL refusal (run-id didn't resolve,
			// load error, workflow gone, or an unreconstructable trail) — nothing else
			// surfaces it, so notify here. An in-run failure carries a runId and was
			// already notified by the stage machinery via its JSONL failure row;
			// re-notifying would double up.
			if (!result.success && result.runId === undefined && result.error) {
				notifyOrDropIfStale(ctx, result.error, "error");
			}
		})
		.catch((e) => {
			notifyOrDropIfStale(ctx, MSG_WORKFLOW_THREW(formatError(e)), "error");
		});
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Notify on the /wf command ctx captured at float time, swallowing ONLY the
 * stale-ctx error pi-core throws once the launcher session has been replaced
 * or disposed (/new, resume, fork, /reload, quit, auto-compaction — any of
 * which can happen while a detached run is in flight). The toast is
 * best-effort — the lane dock + JSONL trail already carry the outcome — but a
 * throw from a settle tail escapes the .catch and kills pi as an
 * uncaughtException. Any other error is a real bug and must propagate.
 */
function notifyOrDropIfStale(ctx: WorkflowHostContext, message: string, level: "warning" | "error"): void {
	try {
		ctx.ui.notify(message, level);
	} catch (e) {
		if (!isStaleCtxError(e)) throw e;
	}
}

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// after session replacement/reload. Match the stable substring — the
// per-package twin of the rpiv-core/rpiv-btw/rpiv-todo copies (siblings never
// import each other at runtime).
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

/** Surface every load + validation issue as a notify, prefixed by severity. */
function surfaceIssues(ctx: WorkflowHostContext, issues: readonly Issue[]): void {
	for (const issue of issues) {
		const level: "warning" | "error" = issue.severity === "error" ? "error" : "warning";
		ctx.ui.notify(formatIssue(issue), level);
	}
}

function formatIssue(issue: Issue): string {
	if (issue.kind === "load") {
		// "framework" = the loader's own machinery (providers, derivers) — no
		// config file caused it, so no "config" suffix.
		if (issue.layer === "framework") return `[framework] ${issue.message}`;
		const where = issue.path ? ` (${issue.path})` : "";
		return `[${renderConfigLayer(issue.layer)} config${where}] ${issue.message}`;
	}
	const stageTag = issue.stage ? ` — stage "${issue.stage}"` : "";
	const pathTag = issue.path ? ` (${issue.path})` : "";
	return `[${renderConfigLayer(issue.layer)} config${pathTag}] workflow "${issue.workflow}"${stageTag}: ${issue.message}`;
}
