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
	type RiskRecord,
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
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		if (inFrontmatter) {
			idx[i] = "frontmatter";
			if (i > 0 && lines[i].trim() === "---") inFrontmatter = false;
			continue;
		}
		// Fence-aware: a `## ` line INSIDE a fenced code block is content, not a
		// heading — build plans routinely embed markdown edits (a CHANGELOG
		// snippet's `## [Unreleased]`), and keying those as sections
		// manufactured phantom touched keys no finding could ever cite
		// (observed live: run b307's code-fix went broad on the phantom
		// `[unreleased]` from an embedded changelog block). Fenced lines
		// attribute to the enclosing section.
		if (/^\s*```/.test(lines[i])) {
			inFence = !inFence;
			idx[i] = current;
			continue;
		}
		if (!inFence) {
			const m = /^##\s+(.*)$/.exec(lines[i]);
			if (m) {
				const ph = /^Phase\s+(\d+)/i.exec(m[1].trim());
				current = ph ? `phase ${ph[1]}` : m[1].trim().toLowerCase();
			}
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
 * Plan sections cited by the FAILING dimensions' verdicts, from THREE sources:
 *
 *   1. `Phase N` mentions anywhere in a finding's `where` or `detail`
 *      (`phase N`, the original extraction).
 *   2. The `where`'s LEADING SEGMENT as a section heading: the grade skill's
 *      `where` convention is "`path:line` or a section heading", and panel
 *      wheres read "## Phase 1 > Success Criteria > …" — the text before the
 *      first `>` names the plan section, normalized exactly as
 *      `sectionIndexOf` keys it (leading `#`s stripped, `Phase N …` →
 *      `phase N`, else lowercased). A repo path (a `/` or a `.ext:NN` tail)
 *      is a code cite, never a plan section. Before this, `citedSections`
 *      could ONLY emit `phase N` keys while `touchedSections` emits every
 *      heading key — so a finding citing "Out of Scope" or "Risk Flags"
 *      contributed nothing and any amend touching those sections was
 *      structurally guaranteed non-surgical (the observed always-broad).
 *   3. Failing risk RULINGS (the reason correctness re-grades when findings
 *      are empty): a ruling's repair edits the plan's `## Risk Flags` entry
 *      and, for a `verify-at-implement` deferral, the owner phase — cite
 *      both, so a risk-driven fix loop is not broad by construction.
 *
 * Still fail-closed: an empty cite set against any non-housekeeping touched
 * section stays out-of-scope (non-surgical).
 */
const citedSections = (
	latest: ReadonlyMap<string, Output>,
	pending: readonly string[],
	risks: ReadonlyMap<string, RiskRecord>,
): Set<string> => {
	const cited = new Set<string>();
	const addHeading = (raw: string): void => {
		const cleaned = raw.replace(/^#+\s*/, "").trim();
		if (cleaned.length === 0) return;
		const ph = /^Phase\s+(\d+)/i.exec(cleaned);
		if (ph) {
			cited.add(`phase ${ph[1]}`);
			return;
		}
		// A code cite, not a section: a tight path segment (`a/b`) or an
		// `ext:NN` tail. A SPACED slash is prose punctuation ("Synthesis Notes
		// / 'Adopted rider' bullet" — run d5a9), not a path.
		if (/\S\/\S/.test(cleaned) || /\.\w+:\d+/.test(cleaned)) return;
		cited.add(headingCore(cleaned).toLowerCase());
	};
	for (const d of pending) {
		const o = latest.get(d);
		const findings = (o?.data as { findings?: unknown } | undefined)?.findings;
		if (Array.isArray(findings)) {
			for (const f of findings) {
				if (f == null || typeof f !== "object") continue;
				const where = typeof (f as { where?: unknown }).where === "string" ? (f as { where: string }).where : "";
				const detail =
					typeof (f as { detail?: unknown }).detail === "string" ? (f as { detail: string }).detail : "";
				for (const text of [where, detail]) {
					for (const m of text.matchAll(/Phase\s+(\d+)/gi)) cited.add(`phase ${m[1]}`);
					// A `## Heading` mention ANYWHERE in the finding cites that
					// section — the observed shape (opendots run d5a9) is a
					// completeness finding whose remedy is CREATING a section,
					// named only in a parenthetical ("... (missing ## Whole-Plan
					// Verification section)"): the amend's creation of that very
					// section must count as cited.
					for (const m of text.matchAll(/##\s+([A-Za-z][^#>\n]*)/g)) addHeading(m[1]);
				}
				addHeading(where.split(">")[0] ?? "");
			}
		}
		if (!o) continue;
		for (const r of verdictRiskRulings(o)) {
			if (rulingEffectivePass(r, risks.get(r.id))) continue;
			cited.add("risk flags");
			const owner = risks.get(r.id)?.owner;
			if (typeof owner === "number") cited.add(`phase ${owner}`);
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
 * The heading CORE of a section reference — the text before the first
 * descriptor separator (an em/en-dash clause, a spaced slash, a
 * parenthetical). Real headings and finding wheres both carry descriptor
 * suffixes ("Whole-Plan Verification (owned by validate — not any phase)",
 * "Synthesis Notes — 'Adopted rider' bullet"); the core is the comparable
 * identity.
 */
const headingCore = (s: string): string => s.split(/ \(|\s+—\s+|\s+–\s+|\s+\/\s+/)[0]?.trim() ?? s;

/**
 * True when a touched section is covered by the cite set. `phase N` keys
 * match EXACTLY (prefix matching would let "phase 1" cover "phase 10").
 * Non-phase keys match on a word-boundary PREFIX in EITHER direction —
 * observed both ways in run d5a9: a cited where carries a descriptor suffix
 * ("synthesis notes — 'adopted rider' bullet") that must cover the bare
 * touched heading key ("synthesis notes"), and a real heading carries its own
 * suffix ("whole-plan verification (owned by validate — not any phase)") that
 * a bare cite ("whole-plan verification") must cover. The boundary check
 * (the next character must not be alphanumeric) keeps "notes" from covering
 * "notes-extra".
 */
const sectionCovered = (section: string, cited: ReadonlySet<string>): boolean => {
	if (cited.has(section)) return true;
	if (/^phase \d+$/.test(section)) return false; // phase keys are exact-only
	const core = headingCore(section);
	const boundary = (long: string, short: string): boolean =>
		short.length > 0 &&
		long.startsWith(short) &&
		(long.length === short.length || !/[a-z0-9]/i.test(long[short.length] ?? ""));
	for (const c of cited) {
		if (/^phase \d+$/.test(c)) continue;
		if (boundary(c, section) || boundary(section, c) || boundary(c, core) || boundary(core, c)) return true;
	}
	return false;
};

/** The surgical-fix guard's decision, with the condition that decided it. */
interface SurgicalDecision {
	surgical: boolean;
	/** Prose naming the deciding condition — the instrumentation channel. */
	reason: string;
	changedLines?: number;
	touchedSections?: string[];
	citedSections?: string[];
}

/**
 * Persist the guard's decision beside the prior sidecar as
 * `<plan-basename>.decision.json` — the instrumentation the always-broad
 * diagnosis lacked: real runs showed every observed fix loop re-grading the
 * full roster, and the surviving artifacts could not say WHICH fail-closed
 * condition tripped (the plan file is later mutated by splice/reconcile, so
 * the decision is unreplayable post-hoc). Best-effort and idempotent: the
 * guard is called from a fanout `units()` fn, which the resume fold re-runs
 * under THE REPLAY CONTRACT — same replayed inputs ⇒ same bytes ⇒ the rewrite
 * is a no-op; a write failure never affects the decision.
 */
const recordDecision = (cwd: string, target: string, decision: SurgicalDecision): void => {
	try {
		mkdirSync(join(cwd, PRIOR_DIR), { recursive: true });
		writeFileSync(join(cwd, PRIOR_DIR, `${basename(target)}.decision.json`), JSON.stringify(decision, null, 2));
	} catch {
		// instrumentation only — never let a write failure change the routing
	}
};

/**
 * The guard body — every missing signal collapses to non-surgical with a
 * `reason` naming the condition (see `isSurgicalFix` for the contract).
 */
const decideSurgicalFix = (
	state: RunView,
	priorChannel: string,
	cwd: string,
	target: string,
	latest: ReadonlyMap<string, Output>,
	pending: readonly string[],
	risks: ReadonlyMap<string, RiskRecord>,
): SurgicalDecision => {
	const prior = latestPriorContent(state, priorChannel, cwd);
	if (prior === undefined) return { surgical: false, reason: "no readable prior sidecar" };
	let current: string;
	try {
		current = readArtifactFile(target, cwd);
	} catch {
		return { surgical: false, reason: "current plan unreadable" };
	}
	let diff: { touchedSections: Set<string>; changedLines: number };
	try {
		diff = sectionDiff(prior, current);
	} catch {
		return { surgical: false, reason: "section diff threw" };
	}
	const cited = citedSections(latest, pending, risks);
	const base = {
		changedLines: diff.changedLines,
		touchedSections: [...diff.touchedSections].sort(),
		citedSections: [...cited].sort(),
	};
	for (const section of diff.touchedSections) {
		if (HOUSEKEEPING_SECTIONS.has(section)) continue;
		if (!sectionCovered(section, cited)) {
			return { surgical: false, reason: `touched section no failing verdict cited: ${section}`, ...base };
		}
	}
	if (diff.changedLines > NON_SURGICAL_DIFF_LINE_THRESHOLD) {
		return {
			surgical: false,
			reason: `changed lines ${diff.changedLines} over threshold ${NON_SURGICAL_DIFF_LINE_THRESHOLD}`,
			...base,
		};
	}
	return { surgical: true, reason: "touched sections all cited, within threshold", ...base };
};

/**
 * True ONLY when a readable prior exists AND the current plan's diff from it
 * touches ONLY sections a failing verdict cited (minus housekeeping) AND the
 * changed-line count is within the coarse threshold. Every missing signal — no
 * prior, unreadable sidecar, unreadable current plan, a diff/parse throw, a
 * touched section no failing verdict cited, or an over-threshold diff —
 * collapses to `false` (fail-closed ⇒ the caller re-grades the full roster
 * when a prior is present, or carries forward when none is). `pending` is
 * consumed as-is: whatever `dimensionsToRegrade` ruled still-blocking (after
 * phase 3's `rulingEffectivePass` clause-3 rewrite) is the set this guard
 * narrows on. `risks` is the plan-authored flag map — ruling-derived cites
 * (see `citedSections`) need the owner phases. Every call persists its
 * decision + tripped condition beside the prior (`recordDecision`), so a
 * future always-broad report names the condition instead of guessing.
 */
const isSurgicalFix = (
	state: RunView,
	priorChannel: string,
	cwd: string,
	target: string,
	latest: ReadonlyMap<string, Output>,
	pending: readonly string[],
	risks: ReadonlyMap<string, RiskRecord>,
): boolean => {
	const decision = decideSurgicalFix(state, priorChannel, cwd, target, latest, pending, risks);
	recordDecision(cwd, target, decision);
	return decision.surgical;
};

export { codeDemote, codeSnapshot, isSurgicalFix, planDemote, planSnapshot, priorArtifact };
