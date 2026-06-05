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

const NAME_FLAG = /--name\s+([^\s]+)/;

export type ParsedCommand =
	| { kind: "run"; workflow: string; input: string; name?: string }
	| { kind: "resume"; ref: string; droppedName?: string };

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
	let trimmed = args.trim();
	let name: string | undefined;

	// Extract --name <slug> flag and strip it before further parsing.
	const nameMatch = NAME_FLAG.exec(trimmed);
	if (nameMatch) {
		name = nameMatch[1];
		trimmed = trimmed.replace(NAME_FLAG, "").trim();
	}

	if (trimmed.startsWith("@")) {
		// @resume — name has no meaning here; carry it as `droppedName` so the
		// command layer can warn instead of silently dropping it.
		return { kind: "resume", ref: trimmed.slice(1).trim().split(/\s+/)[0] ?? "", droppedName: name };
	}

	if (!trimmed) {
		return { kind: "run", workflow: loaded.default ?? "", input: "", name };
	}

	const firstSpace = trimmed.indexOf(" ");
	const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);

	if (loaded.workflowNames.has(firstToken)) {
		const remaining = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
		return { kind: "run", workflow: firstToken, input: remaining, name };
	}

	return { kind: "run", workflow: loaded.default ?? "", input: trimmed, name };
}
