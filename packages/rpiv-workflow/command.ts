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
/** `--max-jumps <n>` — per-run override of the backward-jump cap; leading or trailing only, like `--name`. */
const LEADING_JUMPS_FLAG = /^--max-jumps\s+(\d+)\s*/;
const TRAILING_JUMPS_FLAG = /\s+--max-jumps\s+(\d+)$/;
/** `--max-laps <n>` — per-run override of the absolute lap ceiling; leading or trailing only, like `--name`. */
const LEADING_LAPS_FLAG = /^--max-laps\s+(\d+)\s*/;
const TRAILING_LAPS_FLAG = /\s+--max-laps\s+(\d+)$/;
const TRAILING_NAME_FLAG = /\s+--name\s+(\S+)$/;
/** Any surviving `--name` token after the leading/trailing extraction — input text, flagged. */
const MID_NAME_FLAG = /(?:^|\s)--name(?:\s|$)/;

/**
 * The extractable leading/trailing flags with their reader. One row per
 * flag; the fixpoint in `parseArgs` walks this table so a new flag is a
 * one-row addition, not another copy of the extraction sequence.
 *
 * Anchor invariant (the first-typed ranking depends on it): every `leading`
 * form is `^`-anchored so its match sits at the residual's head, and every
 * `trailing` form is `\s+`-prefixed and `$`-anchored so `match.index` is the
 * offset of the whitespace before the token. `parseArgs` turns those into
 * typed offsets; a row anchored any other way would rank wrong. Pinned by
 * `command.test.ts`, which also derives its permutation grammar from this
 * table. Exported for tests only.
 */
export const FLAG_EXTRACTORS = [
	{ key: "name", token: "--name", leading: LEADING_NAME_FLAG, trailing: TRAILING_NAME_FLAG },
	{ key: "maxBackwardJumps", token: "--max-jumps", leading: LEADING_JUMPS_FLAG, trailing: TRAILING_JUMPS_FLAG },
	{ key: "maxLaps", token: "--max-laps", leading: LEADING_LAPS_FLAG, trailing: TRAILING_LAPS_FLAG },
] as const;

type FlagKey = (typeof FLAG_EXTRACTORS)[number]["key"];

/** Record one extracted flag's raw token under its key. */
function assignFlag(
	flags: { name?: string; maxBackwardJumps?: number; maxLaps?: number },
	key: FlagKey,
	raw: string,
): void {
	if (key === "name") flags.name = raw;
	else if (key === "maxBackwardJumps") flags.maxBackwardJumps = Number(raw);
	else flags.maxLaps = Number(raw);
}

/** Flag tokens that appeared more than once (first-typed wins, the rest were stripped) — in `--name`, `--max-jumps`, `--max-laps` order. */
type DuplicateFlags = { duplicateFlags?: readonly string[] };

export type ParsedCommand =
	| ({
			/**
			 * Nothing to run: the residual after flag extraction was empty (list
			 * every workflow) or exactly one registered workflow name (`workflow`
			 * — show its details). Decided HERE, on the flag-stripped residual,
			 * so `/wf --max-jumps 6 review` previews `review` — the command layer
			 * never re-reads the raw line.
			 */
			kind: "preview";
			workflow?: string;
			name?: string;
			nameFlagIgnored?: boolean;
			maxBackwardJumps?: number;
			maxLaps?: number;
	  } & DuplicateFlags)
	| ({
			kind: "run";
			workflow: string;
			input: string;
			name?: string;
			nameFlagIgnored?: boolean;
			maxBackwardJumps?: number;
			maxLaps?: number;
	  } & DuplicateFlags)
	| ({
			kind: "resume";
			ref: string;
			droppedName?: string;
			nameFlagIgnored?: boolean;
			maxBackwardJumps?: number;
			maxLaps?: number;
	  } & DuplicateFlags);

/**
 * First token is a workflow name iff recognised; otherwise the whole arg is
 * input bound to the resolved default. When no default is registered (the
 * empty-registry case), the returned `workflow` is `""` and the orchestrator
 * surfaces `MSG_NO_WORKFLOWS_REGISTERED`. An empty residual, or a residual
 * that is exactly a workflow name, is a `preview` (list / details) — a `run`
 * always carries non-empty input.
 *
 * `--name <slug>` is honored ONLY in leading or trailing position (leading
 * wins when both are present). A `--name` that is neither — one that still
 * sits mid-input once every leading/trailing flag has been peeled — is the
 * user's own prompt text (`/wf fix the --name handling bug`): it stays in
 * the input untouched and `nameFlagIgnored` is set so the command layer can
 * warn. (A tail run like `go --name a --name b` is NOT mid-input: both peel
 * as trailing, the second as a duplicate.)
 * The two caps flags — `--max-jumps <n>` and `--max-laps <n>` — follow the
 * same rule (leading or trailing only, any relative order among the three);
 * a mid-position caps token stays in the input untouched and, unlike
 * `--name`, sets no flag.
 *
 * A flag repeated in a leading/trailing slot (`--max-jumps 6 --max-jumps 9
 * research …`) is consumed, not stranded: the FIRST-TYPED value wins in
 * every slot (each occurrence is ranked by its offset in the line, not by
 * extraction order), every other occurrence is stripped, and the token
 * lands in `duplicateFlags` so the command layer can warn.
 * Leaving the repeat in the residual would make `--max-jumps` the first
 * token — not a workflow name — and bind the whole line (the user's
 * intended workflow included) as prompt text for the DEFAULT workflow.
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
	const flags: { name?: string; maxBackwardJumps?: number; maxLaps?: number } = {};

	// Fixpoint flag extraction: each pass walks every flag and tries its
	// LEADING form first, then its TRAILING form, against the current
	// residual; a pass that extracts nothing ends the loop (every extraction
	// shortens the residual, so it terminates). A fixed extraction SEQUENCE
	// (jumps, then name) silently swallows a flag in same-slot permutations —
	// `--max-laps 8 --max-jumps 6 --name x` would strand `--max-jumps 6` as
	// input text; the fixpoint peels the leading/trailing positions in any
	// relative order. A flag that matches AGAIN after it was already
	// extracted is stripped and recorded as a duplicate — skipping it would
	// leave the repeat as the residual's first token and hijack workflow
	// resolution. The FIRST-TYPED value wins: extraction order is NOT typed
	// order (a trailing run peels from the end; a head flag can mask a
	// leading match for a whole pass), so every occurrence carries its offset
	// in the trimmed line and the smallest offset wins — no slot heuristic.
	// A mid-position token matches neither form and stays as input text
	// (silent for both caps flags; `--name` additionally warns via
	// MID_NAME_FLAG below).
	const extracted = new Map<FlagKey, number>(); // key → typed offset of the kept occurrence
	const repeated = new Set<FlagKey>();
	let consumedHead = 0; // chars sliced off the front of `trimmed` so far — restores typed offsets
	for (;;) {
		let extractedThisPass = false;
		for (const flag of FLAG_EXTRACTORS) {
			let raw: string;
			let offset: number;
			const lead = flag.leading.exec(trimmed);
			if (lead !== null) {
				raw = lead[1]!;
				offset = consumedHead;
				trimmed = trimmed.slice(lead[0].length);
				consumedHead += lead[0].length;
			} else {
				const trail = flag.trailing.exec(trimmed);
				if (trail === null) continue;
				raw = trail[1]!;
				offset = consumedHead + trail.index;
				trimmed = trimmed.slice(0, trail.index);
			}
			const prior = extracted.get(flag.key);
			if (prior === undefined || offset < prior) {
				assignFlag(flags, flag.key, raw);
				extracted.set(flag.key, offset);
			}
			if (prior !== undefined) repeated.add(flag.key);
			extractedThisPass = true;
		}
		if (!extractedThisPass) break;
	}
	// Reported in FLAG_EXTRACTORS order (not extraction order, which varies
	// with the line's shape) so the command layer's warnings are stable.
	const duplicates = FLAG_EXTRACTORS.filter((f) => repeated.has(f.key)).map((f) => f.token);
	const name = flags.name;
	// Conditional spread — an absent flag must stay an ABSENT key, not a
	// present-undefined one: ONE key-presence convention for every optional
	// field, pinned with `toStrictEqual` (a lenient `toEqual` equates the two
	// shapes and would mask a regression either way).
	const caps = {
		...(flags.maxBackwardJumps !== undefined ? { maxBackwardJumps: flags.maxBackwardJumps } : {}),
		...(flags.maxLaps !== undefined ? { maxLaps: flags.maxLaps } : {}),
		...(duplicates.length > 0 ? { duplicateFlags: duplicates } : {}),
	};
	const named = name !== undefined ? { name } : {};

	const nameFlagIgnored = MID_NAME_FLAG.test(trimmed);
	const ignored = nameFlagIgnored ? { nameFlagIgnored: true as const } : {};

	if (trimmed.startsWith("@")) {
		// @resume — name has no meaning here; carry it as `droppedName` so the
		// command layer can warn instead of silently dropping it.
		return {
			kind: "resume",
			ref: trimmed.slice(1).trim().split(/\s+/)[0] ?? "",
			...(name !== undefined ? { droppedName: name } : {}),
			...ignored,
			...caps,
		};
	}

	if (!trimmed) {
		return { kind: "preview", ...named, ...ignored, ...caps };
	}

	const firstSpace = trimmed.indexOf(" ");
	const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);

	if (loaded.workflowNames.has(firstToken)) {
		const remaining = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
		if (!remaining) {
			return { kind: "preview", workflow: firstToken, ...named, ...ignored, ...caps };
		}
		return { kind: "run", workflow: firstToken, input: remaining, ...named, ...ignored, ...caps };
	}

	return { kind: "run", workflow: loaded.default ?? "", input: trimmed, ...named, ...ignored, ...caps };
}
