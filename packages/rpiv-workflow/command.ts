/**
 * /wf slash command registration — kept light. The heavy run-path (runner +
 * loader, ~530ms) lives in `./command-run.js`, dynamically imported only when
 * `/wf` is invoked, so registering the command costs nothing at startup.
 * `parseArgs` stays here (pure, exported for tests).
 */

import type { WorkflowHost, WorkflowHostContext } from "./host.js";

/** Pi command registry — displayed by Pi's `/?` / command list. */
export const CMD_DESCRIPTION = "Run a skill workflow: /wf [workflow] [description]";

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

const LEADING_NAME_FLAG = /^--name\s+(\S+)\s*/;
const TRAILING_NAME_FLAG = /\s+--name\s+(\S+)$/;
/** Any surviving `--name` token after the leading/trailing extraction — input text, flagged. */
const MID_NAME_FLAG = /(?:^|\s)--name(?:\s|$)/;

export type ParsedCommand =
	| { kind: "run"; workflow: string; input: string; name?: string; nameFlagIgnored?: boolean }
	| { kind: "resume"; ref: string; droppedName?: string; nameFlagIgnored?: boolean };

/**
 * First token is a workflow name iff recognised; otherwise the whole arg is
 * input bound to the resolved default. When no default is registered (the
 * empty-registry case), the returned `workflow` is `""` and the orchestrator
 * surfaces `MSG_NO_WORKFLOWS_REGISTERED`.
 *
 * `--name <slug>` is honored ONLY in leading or trailing position (leading
 * wins when both are present). A `--name` anywhere else is the user's own
 * prompt text (`/wf fix the --name handling bug`) — it stays in the input
 * untouched and `nameFlagIgnored` is set so the command layer can warn.
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

	// Extract --name <slug> from the leading or trailing token position only.
	const leading = LEADING_NAME_FLAG.exec(trimmed);
	if (leading) {
		name = leading[1];
		trimmed = trimmed.slice(leading[0].length);
	} else {
		const trailing = TRAILING_NAME_FLAG.exec(trimmed);
		if (trailing) {
			name = trailing[1];
			trimmed = trimmed.slice(0, trailing.index);
		}
	}
	const nameFlagIgnored = MID_NAME_FLAG.test(trimmed);
	const ignored = nameFlagIgnored ? { nameFlagIgnored: true as const } : {};

	if (trimmed.startsWith("@")) {
		// @resume — name has no meaning here; carry it as `droppedName` so the
		// command layer can warn instead of silently dropping it.
		return { kind: "resume", ref: trimmed.slice(1).trim().split(/\s+/)[0] ?? "", droppedName: name, ...ignored };
	}

	if (!trimmed) {
		return { kind: "run", workflow: loaded.default ?? "", input: "", name, ...ignored };
	}

	const firstSpace = trimmed.indexOf(" ");
	const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);

	if (loaded.workflowNames.has(firstToken)) {
		const remaining = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
		return { kind: "run", workflow: firstToken, input: remaining, name, ...ignored };
	}

	return { kind: "run", workflow: loaded.default ?? "", input: trimmed, name, ...ignored };
}
