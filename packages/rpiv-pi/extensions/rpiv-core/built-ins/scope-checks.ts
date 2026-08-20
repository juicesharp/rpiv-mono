/**
 * The lane scope floors: build's latest-plan variant and vet's full-history
 * union variant, sharing one scope-verdict envelope.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { handleToString, type Output, type ScriptContext } from "@juicesharp/rpiv-workflow/registration";
import { gitDirtyPaths, goalBaselinePath, readGoalBaseline, scopeExcess } from "./goal-baseline.js";
import { phaseFiles, planPhaseRecords, withTestTwins } from "./plan-phases.js";
import {
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
 * Shared scope-verdict envelope for the two lane scope floors: the
 * `{ dimension: "scope" }` data shape (carrying BOTH `pass` and the `verdict`
 * enum the `match("verdict", …)` route reads), the basename-keyed `VERDICT_DIR`
 * write, and the published-output return shape. Basename-keyed, NOT
 * round-stamped (unlike grade's timestamped slug): each fix-loop round
 * overwrites the file — the route reads the accumulating channel, and on disk
 * only the latest round's scope verdict matters; round-stamp here if a consumer
 * ever needs the history.
 */
const writeScopeVerdict = (
	artifact: FsArtifact,
	findings: { detail: string; where: string }[],
	pass: boolean,
	cwd: string,
): Omit<Output, "meta"> => {
	const data = {
		dimension: "scope",
		pass,
		verdict: pass ? "pass" : "fail",
		score: pass ? VERDICT_PASS_SCORE : VERDICT_FAIL_SCORE,
		severity: pass ? "none" : "high",
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
 * Deterministic lane-level scope floor — the structural backstop beneath the
 * LLM quality gates. After build's `implement` lane runs (now dep-gated and, as
 * of this phase's unpin, concurrent up to the host cap), this checks the working
 * tree's dirty set against the plan's declared write-set (the union of every
 * phase's `files:`, twin-expanded via `withTestTwins`): any dirty path the run
 * wrote that is NOT in `declared`, NOT
 * pre-existing at the run-start baseline, and NOT under a bookkeeping tree is a
 * scope violation — a phase escaped the upstream write-scope discipline and
 * rewrote the wider tree, corrupting (or about to corrupt) a concurrent
 * sibling's in-flight edit. Fail ⇒ STOP (no fix arm): a scope violation is a
 * plan-vs-tree drift the agent must reconcile manually, not an auto-fix loop.
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
 * `data` carries BOTH a `pass` boolean AND a `verdict` enum ("pass" | "fail")
 * that always agree (`verdict: pass ? "pass" : "fail"`). The route is the
 * established `match("verdict", …)` gate idiom (mirrors `validate`'s own route:
 * `match("verdict", { commit: "pass" }, …)` — no-match ⇒ STOP, the same fail
 * behavior). It is deliberately NOT the `defineRoute`/`allDimensionsPass`
 * pattern the citation floors use: `allDimensionsPass` applies a severity floor
 * (pass === true || severity low/none), so a failing scope check rated low
 * severity would silently pass the gate — the exact escape class the lane floor
 * exists to catch. The `from` form suppresses the `READS_DATA` outputSchema lint,
 * so no schema is declared on the script stage (matching `slice-check`/
 * `plan-cite-check`).
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
	const dirty = gitDirtyPaths(cwd);

	const excess = scopeExcess(dirty, baseline, declared);
	const findings = excess.map((path) => ({
		detail: `Undeclared write ${path} — the working tree is dirty outside the plan's declared write-set (the union of every phase's 'files:'). The implement lane runs sibling phases concurrently in one tree, so a phase that wrote outside its 'files:' has stepped on (or is about to step on) a sibling's in-flight edit. Reconcile the phase's 'files:' with what it actually writes, or move the write into the owning phase.`,
		where: path,
	}));
	return writeScopeVerdict(latest as FsArtifact, findings, findings.length === 0, cwd);
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
 * baseline subtraction, dirty-set read, and the shared `dimension: "scope"`
 * verdict envelope via `writeScopeVerdict` — is build's floor verbatim: pass ⇒
 * reconcile; a `fail` or missing verdict ⇒ STOP (no fix arm).
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
	const dirty = gitDirtyPaths(cwd);

	// Shared core: subtract the run's bookkeeping dirs (`.rpiv/`,
	// `thoughts/`) and the run-start baseline; empty-`declared` ⇒ `[]` (degradation
	// ⇒ inert floor — a fully `files:`-less plan never false-fails). Twin-expanded
	// like build's floor: a declared file carries its co-located test twin.
	const excess = scopeExcess(dirty, baseline, withTestTwins([...declared]));
	const findings = excess.map((p) => ({
		detail: `${p}: written by the implement lane but not declared in any plan iteration's \`files:\` set. A phase may write only its declared paths (the write-scope rule); declare the path in the owning phase's \`files:\` or drop the write.`,
		where: p,
	}));
	return writeScopeVerdict(latest, findings, findings.length === 0, cwd);
};

export { implementScopeCheck, implementScopeCheckVet };
