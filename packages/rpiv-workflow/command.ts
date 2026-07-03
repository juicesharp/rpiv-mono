/**
 * /wf slash command registration — kept light. The heavy run-path (runner +
 * loader, ~0.9s of module evaluation) lives in `./command-run.js`, dynamically
 * imported only when needed, so registering the command costs nothing at
 * startup. The import promise is memoized in the handler closure: Pi's
 * extension loader runs jiti with `moduleCache: false`, so a bare `import()`
 * here would re-evaluate the entire graph on EVERY `/wf` — a recurring ~0.9s
 * stall. The closure is held by Pi's command registry and survives across
 * invocations; `/reload` re-registers and resets the memo, so edit pickup is
 * preserved. A post-registration pre-warm kicks the same memoized import
 * shortly after startup: jiti evaluation yields between modules (measured
 * max event-loop stall ~0ms at 5ms sampling), so the warm-up causes no
 * perceptible jank and the first real `/wf` finds the graph ready.
 * `parseArgs` stays here (pure, exported for tests).
 */

import type { WorkflowHost, WorkflowHostContext, WorkflowLauncherContext } from "./host.js";

/** Pi command registry — displayed by Pi's `/?` / command list. */
export const CMD_DESCRIPTION = "Run a skill workflow: /wf [workflow] [description]";

/**
 * Cold-path toast — shown only when the user invokes `/wf` before the
 * command-run graph has finished evaluating (i.e. they beat the pre-warm);
 * this line is the only feedback in that ~1s window.
 */
export const MSG_RUNTIME_LOADING = "rpiv: loading workflow runtime (first /wf after load)…";

/**
 * Pre-warm delay — long enough to stay clear of Pi's own startup work,
 * short enough to beat a human typing their first `/wf`.
 */
export const PREWARM_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

type CommandRunModule = typeof import("./command-run.js");

export interface WfCommandHandler {
	(args: string, ctx: WorkflowLauncherContext): Promise<void>;
	/** Kick (or join) the memoized command-run import — the pre-warm entry. */
	prewarm(): Promise<void>;
}

/**
 * Build the `/wf` handler with a per-closure memo of the command-run import,
 * shared between the handler and `prewarm()`. A rejected import is NOT
 * memoized — the memo clears so the next call retries instead of replaying
 * the cached rejection forever (a failed pre-warm therefore degrades to
 * exactly the pre-warm-less behavior). Exported for tests (the importer is
 * injectable); production callers go through `registerWorkflowCommand`.
 */
export function makeWfHandler(
	host: WorkflowHost,
	importRun: () => Promise<CommandRunModule> = () => import("./command-run.js"),
): WfCommandHandler {
	let memo: Promise<CommandRunModule> | undefined;
	let ready = false;

	const load = async (): Promise<CommandRunModule> => {
		memo ??= importRun();
		try {
			const mod = await memo;
			ready = true;
			return mod;
		} catch (e) {
			memo = undefined;
			throw e;
		}
	};

	const handler = async (args: string, ctx: WorkflowLauncherContext): Promise<void> => {
		// `ready`, not `memo`: an in-flight pre-warm still leaves the user
		// waiting, so the toast covers that window too.
		if (!ready && ctx.hasUI) ctx.ui.notify(MSG_RUNTIME_LOADING, "info");
		const mod = await load();
		// The launcher hands us an OBSERVER ctx (Pi's command ctx has no
		// spawnChild/maxConcurrency). The run-path is typed against the executor
		// ctx, but it never executes a stage on this ctx directly: with a provider
		// registered, runWorkflow builds the detached executor; with
		// none, the test/embedder contract guarantees an executor-capable ctx. So
		// narrow here at the single Pi→runtime boundary.
		return mod.handleWorkflowCommand(host, args, ctx as WorkflowHostContext);
	};

	return Object.assign(handler, {
		prewarm: async (): Promise<void> => {
			const mod = await load();
			// Also flush the lazy provider registries (built-ins DSL + skill
			// contracts) — the other ~550ms of first-/wf work. Both are memoized
			// latches; loadWorkflows joins the same promises later.
			await mod.prewarmWorkflowRuntime();
		},
	});
}

export function registerWorkflowCommand(host: WorkflowHost): void {
	const handler = makeWfHandler(host);
	host.registerCommand("wf", {
		description: CMD_DESCRIPTION,
		handler,
	});
	// Swallowed rejection is safe: load() already cleared the memo, so the
	// first real /wf retries and surfaces the error through its own path.
	// unref keeps the timer from holding a non-TUI embedder's process open.
	const timer = setTimeout(() => void handler.prewarm().catch(() => undefined), PREWARM_DELAY_MS);
	timer.unref?.();
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
