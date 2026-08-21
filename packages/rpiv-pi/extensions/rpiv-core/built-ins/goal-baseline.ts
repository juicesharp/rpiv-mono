/**
 * The goal channel (verbatim brief capture) and the run-start git baseline the
 * scope floors and the validate/commit prompts consume.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	handleToString,
	type Output,
	type PromptFn,
	type RunView,
	type ScriptContext,
} from "@juicesharp/rpiv-workflow/registration";
import { latestFsArtifact, readArtifactFile } from "./shared.js";

/** Bucket directory the goal capture writes into — build's verbatim-brief channel. */
const GOAL_DIR = ".rpiv/artifacts/goal";

/**
 * Capture the user's brief VERBATIM as build's `goal` channel — the north-star
 * artifact the judgment seams anchor against (the grade panels'
 * completeness/correctness dimensions and `validate`). A script stage (no LLM)
 * so nothing refracts the wording: `research` carries the goal's intent,
 * grounded and expanded, but explicit user constraints ("keep it minimal",
 * "don't touch auth") routinely don't survive that refraction — the raw file
 * is the only artifact that holds them. The body is the brief byte-for-byte;
 * added frontmatter or headers would pollute "the user's exact words".
 *
 * Publishes under its record key (`goal`): a script stage may not carry an
 * `outcome` (`script-with-outcome` is a load error) and needs none — the
 * returned envelope IS the output. Timestamped filename so concurrent/repeat
 * runs never collide; on resume the recorded path replays from the JSONL
 * trail, so the fanout `units()` closures reading the channel stay
 * deterministic.
 */
const captureGoal = ({ state, cwd }: ScriptContext): Omit<Output, "meta"> => {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const rel = join(GOAL_DIR, `goal-${stamp}.md`);
	mkdirSync(join(cwd, GOAL_DIR), { recursive: true });
	writeFileSync(join(cwd, rel), state.originalInput, "utf-8");
	// Snapshot the paths ALREADY dirty before the run touched anything — the
	// validate stage judges working-tree scope criteria against the run's own
	// delta, and the commit skill fences these paths off its commit. Timestamped
	// like the goal file itself (concurrent/repeat runs never read each other's
	// snapshot — there is NO fixed rendezvous path) and published on the goal
	// channel with role "baseline", so the JSONL trail carries the exact path to
	// every consumer and replays it deterministically on resume. Best-effort: a
	// non-repo / git-unavailable cwd writes an empty snapshot, so consumers
	// degrade to baseline-less behavior rather than failing the goal capture.
	const baselineRel = join(GOAL_DIR, `baseline-${stamp}.json`);
	writeCommitBaseline(cwd, baselineRel);
	return {
		kind: "md",
		// Order is load-bearing: `latestFsArtifact(state, "goal")` takes the FIRST
		// fs artifact — the goal md stays the channel's face (grade --goal flags,
		// rolling primary); the baseline rides behind it under its role.
		artifacts: [
			{ handle: { kind: "fs", path: rel } },
			{ handle: { kind: "fs", path: baselineRel }, role: "baseline" },
		],
		data: {},
	};
};

/** One parsed `git status --porcelain`/`--short` line: the 2-char `XY` status
 *  code plus the resolved path. `xy === "??"` is the untracked class — the only
 *  code whose content cannot have overwritten anything a phase owns, which is
 *  what the scope floor's quarantine partition keys on. */
interface GitStatusEntry {
	xy: string;
	path: string;
}

/** Parse `git status --porcelain`/`--short` output into `{ xy, path }` entries.
 *  Keeps the 2-char `XY` status code and resolves rename targets
 *  (`XY old -> new` → `new`), so the two output forms (`--porcelain`, `--short`)
 *  normalize identically. A porcelain line is always `XY <path>` or
 *  `XY <old> -> <new>`; blank lines drop. */
const parseGitStatusEntries = (out: string): GitStatusEntry[] =>
	out
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => {
			const rest = l.slice(3).trim();
			const arrow = rest.indexOf(" -> ");
			return { xy: l.slice(0, 2), path: arrow >= 0 ? rest.slice(arrow + 4).trim() : rest };
		});

/** Path-only projection of `parseGitStatusEntries` — the baseline writer's shape. */
const parseGitStatusPaths = (out: string): string[] => parseGitStatusEntries(out).map((e) => e.path);

/** Record the paths dirty before the run to `rel` (best-effort; empty on any git failure). */
const writeCommitBaseline = (cwd: string, rel: string): void => {
	let paths: string[] = [];
	try {
		// stdio: stderr ignored — without this, git's "fatal: not a git repository"
		// leaks to the parent's stderr even though the catch treats it as a
		// supported silent degrade (best-effort baseline, empty on failure).
		// -uall: git collapses an untracked directory to one `dir/` entry by
		// default, so a phase's brand-new files under a new directory would never
		// string-match their `files:` declarations at the scope floor. Enumerate
		// every file; the baseline and both scope checks MUST share this flag or
		// their path universes diverge.
		const out = execFileSync("git", ["status", "--short", "--untracked-files=all"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		paths = parseGitStatusPaths(out);
	} catch {
		paths = [];
	}
	mkdirSync(dirname(join(cwd, rel)), { recursive: true });
	writeFileSync(join(cwd, rel), JSON.stringify({ paths }, null, 2), "utf-8");
};

/** The run-start pre-existing-dirty snapshot riding the goal channel (role "baseline"). */
const goalBaselinePath = (state: RunView): string | undefined => {
	const a = state.named.goal?.at(-1)?.artifacts.find((x) => x.role === "baseline" && x.handle.kind === "fs");
	return a ? handleToString(a.handle) : undefined;
};

/**
 * Read the run-start pre-existing-dirty baseline off the goal channel's
 * "baseline" artifact: the `{ paths }` JSON the baseline writer records. Best-
 * effort — `[]` on no path (no `goal` stage), an unreadable file, or a `paths`
 * value that isn't a string array, so the scope floor degrades to baseline-less
 * (nothing subtracted) rather than throwing.
 */
const readGoalBaseline = (path: string | undefined, cwd: string): string[] => {
	if (!path) return [];
	try {
		const parsed = JSON.parse(readArtifactFile(path, cwd)) as { paths?: unknown };
		const p = parsed.paths;
		return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
};

/**
 * Current dirty set via `git status --porcelain`, as `{ xy, path }` entries
 * (rename targets resolved by the shared parser) — the scope floors read the
 * paths AND partition on the `??` untracked code. Best-effort — `[]` on a
 * non-repo / git-missing tree (the scope floor degrades to unguarded rather
 * than failing a non-repo run; the catch treats that as a supported silent
 * degrade). stdio: stderr is ignored, otherwise git's "fatal: not a git
 * repository" leaks to the parent's stderr despite the catch. `-uall`
 * enumerates untracked files individually (a collapsed `newdir/` entry can
 * never string-match a declared `files:` path) — the baseline writer and both
 * scope checks MUST share this flag or their path universes diverge.
 */
const gitDirtyEntries = (cwd: string): GitStatusEntry[] => {
	try {
		const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return parseGitStatusEntries(out);
	} catch {
		return [];
	}
};

/** Paths under these run-bookkeeping trees are NEVER a scope violation — the run
 *  legitimately writes its artifacts/notes/trails here regardless of phase scope. */
const SCOPE_BOOKKEEPING_DIRS: ReadonlySet<string> = new Set([".rpiv", "thoughts"]);

/**
 * The lane-level scope floor's pure core. Returns the dirty paths that are NOT
 * explained by the run's declared write-set: a path is excess when it is outside
 * `declared`, was NOT dirty at the run-start `baseline`, and is NOT under a
 * bookkeeping tree (`.rpiv/`, `thoughts/`). The `implement` lane declared-set is
 * the union of its plan's per-phase `files:`; `validate`'s whole-repo
 * build/test writes are owned by a later stage, never by a phase.
 *
 * Empty `declared` ⇒ `[]` (degradation): a `files:`-less plan is serial-by-
 * construction under the DAG fanout's missing-`files:` clause (full dep chain ⇒
 * one phase per wave), so there is no concurrent sibling to corrupt and nothing
 * to guard — the floor returns no excess and never false-fails a legacy plan.
 * `validate`'s whole-repo writes are out of scope here regardless: they belong
 * to `validate`, which runs AFTER this gate, so the lane's dirty set never
 * carries them at the scope-check's read time.
 *
 * This is deliberately LANE-level, not per-phase: under concurrency, a dirty
 * path cannot be attributed to the specific phase that wrote it, so per-phase
 * enforcement would be unsound. The per-phase discipline is enforced upstream
 * by the plan-authoring write-scope rule + the plan-time coverage floor;
 * this lane floor is the structural backstop that catches a phase that escaped
 * upstream discipline. Returns one entry per excess path.
 */
const scopeExcess = (dirty: readonly string[], baseline: readonly string[], declared: readonly string[]): string[] => {
	if (declared.length === 0) return [];
	const declaredSet = new Set(declared);
	const baselineSet = new Set(baseline);
	const excess: string[] = [];
	for (const path of dirty) {
		if (declaredSet.has(path) || baselineSet.has(path)) continue;
		const top = path.split("/")[0];
		if (SCOPE_BOOKKEEPING_DIRS.has(top)) continue;
		excess.push(path);
	}
	return excess;
};

/**
 * Build's validate dispatch: the latest synthesized plan plus the goal and
 * run-start-baseline flags. Sourcing the plan from the NAMED channel (not the
 * rolling primary) is load-bearing: `code-grade` is a produces-fanout, so
 * after the code gate the rolling primary is the LAST VERDICT JSON
 * (`placeFanoutOutput` advances it per unit) and `implement` (acts) leaves it
 * there — a plain `produces()` validate would receive a verdict path as its
 * "plan". A prompt stage owns its whole message, so the `/skill:validate`
 * prefix is explicit (polish precedent).
 *
 * `--baseline` threads the pre-existing-dirty snapshot `goal` captured at run
 * start, so validate judges working-tree scope criteria ("only these files
 * touched") against the RUN'S OWN delta instead of failing on dirt that was
 * on disk before stage one — the same fence the commit dispatch applies. The
 * path comes off the goal channel (this run's snapshot, replayed from the
 * JSONL trail on resume), never a shared file another run could overwrite.
 *
 * `--scope` threads the scope floor's latest verdict JSON so validate
 * ADJUDICATES tracked-excess findings the floor demoted instead of halting on
 * (the `--cite-check` pattern: the deterministic floor produces evidence, the
 * LLM judge rules). Absent ONLY when the floor never ran — `writeScopeVerdict`
 * publishes on a clean pass too, so every post-floor dispatch carries the flag
 * and the skill's adjudication step (verdict read + unconditional
 * quarantine-manifest check) decides what there is to rule.
 */
const VALIDATE_GOAL_PROMPT: PromptFn = ({ state }) => {
	const parts = ["/skill:validate"];
	const plan = latestFsArtifact(state, "plans");
	if (plan?.handle.kind === "fs") parts.push(handleToString(plan.handle));
	const goal = latestFsArtifact(state, "goal");
	if (goal?.handle.kind === "fs") parts.push(`--goal ${handleToString(goal.handle)}`);
	const baseline = goalBaselinePath(state);
	if (baseline) parts.push(`--baseline ${baseline}`);
	const scope = latestFsArtifact(state, "implement-scope-check");
	if (scope?.handle.kind === "fs") parts.push(`--scope ${handleToString(scope.handle)}`);
	return parts.join(" ");
};

/**
 * Build's commit dispatch: thread the run-start baseline so the commit skill
 * fences pre-existing dirt off the commit — `git-changes.mjs` takes the path
 * as a flag, so there is no fixed rendezvous file for concurrent/repeat runs
 * to clobber. Prompt-dispatched deliberately: the inherited rolling primary
 * (the validation report path) was reaching the skill as a meaningless
 * message-hint argument anyway; owning the message replaces that noise with
 * the one flag the skill actually consumes.
 */
const COMMIT_BASELINE_PROMPT: PromptFn = ({ state }) => {
	const baseline = goalBaselinePath(state);
	return baseline ? `/skill:commit --baseline ${baseline}` : "/skill:commit";
};

export type { GitStatusEntry };
export {
	COMMIT_BASELINE_PROMPT,
	captureGoal,
	gitDirtyEntries,
	goalBaselinePath,
	readGoalBaseline,
	scopeExcess,
	VALIDATE_GOAL_PROMPT,
};
