/**
 * The lane scope floors: build's latest-plan variant and vet's full-history
 * union variant, sharing one scope-verdict envelope — plus the deterministic
 * `scope-quarantine` remedy arm the untracked-only verdict routes to.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { handleToString, type Output, type ScriptContext } from "@juicesharp/rpiv-workflow/registration";
import { gitDirtyEntries, goalBaselinePath, readGoalBaseline, scopeExcess } from "./goal-baseline.js";
import { phaseFiles, planPhaseRecords, withTestTwins } from "./plan-phases.js";
import {
	containedPath,
	type FsArtifact,
	haltPreflight,
	latestFsArtifact,
	readArtifactFile,
	VERDICT_DIR,
	VERDICT_FAIL_SCORE,
	VERDICT_PASS_SCORE,
} from "./shared.js";

/**
 * Union the per-phase `files:` write-set declared across the FULL `plans`
 * channel history. vet's review-fix loop appends a DISTINCT non-superseding fix
 * plan per iteration (a `produces` stage APPENDS to its named slot, and backward
 * jumps don't reset channels), so a path a prior plan legitimately wrote is not
 * excess against the latest plan — hence the union, not latest-only.
 *
 * Reads every fs artifact in every plan via `planPhaseRecords` + `phaseFiles`,
 * skipping unreadable/unparseable plans (the union stays the sum of the
 * parseable ones; a plan too malformed to parse is a `plan-cite-check`/
 * `plan-fix` concern, not scope). `latest` is the FIRST fs artifact of the LAST
 * plan carrying one (mirrors `latestFsArtifact`'s last-channel-entry / first-fs-
 * artifact resolution) — it keys the basename-keyed verdict path + `artifact`
 * field.
 */
const unionDeclaredWriteSet = (
	plans: readonly Output[],
	cwd: string,
): { declared: Set<string>; latest: FsArtifact | undefined } => {
	const declared = new Set<string>();
	let latest: FsArtifact | undefined;
	for (const out of plans) {
		// Per plan, capture its FIRST fs artifact as the `latest` candidate so the
		// LAST plan with an fs artifact wins (mirrors `latestFsArtifact`'s
		// `.at(-1)?.artifacts.find(kind==="fs")` — last channel entry, first fs
		// artifact in it — which keys the verdict path + `artifact` field).
		let firstFsInPlan: FsArtifact | undefined;
		for (const a of out.artifacts) {
			if (a.handle.kind !== "fs") continue; // fs-artifact filter
			if (!firstFsInPlan) firstFsInPlan = a as FsArtifact;
			const path = a.handle.path;
			try {
				const content = readArtifactFile(path, cwd);
				for (const r of planPhaseRecords(content, "implement-scope-check", path)) {
					for (const f of phaseFiles(r.entry)) declared.add(f);
				}
			} catch {
				// Unreadable/unparseable plan: don't widen the declared set on error —
				// the union stays the sum of the parseable plans. (A plan so malformed
				// it can't be parsed is a `plan-cite-check`/`plan-fix` concern, not scope.)
			}
		}
		if (firstFsInPlan) latest = firstFsInPlan;
	}
	return { declared, latest };
};

/**
 * The scope floor's routing verdict, tiered by what a deterministic check can
 * actually know about each excess path (mirroring the citation floor's
 * advisory tiering — demote where a remedy or adjudicator exists, halt only on
 * data integrity):
 *   - "pass"           — no excess. Onward to reconcile.
 *   - "untracked-only" — EVERY excess path is a run-created untracked file
 *     (`??`): provably not in the run-start baseline, owned by no phase, and
 *     movable without losing a byte. Routed to the deterministic
 *     `scope-quarantine` arm, then re-checked.
 *   - "excess"         — at least one TRACKED file was modified outside the
 *     declared write-set. The floor cannot distinguish benign churn (a
 *     lockfile touched by an install, a regenerated snapshot) from a real
 *     cross-phase stomp, so it no longer halts: the run continues to
 *     reconcile/validate and VALIDATE adjudicates the recorded findings (the
 *     `--scope` thread on `VALIDATE_GOAL_PROMPT` — the `--cite-check`
 *     pattern), forcing `verdict: fail` on any write it cannot explain.
 * A missing/unexpected verdict still terminates at the route (STOP) — the
 * same integrity clause every de-halting change has preserved.
 */
type ScopeVerdict = "pass" | "untracked-only" | "excess";

/**
 * Shared scope-verdict envelope for the two lane scope floors: the
 * `{ dimension: "scope" }` data shape (carrying BOTH `pass` and the tiered
 * `verdict` enum the route + validate adjudication read), the basename-keyed
 * `VERDICT_DIR` write, and the published-output return shape. Basename-keyed,
 * NOT round-stamped (unlike grade's timestamped slug): each fix-loop round
 * overwrites the file — the route reads the accumulating channel, and on disk
 * only the latest round's scope verdict matters; round-stamp here if a consumer
 * ever needs the history. Severity mirrors the tier ("medium" untracked-only,
 * "high" tracked excess) for TRAIL LEGIBILITY ONLY — no consumer folds it:
 * routing reads `verdict`, and validate's adjudication reads `findings`.
 */
const writeScopeVerdict = (
	artifact: FsArtifact,
	findings: { detail: string; where: string }[],
	verdict: ScopeVerdict,
	cwd: string,
): Omit<Output, "meta"> => {
	const pass = verdict === "pass";
	const data = {
		dimension: "scope",
		pass,
		verdict,
		score: pass ? VERDICT_PASS_SCORE : VERDICT_FAIL_SCORE,
		severity: pass ? "none" : verdict === "untracked-only" ? "medium" : "high",
		artifact: handleToString(artifact.handle),
		findings,
		feedback: pass ? "" : findings.map((f) => f.detail).join(" "),
	};
	const rel = join(VERDICT_DIR, `implement-scope-check__${basename(artifact.handle.path, ".md")}.json`);
	mkdirSync(join(cwd, VERDICT_DIR), { recursive: true });
	writeFileSync(join(cwd, rel), JSON.stringify(data, null, 2), "utf-8");
	return { kind: "json", artifacts: [{ handle: { kind: "fs", path: rel } }], data };
};

/**
 * Partition the excess set by git's own tracking state and fold it to the
 * tiered verdict: `??` is the only status code whose content cannot have
 * overwritten anything a phase owns, so an all-untracked excess is the
 * deterministically-remediable class and ANY tracked path escalates the whole
 * verdict to "excess" (one stomp taints the tree; quarantining the untracked
 * remainder wouldn't make it judgeable-clean).
 *
 * Input assumption, pinned: ONLY `??` counts as untracked. A STAGED new file
 * ("A ") deliberately classifies as tracked excess — the conservative
 * direction (staged work is adjudicated in place, never quarantined). Nothing
 * in the lane stages files between the baseline snapshot and this floor today
 * (the only `git add` is commit's, post-floor); revisit if that changes.
 */
const foldScopeVerdict = (excess: readonly string[], untracked: ReadonlySet<string>): ScopeVerdict =>
	excess.length === 0 ? "pass" : excess.every((p) => untracked.has(p)) ? "untracked-only" : "excess";

/** Per-path finding for the tiered verdict. The floor is workflow-agnostic, so
 *  each detail describes the TIER (what the path is and why it was flagged),
 *  never the route — what happens next (quarantine arm, validate adjudication,
 *  or a loop-less workflow's terminal stop) is the wiring workflow's edge, and
 *  baking a route into text persisted on disk would lie under any other wiring. */
const scopeFinding = (path: string, untracked: boolean): { detail: string; where: string } => ({
	detail: untracked
		? `Run-created untracked file ${path} outside the plan's declared write-set (the union of every phase's 'files:'). Untracked excess is the deterministically-remediable tier: a workflow wiring the scope-quarantine arm MOVES it (never deletes) under .rpiv/tmp/scope-quarantine/ with a manifest naming the destination — a load-bearing file landing there means its phase forgot to declare it in 'files:'. In a loop-less workflow this verdict is terminal.`
		: `Undeclared write ${path} — a TRACKED file is dirty outside the plan's declared write-set (the union of every phase's 'files:'). The implement lane runs sibling phases concurrently in one tree, so a phase that wrote outside its 'files:' may have stepped on a sibling's in-flight edit — or this is benign churn (a lockfile, a regenerated artifact) a declared phase's own commands produced. A deterministic floor cannot tell these apart, so the finding is recorded for the wiring workflow's adjudicator (build threads it to validate via --scope; vet's review loop sees the whole diff); an out-of-scope write the adjudicator cannot explain blocks. In a loop-less workflow this verdict is terminal.`,
	where: path,
});

/**
 * Deterministic lane-level scope floor — the structural backstop beneath the
 * LLM quality gates. After build's `implement` lane runs (now dep-gated and, as
 * of this phase's unpin, concurrent up to the host cap), this checks the working
 * tree's dirty set against the plan's declared write-set (the union of every
 * phase's `files:`, twin-expanded via `withTestTwins`): any dirty path the run
 * wrote that is NOT in `declared`, NOT
 * pre-existing at the run-start baseline, and NOT under a bookkeeping tree is a
 * scope violation — a phase escaped the upstream write-scope discipline. The
 * floor no longer halts on its own findings (see `ScopeVerdict`): untracked
 * excess routes to the deterministic `scope-quarantine` arm; tracked excess is
 * recorded and adjudicated downstream by validate. Only a missing/unexpected
 * verdict remains terminal at the route.
 *
 * Reads the plan with the SAME inline shape `planCitationCheck(who)` uses —
 * `latestFsArtifact(state,"plans")` + `readArtifactFile` + `planPhaseRecords` +
 * Phase 1's `phaseFiles` — NOT Phase 2's `readPlanPhaseRecords(state,cwd,who)`,
 * because this stage needs the plan HANDLE for the `artifact` field and the
 * basename-keyed verdict path, which the `who`-attributed helper collapses. The
 * baseline is the run-start snapshot on the `goal` channel (`goalBaselinePath`,
 * the same reader `VALIDATE_GOAL_PROMPT` and `COMMIT_BASELINE_PROMPT` use); the
 * dirty set is `git status --porcelain` (non-repo / git-missing ⇒ empty dirty ⇒
 * pass — the lane degrades to unguarded rather than failing a non-repo run).
 * Emits one `{ dimension: "scope" }` verdict, basename-keyed off the plan ⇒
 * idempotent across the build loop.
 *
 * `data` carries a `pass` boolean (true only on `verdict: "pass"`) AND the
 * tiered `verdict` enum (`ScopeVerdict`) the route branches on. The route is a
 * `defineRoute` over the stage's own channel (a `match` cannot send two enum
 * values — "pass" and "excess" — to the same `reconcile` target): "pass" and
 * "excess" continue to reconcile, "untracked-only" takes the quarantine arm,
 * and anything else (missing/corrupt verdict) returns STOP — the integrity
 * clause every de-halting change has preserved. It is deliberately NOT the
 * `allDimensionsPass` severity-floor fold: the tier is explicit in the enum,
 * never inferred from severity. `readsData: false` (the route consults the
 * channel, not the projected output), so no schema is declared on the script
 * stage (matching `slice-check`/`plan-cite-check`).
 */
const implementScopeCheck = ({ state, cwd }: ScriptContext): Omit<Output, "meta"> => {
	const latest = latestFsArtifact(state, "plans");
	if (latest?.handle.kind !== "fs") {
		throw haltPreflight(
			"implement-scope-check",
			"implement-scope-check: no plan to scope-check",
			"implement-scope-check: no fs artifact on the 'plans' channel — implement must run before the scope check",
		);
	}
	const body = readArtifactFile(latest.handle.path, cwd);
	const records = planPhaseRecords(body, "implement-scope-check", latest.handle.path);
	// Declared write-set = union of every phase's `files:` (via `phaseFiles`),
	// expanded with co-located test twins (`withTestTwins`) — a signature change
	// in a declared file legitimately drags its twin's assertions along.
	// A `files:`-less plan yields `[]` ⇒ `scopeExcess` returns `[]` ⇒ inert floor.
	const declared = withTestTwins(records.flatMap((r) => phaseFiles(r.entry)));

	// Run-start baseline (goal channel, role "baseline") + current dirty set —
	// both best-effort (absent / non-repo ⇒ `[]`); see the two helpers' docs.
	const baseline = readGoalBaseline(goalBaselinePath(state), cwd);
	const entries = gitDirtyEntries(cwd);

	const excess = scopeExcess(
		entries.map((e) => e.path),
		baseline,
		declared,
	);
	const untracked = new Set(entries.filter((e) => e.xy === "??").map((e) => e.path));
	const findings = excess.map((path) => scopeFinding(path, untracked.has(path)));
	return writeScopeVerdict(latest as FsArtifact, findings, foldScopeVerdict(excess, untracked), cwd);
};

/**
 * vet's `implement-scope-check` — the loop-aware scope floor, twin of build's
 * `implementScopeCheck`. vet differs in ONE place: build's extra `plans`
 * entries are superseding amendments (`plan-fix` re-publishes the whole plan)
 * so build reads latest-only; vet's review-fix loop pushes a DISTINCT
 * non-superseding fix plan per iteration (completing a `produces` stage APPENDS
 * to its named slot, and backward jumps don't reset channels), so `declared` is
 * the UNION of `phaseFiles` over the FULL `state.named.plans` history — a path
 * a prior iteration's plan legitimately wrote is not excess against the latest
 * plan. The latest plan's handle keys the basename-keyed verdict path
 * (idempotent across fix rounds) and the `artifact` field. Everything else —
 * baseline subtraction, dirty-set read, the tiered `ScopeVerdict` fold, and
 * the shared `dimension: "scope"` verdict envelope via `writeScopeVerdict` —
 * is build's floor verbatim: pass/excess ⇒ reconcile (excess adjudicated by
 * the review loop, which sees the whole diff), untracked-only ⇒ quarantine,
 * missing verdict ⇒ STOP.
 */
const implementScopeCheckVet = ({ state, cwd }: ScriptContext): Omit<Output, "meta"> => {
	// Declared set = UNION of `phaseFiles` over EVERY non-failed plan on the channel.
	// The fs-artifact filter skips failed/unfilled entries (an Output with no fs
	// handle contributed no plan to read).
	const { declared, latest } = unionDeclaredWriteSet(state.named.plans ?? [], cwd);
	if (!latest) {
		throw haltPreflight(
			"implement-scope-check",
			"implement-scope-check: no plan to check",
			"implement-scope-check: no fs plan artifact on the 'plans' channel — blueprint/implement must run before the scope check",
		);
	}

	// Run-start baseline (goal channel, role "baseline") + current dirty set —
	// both best-effort (absent / non-repo ⇒ `[]`); see the two helpers' docs.
	const baseline = readGoalBaseline(goalBaselinePath(state), cwd);
	const entries = gitDirtyEntries(cwd);

	// Shared core: subtract the run's bookkeeping dirs (`.rpiv/`,
	// `thoughts/`) and the run-start baseline; empty-`declared` ⇒ `[]` (degradation
	// ⇒ inert floor — a fully `files:`-less plan never false-fails). Twin-expanded
	// like build's floor: a declared file carries its co-located test twin.
	const excess = scopeExcess(
		entries.map((e) => e.path),
		baseline,
		withTestTwins([...declared]),
	);
	const untracked = new Set(entries.filter((e) => e.xy === "??").map((e) => e.path));
	const findings = excess.map((p) => scopeFinding(p, untracked.has(p)));
	return writeScopeVerdict(latest, findings, foldScopeVerdict(excess, untracked), cwd);
};

/** Bookkeeping home for quarantined excess — under `.rpiv/`, so already exempt
 *  from the floor (`SCOPE_BOOKKEEPING_DIRS`) and outside every plan's write-set. */
const QUARANTINE_DIR = ".rpiv/tmp/scope-quarantine";

/** One quarantine move record: the path the floor flagged and where it went. */
type QuarantineMove = { from: string; to: string };

/**
 * Read a prior round's quarantine manifest — best-effort `{ moved: [] }` on a
 * missing/corrupt file. The manifest is the CROSS-ROUND record validate's
 * adjudication reads (its glob finds this basename-keyed file), so each round
 * MERGES into it rather than replacing: a validate-fix re-entry that
 * quarantines again must not erase round 1's move records.
 */
const readQuarantineManifest = (rel: string, cwd: string): { moved: QuarantineMove[] } => {
	try {
		const parsed = JSON.parse(readArtifactFile(rel, cwd)) as { moved?: unknown };
		const moved = Array.isArray(parsed.moved)
			? parsed.moved.filter(
					(m): m is QuarantineMove =>
						typeof (m as QuarantineMove)?.from === "string" && typeof (m as QuarantineMove)?.to === "string",
				)
			: [];
		return { moved };
	} catch {
		return { moved: [] };
	}
};

/**
 * Deterministic remedy arm for an "untracked-only" scope verdict: MOVE (never
 * delete) each excess path into `.rpiv/tmp/scope-quarantine/<path>`, preserving
 * relative structure, and record it in the manifest — the ADJUDICATION RECORD
 * validate reads unconditionally (the post-quarantine re-check threads a clean
 * `pass` verdict, so the manifest is the only surviving record of what moved
 * and why). The edge back to `implement-scope-check` is a plain string hop
 * (non-counted, mirroring `validate-fix → implement-scope-check`) with
 * guaranteed progress: quarantined paths leave the dirty set, so the re-check
 * either passes or reveals tracked drift — at most one quarantine hop per gate
 * entry, no new loop budget.
 *
 * Manifest semantics: MERGED across rounds (`moved` accumulates; a re-moved
 * `from` path supersedes its prior entry), written in a `finally` so a
 * mid-loop fs throw still lands every completed move on disk before the stage
 * fails — fail-loud with the files accounted for, never moved-but-unrecorded.
 * `refused` records this round's declined paths (not untracked at move time,
 * or cwd-escaping) so a skipped path is observable without re-running the
 * floor; refusals are per-round observations, not history.
 *
 * Fail-closed: a path that escapes `cwd` is refused via `containedPath` (left
 * in place — the re-check re-judges it), a path no longer untracked at move
 * time is never touched, and a failing rename THROWS (the stage fails, the run
 * stops with the real fs error) rather than ping-ponging the gate on a stuck
 * path.
 */
const scopeQuarantine = ({ state, cwd }: ScriptContext): Omit<Output, "meta"> => {
	const verdict = state.named["implement-scope-check"]?.at(-1)?.data as
		| { findings?: { where?: unknown }[] }
		| undefined;
	const listed = (verdict?.findings ?? []).map((f) => f.where).filter((w): w is string => typeof w === "string");
	// Fresh status read — move ONLY what is untracked RIGHT NOW. A path that got
	// tracked/settled since the check is never touched (the re-check re-judges it).
	const untracked = new Set(
		gitDirtyEntries(cwd)
			.filter((e) => e.xy === "??")
			.map((e) => e.path),
	);
	// Manifest path + prior rounds resolved BEFORE the move loop, so the finally
	// below can always write the merged record.
	const plan = latestFsArtifact(state, "plans");
	const key = plan?.handle.kind === "fs" ? basename(plan.handle.path, ".md") : "no-plan";
	const rel = join(VERDICT_DIR, `scope-quarantine__${key}.json`);
	const prior = readQuarantineManifest(rel, cwd);

	const moved: QuarantineMove[] = [];
	const refused: { path: string; reason: string }[] = [];
	try {
		for (const path of listed) {
			if (!untracked.has(path)) {
				refused.push({ path, reason: "not-untracked-at-move-time" });
				continue;
			}
			const abs = containedPath(cwd, path);
			if (!abs) {
				refused.push({ path, reason: "escapes-cwd" });
				continue;
			}
			const destRel = join(QUARANTINE_DIR, path);
			mkdirSync(dirname(join(cwd, destRel)), { recursive: true });
			renameSync(abs, join(cwd, destRel));
			moved.push({ from: path, to: destRel });
		}
	} finally {
		// Partial-progress write: on a mid-loop throw, every completed move is on
		// disk before the failure propagates. Merge: current rounds' moves
		// supersede a prior entry for the same `from`; everything else survives.
		const kept = prior.moved.filter((p) => !moved.some((m) => m.from === p.from));
		mkdirSync(join(cwd, VERDICT_DIR), { recursive: true });
		writeFileSync(join(cwd, rel), JSON.stringify({ moved: [...kept, ...moved], refused }, null, 2), "utf-8");
	}
	return { kind: "json", artifacts: [{ handle: { kind: "fs", path: rel } }], data: { moved, refused } };
};

export type { ScopeVerdict };
export { implementScopeCheck, implementScopeCheckVet, scopeQuarantine };
