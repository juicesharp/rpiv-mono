/**
 * /wf slash command registration — kept light. The heavy run-path (runner +
 * loader, ~530ms) lives in `./command-run.js`, dynamically imported only when
 * `/wf` is invoked, so registering the command costs nothing at startup.
 * `parseArgs` stays here (pure, exported for tests).
 */

import type { WorkflowHost, WorkflowHostContext } from "./host.js";
import { CMD_DESCRIPTION } from "./messages.js";

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function registerWorkflowCommand(host: WorkflowHost): void {
	host.registerCommand("wf", {
		description: CMD_DESCRIPTION,
		handler: async (args: string, ctx: WorkflowHostContext) => {
			// Lazy — runner/loader graph evaluates on first `/wf`, not at startup.
			const { handleWorkflowCommand } = await import("./command-run.js");
			return handleWorkflowCommand(host, args, ctx);
		},
	});
}

// ---------------------------------------------------------------------------
// Arg parsing (pure; exported for tests + consumed by ./command-run.js)
// ---------------------------------------------------------------------------

export type ParsedCommand = { kind: "run"; workflow: string; input: string } | { kind: "resume"; ref: string };

/**
 * First token is a workflow name iff recognised; otherwise the whole arg is
 * input bound to the resolved default. When no default is registered (the
 * empty-registry case), the returned `workflow` is `""` and the orchestrator
 * surfaces `MSG_NO_WORKFLOWS_REGISTERED`.
 *
 * `@<ref>` on the first token is the resume sigil — the first whitespace-
 * delimited token after `@` is the run reference. Leading space after the
 * sigil is tolerated (`@ ref` === `@ref`); trailing tokens are ignored.
 */
export function parseArgs(
	args: string,
	loaded: { workflowNames: ReadonlySet<string>; default: string | undefined },
): ParsedCommand {
	const trimmed = args.trim();

	if (trimmed.startsWith("@")) {
		// First token after the sigil is the ref; ignore any trailing tokens for now.
		return { kind: "resume", ref: trimmed.slice(1).trim().split(/\s+/)[0] ?? "" };
	}

	if (!trimmed) {
		return { kind: "run", workflow: loaded.default ?? "", input: "" };
	}

	const firstSpace = trimmed.indexOf(" ");
	const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);

	if (loaded.workflowNames.has(firstToken)) {
		const remaining = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
		return { kind: "run", workflow: firstToken, input: remaining };
	}

	return { kind: "run", workflow: loaded.default ?? "", input: trimmed };
}
