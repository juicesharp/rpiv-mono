/**
 * The plan-prior pipeline: pre-fix plan snapshots, section diffs, the
 * surgical-fix guard, and the risk-duty demotion stamp.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
	type Artifact,
	handleToString,
	type Output,
	type RunView,
	type ScriptContext,
} from "@juicesharp/rpiv-workflow/registration";
import {
	evidenceCitesFileLine,
	freshVerdicts,
	latestArtifactPath,
	latestVerdictPerDimension,
	planAuthoredRisks,
	procedureSatisfiesDuty,
	rulingEffectivePass,
	verdictRiskRulings,
} from "./gates.js";
import { haltPreflight, latestFsArtifact, readArtifactFile } from "./shared.js";

/**
 * Copy the latest graded plan off `plans` into `.rpiv/artifacts/priors/`
 * basename-keyed, publishing the bytes on the snapshot stage's OWN channel with
 * role `prior` — one deterministic hop BEFORE the matching fix stage inside the
 * existing fix loop (plan-grade/plan-confirm → plan-snapshot → plan-fix; code
 * twin). Overwritten each fix round, so the prior always reflects the
 * pre-CURRENT-fix content; the re-grade reads it via `latestPriorContent` to
 * decide whether the amend was surgical. `who` attributes the halt when no plan
 * is published. `kind: "artifact-md"` is the honest kind — the prior IS a copy
 * of an artifact-md plan body (the kind plans carry under `rpivBucketOutcome`).
 */
const snapshotLatestPlan =
	(who: string) =>
	({ state, cwd }: ScriptContext): Omit<Output, "meta"> => {
		const latest = latestFsArtifact(state, "plans");
		if (latest?.handle.kind !== "fs") {
			throw haltPreflight(
				who,
				`${who}: no plan to snapshot`,
				`${who}: no fs artifact on the 'plans' channel — the plan must be graded before the snapshot stage`,
			);
		}
		const src = isAbsolute(latest.handle.path) ? latest.handle.path : join(cwd, latest.handle.path);
		const priorRel = join(PRIOR_DIR, basename(latest.handle.path));
		mkdirSync(join(cwd, PRIOR_DIR), { recursive: true });
		copyFileSync(src, join(cwd, priorRel));
		return {
			kind: "artifact-md",
			artifacts: [{ handle: { kind: "fs", path: priorRel }, role: "prior" }],
			data: { snapshot_of: handleToString(latest.handle) },
		};
	};

/** Snapshot the graded plan before `plan-fix` amends it (plan gate). */
const planSnapshot = snapshotLatestPlan("plan-snapshot");
/** Snapshot the graded plan before `code-fix` amends it (code gate). */
const codeSnapshot = snapshotLatestPlan("code-snapshot");

/**
 * A duty demotion stamped onto a verdict's on-disk JSON — the legible record
 * that a risk ruling the panel marked `pass: true` was demoted to effective-
 * fail by the evidence or verify-at-implement duty. One entry per FAILING
 * duty (a ruling authored as BOTH mechanics AND verify-at-implement can carry
 * two). `reason` is decision-code-free prose (no run/phase ids, no absolute
 * line numbers) naming the duty that failed, so disk readers (amend, confirm
 * `--prior`) can tell a grader-side demotion from a genuine `pass: false`.
 */
interface RiskDutyDemotion {
	id: string;
	duty: "evidence-format" | "procedure-owner";
	reason: string;
}

/**
 * Materialize the duty demotion as legible on-disk data. After a grade round,
 * each latest-per-dimension verdict whose `pass: true` rulings were demoted by
 * the evidence or verify-at-implement duty gets a `risk_duty_demotions` array
 * written onto its on-disk JSON IN PLACE — the one medium amend and confirm's
 * `--prior` read. The verdict's own `pass` is NEVER flipped (every gate fold —
 * `allRiskFlagsPass`/`dimensionsToRegrade`/`confirmDue` — consults
 * `rulingEffectivePass` off in-memory `state.named`, which never re-reads the
 * rewritten file, so gate outcomes are unchanged); the field is an additive,
 * read-only signal for the disk readers.
 *
 * Modeled on `snapshotLatestPlan(who)` (a `ScriptFn` that side-effects AND
 * returns an `Output`): it reads the PLAN-sourced duty triggers
 * (`planAuthoredRisks`), iterates the EXACT verdict set amend keeps + confirm
 * reads (`latestVerdictPerDimension(freshVerdicts(...))`), and rewrites each
 * demoted verdict's fs handle in place. Writes ONLY when ≥1 demotion (a clean
 * grade is a no-op — no needless reformat/mtime churn); each per-file
 * read/parse/write is wrapped so a single unparseable/stale file is skipped
 * (never halts the gate). Returns `{ demotions }` echoing `{dimension, id,
 * duty, verdict}` for journal greppability. `channel` is the plan channel the
 * risks + current artifact live on; `verdictChannel` is the grade's own
 * verdict channel (plan-verdicts / code-verdicts).
 */
const demoteDuties =
	(who: string, channel: string, verdictChannel: string) =>
	({ state, cwd }: ScriptContext): Omit<Output, "meta"> => {
		const risks = planAuthoredRisks(state, channel);
		const current = latestArtifactPath(state, channel);
		const demotions: { dimension: string; id: string; duty: RiskDutyDemotion["duty"]; verdict: string }[] = [];
		for (const o of latestVerdictPerDimension(freshVerdicts(state.named[verdictChannel] ?? [], current)).values()) {
			const handle = o.artifacts.find((a) => a.handle.kind === "fs")?.handle;
			if (handle?.kind !== "fs") continue;
			const dimRaw = (o.data as { dimension?: unknown } | undefined)?.dimension;
			const dimension = typeof dimRaw === "string" ? dimRaw : "";
			const perFile: RiskDutyDemotion[] = [];
			for (const r of verdictRiskRulings(o)) {
				const authored = risks.get(r.id);
				// Only a `pass: true` ruling that rulingEffectivePass demotes — never a
				// genuine `pass: false` (that is already a fail, not a demoted pass).
				if (r.pass !== true || rulingEffectivePass(r, authored)) continue;
				if (!evidenceCitesFileLine(r, authored)) {
					perFile.push({
						id: r.id,
						duty: "evidence-format",
						reason: "mechanics pass without an adjacent file:line citation in evidence",
					});
					demotions.push({ dimension, id: r.id, duty: "evidence-format", verdict: handleToString(handle) });
				}
				if (!procedureSatisfiesDuty(r, authored)) {
					perFile.push({
						id: r.id,
						duty: "procedure-owner",
						reason: "verify-at-implement pass without a concrete procedure and owner phase",
					});
					demotions.push({ dimension, id: r.id, duty: "procedure-owner", verdict: handleToString(handle) });
				}
			}
			if (perFile.length === 0) continue;
			try {
				const abs = isAbsolute(handle.path) ? handle.path : join(cwd, handle.path);
				const json = JSON.parse(readFileSync(abs, "utf-8")) as Record<string, unknown>;
				json.risk_duty_demotions = perFile;
				writeFileSync(abs, JSON.stringify(json, null, 2));
			} catch {
				// skip-on-throw: an unparseable/stale verdict file never halts the gate.
			}
		}
		return { kind: "json", artifacts: [], data: { demotions, stage: who } };
	};

/**
 * Stamp duty demotions onto the graded plan's verdicts after `plan-grade`, one
 * deterministic hop before the gate routes (plan-grade → plan-demote → route).
 * The code lane re-grades `plans` on `code-verdicts` (mirroring `codeSnapshot`).
 */
const planDemote = demoteDuties("plan-demote", "plans", "plan-verdicts");
const codeDemote = demoteDuties("code-demote", "plans", "code-verdicts");

/**
 * Coarse line-count backstop for the surgical-fix guard. The subset test
 * (`touchedSections − HOUSEKEEPING ⊆ cited`) is the binding constraint — do
 * NOT tighten this to compensate for a weak subset test.
 */
const NON_SURGICAL_DIFF_LINE_THRESHOLD = 60;

/**
 * Plan sections amend ALWAYS bumps without the fix touching their meaning —
 * the pseudo-section `frontmatter` (via the `last_updated` field). Exempt from
 * the "touched outside cited" test. Starts at `{frontmatter}` only; do not
 * pre-widen (a genuinely-meaningful bookkeeping section would let a broad amend
 * pass the subset test by touching it).
 */
const HOUSEKEEPING_SECTIONS: ReadonlySet<string> = new Set(["frontmatter"]);

/** Directory the snapshot stages copy the pre-fix plan into (basename-keyed). */
const PRIOR_DIR = ".rpiv/artifacts/priors";

/**
 * Map each line index to its plan-section name: the nearest preceding `## `
 * heading — `## Phase N: …` normalizes to `phase N` (case-insensitive); any
 * other heading is lowercased by tail — so touched-section keys and cited-section
 * keys share one space. The frontmatter block (opening `---` through its closing
 * `---`) is the pseudo-section `frontmatter`. Lines before the first heading and
 * outside frontmatter map to `""` (which is neither housekeeping nor a `phase N`
 * cite, so any change there is treated as out-of-scope).
 */
const sectionIndexOf = (lines: readonly string[]): string[] => {
	const idx = new Array<string>(lines.length);
	let current = "";
	let inFrontmatter = lines[0]?.trim() === "---";
	for (let i = 0; i < lines.length; i++) {
		if (inFrontmatter) {
			idx[i] = "frontmatter";
			if (i > 0 && lines[i].trim() === "---") inFrontmatter = false;
			continue;
		}
		const m = /^##\s+(.*)$/.exec(lines[i]);
		if (m) {
			const ph = /^Phase\s+(\d+)/i.exec(m[1].trim());
			current = ph ? `phase ${ph[1]}` : m[1].trim().toLowerCase();
		}
		idx[i] = current;
	}
	return idx;
};

/**
 * Line-level diff of `prior` vs `current` plan bodies, mapped to plan sections.
 * Each changed line (a deletion from `prior` OR an insertion in `current` under
 * an LCS match) is attributed to its nearest preceding `## ` heading in its own
 * document. Returns the union of touched section keys and a coarse changed-line
 * count (deletions + insertions). Insertion-tolerant: a 1-line insert does not
 * mark every trailing line changed (the LCS keeps shared context matched).
 */
const sectionDiff = (prior: string, current: string): { touchedSections: Set<string>; changedLines: number } => {
	const a = prior.split("\n");
	const b = current.split("\n");
	const sa = sectionIndexOf(a);
	const sb = sectionIndexOf(b);
	// LCS length table (bottom-up). Plans are a few hundred lines ⇒ O(n·m) trivial.
	const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const touched = new Set<string>();
	let changed = 0;
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			touched.add(sa[i]); // a[i] deleted (present in prior, absent in current)
			changed++;
			i++;
		} else {
			touched.add(sb[j]); // b[j] inserted (present in current, absent in prior)
			changed++;
			j++;
		}
	}
	while (i < a.length) {
		touched.add(sa[i]);
		changed++;
		i++;
	}
	while (j < b.length) {
		touched.add(sb[j]);
		changed++;
		j++;
	}
	return { touchedSections: touched, changedLines: changed };
};

/**
 * Plan sections cited by the FAILING dimensions' findings — extracted from each
 * finding's `where` and `detail` (`Phase N` → `phase N`, lowercased). Preferred
 * `where: "Phase 1 > lane-dock-editor.ts Edit 1"` → `phase 1`; a repo
 * `path:line`-only `where` (and a detail with no `Phase N`) contributes NO plan
 * section. Empty when no failing finding carries an extractable plan-section
 * reference — fail-closed: the caller treats an empty cite set against any
 * non-housekeeping touched section as out-of-scope (non-surgical).
 */
const citedSections = (latest: ReadonlyMap<string, Output>, pending: readonly string[]): Set<string> => {
	const cited = new Set<string>();
	for (const d of pending) {
		const findings = (latest.get(d)?.data as { findings?: unknown } | undefined)?.findings;
		if (!Array.isArray(findings)) continue;
		for (const f of findings) {
			if (f == null || typeof f !== "object") continue;
			const where = typeof (f as { where?: unknown }).where === "string" ? (f as { where: string }).where : "";
			const detail = typeof (f as { detail?: unknown }).detail === "string" ? (f as { detail: string }).detail : "";
			for (const text of [where, detail]) {
				for (const m of text.matchAll(/Phase\s+(\d+)/gi)) cited.add(`phase ${m[1]}`);
			}
		}
	}
	return cited;
};

/**
 * The prior-role `fs` artifact the snapshot stage published on `priorChannel`
 * (undefined when the channel carries no prior — round 1 / first re-grade).
 * Existence of the ENTRY is distinct from readability of the sidecar: an entry
 * that exists but cannot be read still counts as "prior present" so the caller
 * fails closed to a FULL roster rather than silently carrying forward.
 */
const priorArtifact = (state: RunView, priorChannel: string): Artifact | undefined => {
	const entry = state.named[priorChannel]?.at(-1);
	const prior = entry?.artifacts.find((a) => a.handle.kind === "fs" && a.role === "prior");
	return prior?.handle.kind === "fs" ? prior : undefined;
};

/**
 * Read the prior sidecar's bytes off `priorChannel`. Returns `undefined` when
 * the channel is empty, the prior artifact is not fs, OR the sidecar is
 * unreadable — the caller treats `undefined` as fail-closed (non-surgical).
 */
const latestPriorContent = (state: RunView, priorChannel: string, cwd: string): string | undefined => {
	const prior = priorArtifact(state, priorChannel);
	if (prior?.handle.kind !== "fs") return undefined;
	try {
		return readArtifactFile(prior.handle.path, cwd);
	} catch {
		return undefined;
	}
};

/**
 * True ONLY when a readable prior exists AND the current plan's diff from it
 * touches ONLY sections a failing finding cited (minus housekeeping) AND the
 * changed-line count is within the coarse threshold. Every missing signal — no
 * prior, unreadable sidecar, unreadable current plan, a diff/parse throw, a
 * touched section no failing finding cited, or an over-threshold diff —
 * collapses to `false` (fail-closed ⇒ the caller re-grades the full roster
 * when a prior is present, or carries forward when none is). `pending` is
 * consumed as-is: whatever `dimensionsToRegrade` ruled still-blocking (after
 * phase 3's `rulingEffectivePass` clause-3 rewrite) is the set this guard
 * narrows on.
 */
const isSurgicalFix = (
	state: RunView,
	priorChannel: string,
	cwd: string,
	target: string,
	latest: ReadonlyMap<string, Output>,
	pending: readonly string[],
): boolean => {
	const prior = latestPriorContent(state, priorChannel, cwd);
	if (prior === undefined) return false;
	let current: string;
	try {
		current = readArtifactFile(target, cwd);
	} catch {
		return false;
	}
	let diff: { touchedSections: Set<string>; changedLines: number };
	try {
		diff = sectionDiff(prior, current);
	} catch {
		return false;
	}
	const cited = citedSections(latest, pending);
	for (const section of diff.touchedSections) {
		if (HOUSEKEEPING_SECTIONS.has(section)) continue;
		if (!cited.has(section)) return false;
	}
	return diff.changedLines <= NON_SURGICAL_DIFF_LINE_THRESHOLD;
};

export { codeDemote, codeSnapshot, isSurgicalFix, planDemote, planSnapshot, priorArtifact };
