/**
 * The two deterministic slice-map floors: the slice structure check
 * (acyclicity, coverage conservation, citation backing) and the subplan
 * cluster-coverage check between the cluster fanout and the root merge.
 */
import { writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { handleToString, type Output, type RunView, type ScriptContext } from "@juicesharp/rpiv-workflow/registration";
import { parseFrontmatter } from "../frontmatter.js";
import { verifyCitations } from "./citations.js";
import { latestVerdictPerDimension, type SeedOnlyVerdict, seedOnlyFindings } from "./gates.js";
import { fencedSpans, forEachLineOutsideFences } from "./markdown-fence.js";
import {
	haltPreflight,
	latestFsArtifact,
	type PhaseRecord,
	readArtifactFile,
	type StructureFinding,
	writeStructureVerdict,
} from "./shared.js";
import {
	clusterSliceDag,
	DESIGN_SLICE_RE,
	designPathsBySlice,
	sliceCoverageUnits,
	sliceCovers,
	sliceDepCycle,
	sliceRecords,
} from "./slices.js";

/** A dispatched sub-plan basename with its `_cluster-<k>` ordinal resolved. */
type DispatchedCluster = { path: string; k: number };

/**
 * A citation string occurs LIVE in the slice-map text — outside fenced spans
 * and not as half of an `old→new` refresh-note pair. A re-slice's revision
 * note legitimately QUOTES the citations it refreshed (contract: only as
 * arrow pairs or inside a fence — see the slice skill's re-slice mode);
 * treating a quoted old citation as still-live would forfeit every documented
 * refresh's discharge, and treating a quoted new one as present would credit
 * a fix that never touched the live `Draws on` lines.
 */
const citeOccursLive = (body: string, spans: readonly [number, number][], cite: string): boolean => {
	for (let i = body.indexOf(cite); i !== -1; i = body.indexOf(cite, i + 1)) {
		if (spans.some(([s, e]) => i >= s && i < e)) continue;
		if (body.startsWith("→", i + cite.length)) continue;
		if (body.endsWith("→", i)) continue;
		return true;
	}
	return false;
};

/**
 * One cite-remedy finding is satisfied by the slice-map text: the demanded
 * seed's path occurs live — line suffixes are stripped before matching,
 * because the fix may cite a corrected range and the citation floor
 * (`verifyCitations`) verifies whatever range it actually wrote. `Draws on`
 * and `Out of scope` both satisfy the remedy, so a live occurrence anywhere
 * in the map is the contract. (The former REFRESH mode — a `stale` drifted
 * line number to replace — was removed with anchor-precision grading: a
 * drifted line number is no longer a finding, so nothing demands a refresh.)
 *
 * A finding without a concrete string `requires` is unverifiable ⇒ not satisfied.
 */
const citeFindingSatisfied = (
	mapBody: string,
	spans: readonly [number, number][],
	f: { requires?: unknown },
): boolean =>
	typeof f.requires === "string" &&
	f.requires.length > 0 &&
	citeOccursLive(mapBody, spans, f.requires.replace(/:\d[-\d,:]*$/, ""));

/**
 * Structural fingerprint of one slice-map round: the `slices` + `coverage`
 * frontmatter it published on the `slices` channel — no file re-read.
 * `undefined` when the round carried no `slices` data; a caller must treat
 * that as "cannot compare", never as "unchanged".
 */
const sliceShape = (round: Output | undefined): string | undefined => {
	const d = round?.data as { slices?: unknown; coverage?: unknown } | undefined;
	return d?.slices === undefined ? undefined : JSON.stringify({ slices: d.slices, coverage: d.coverage ?? null });
};

/** The verdict fields the cite-only discharge consults live in gate-passes.ts
 * (re-exported by the gates.ts facade) as `SeedOnlyVerdict` — the one spelling
 * the classification, the discharge, and the seed lift share. */

/**
 * Deterministic discharge of a CITE-ONLY `design-readiness` fail — the middle
 * case between "carry a passing verdict" (impossible on the slice gate: its
 * lone dimension failed) and "buy a full re-grade panel" (wasteful when the
 * grader already named the exact citations to add or refresh). A fix that
 * also restructured forfeits the discharge and takes the normal re-grade.
 * The seed-only classification (`seedOnlyFindings`) accepts a `remedy` that
 * is `"cite"` or absent — the judge-omits-the-marker leak is closed
 * engine-side by the findings' own shape — and subsumes the zero-findings
 * guard (a seed-only verdict carries ≥ 1 finding by definition).
 */
const citeRemedyDischarged = (state: RunView, mapBody: string): boolean => {
	const verdict = latestVerdictPerDimension(state.named["slice-verdicts"]).get("design-readiness");
	const v = verdict?.data as SeedOnlyVerdict | undefined;
	if (!seedOnlyFindings(v)) return false;
	// A fix must have LANDED since the verdict — discharging the judged map
	// unchanged would contradict the grader, who read it and found the cites
	// wrong. Basename inequality cannot witness the fix (a re-slice may
	// legitimately edit the map in place); publication order can: the latest
	// `slices` round OR seed-lift entry must postdate the verdict (the lift
	// amends the map in place and publishes on its own channel, so it can be
	// the sole witness with no `slices` round after the verdict).
	const entries = state.named.slices ?? [];
	const liftEntries = state.named["slice-seed-lift"] ?? [];
	const verdictTs = verdict?.meta?.ts;
	const witnessTails = [entries.at(-1)?.meta?.ts, liftEntries.at(-1)?.meta?.ts].filter(
		(ts): ts is string => typeof ts === "string",
	);
	const witnessTs = witnessTails.length > 0 ? witnessTails.reduce((a, b) => (a > b ? a : b)) : undefined;
	if (typeof verdictTs !== "string" || witnessTs === undefined || witnessTs <= verdictTs) return false;
	const rawFindings = v?.findings;
	const findings = Array.isArray(rawFindings) ? rawFindings : [];
	const spans = fencedSpans(mapBody);
	if (!findings.every((f) => f != null && citeFindingSatisfied(mapBody, spans, f))) return false;
	// Shape must match the round the grader judged — located by publication
	// order, not filename, for the same in-place reason. A lift-only witness
	// leaves the judged round as the latest `slices` entry, so the comparison
	// is the round to itself: shape-conserved by construction.
	const judged = [...entries].reverse().find((s) => typeof s.meta?.ts === "string" && s.meta.ts <= verdictTs);
	const judgedShape = sliceShape(judged);
	return judgedShape !== undefined && judgedShape === sliceShape(entries.at(-1));
};

/**
 * Deterministic Phase-1 slice-check — the un-gameable floor beneath the LLM
 * `design-readiness` panel. It enforces the invariants a prose grader cannot
 * reliably hold because it grades the slicer's own self-description:
 *   • acyclicity — the `deps` DAG must be cycle-free.
 *   • coverage conservation — every coverage unit FROZEN at the first cut
 *     (`state.named.slices[0]`) must still be claimed by ≥1 slice's `covers`,
 *     so a reslice can only redistribute the brief, never simplify by dropping
 *     scope. Anchored to the FIRST cut (not the latest map) so a reslice cannot
 *     disable the check by deleting the `coverage:` array — the frozen set is
 *     read from round 0.
 *   • citation backing — every `file:line` the slice map cites (its `Draws on:`
 *     footing, refracted up from research) must resolve against the tree. An
 *     unbacked citation is fabricated precision that would otherwise starve or
 *     mislead the design pass; the deterministic floor stops it here.
 * Emits one combined `{ dimension: "structure" }` verdict onto the
 * `slice-check` channel AND writes it to an fs artifact so the reslice arm's
 * `reads: [fanin("slice-check")]` projection carries the FINDINGS (not just the
 * pass/fail) into `slice-fix` — the way `amend` receives `--code-verdicts`. The
 * gate route folds the channel `data` with the LLM verdicts.
 * Deterministic ⇒ idempotent across reslice rounds (no flicker, resume-safe): the
 * verdict basename is keyed on the slice-map basename, so a re-run OVERWRITES its
 * own slot rather than duplicating it.
 */
const sliceStructureCheck = ({ state, cwd }: ScriptContext): Omit<Output, "meta"> => {
	const latest = latestFsArtifact(state, "slices");
	if (latest?.handle.kind !== "fs") {
		throw haltPreflight(
			"slice-check",
			"slice-check: no slice map to check",
			"slice-check: no fs artifact on the 'slices' channel — slice must run before the structure check",
		);
	}
	const mapBody = readArtifactFile(latest.handle.path, cwd);
	const records = sliceRecords(mapBody, "slice-check", latest.handle.path);
	const findings: StructureFinding[] = [];

	const cycle = sliceDepCycle(records);
	if (cycle.length > 0) {
		const loop = [...cycle, cycle[0]].join("→");
		findings.push({
			detail: `Dependency cycle ${loop} — slices in a cycle cannot be designed independently. Break it: merge the cycle into one slice, or invert one edge so a shared contract has a single owning slice.`,
			where: `deps: ${cycle.map((n) => `Slice ${n}`).join(", ")}`,
		});
	}

	// Coverage conservation, anchored to the FROZEN units of the first cut.
	const firstFs = state.named.slices?.[0]?.artifacts.find((a) => a.handle.kind === "fs");
	const frozen = firstFs?.handle.kind === "fs" ? sliceCoverageUnits(readArtifactFile(firstFs.handle.path, cwd)) : [];
	if (frozen.length > 0) {
		const covered = new Set(records.flatMap((r) => sliceCovers(r.entry)));
		const dropped = frozen.filter((u) => !covered.has(u.id));
		if (dropped.length > 0) {
			findings.push({
				detail: `Coverage regression — ${dropped.length} brief unit(s) frozen at the first cut are no longer claimed by any slice's 'covers': ${dropped.map((u) => `${u.id} (${u.brief})`).join("; ")}. A reslice must redistribute every unit across slices, never drop one. Re-add the dropped unit(s) to an owning slice's 'covers'.`,
				where: `coverage: ${dropped.map((u) => u.id).join(", ")}`,
			});
		}
	}

	// Citation backing — every file:line the map cites must resolve.
	findings.push(...verifyCitations(mapBody, cwd));

	// Stamp the cite-only discharge ONLY when the floor's findings are all
	// advisory (an empty set included): structure clean, every citation
	// verified or advisory-only, demanded seeds present, and shape unchanged is
	// exactly what a fresh design-readiness pass on this map would
	// re-establish, so the `sliceGatePasses` skip stays provably equivalent to
	// "re-grade, then pass". The floor mirrors the routing severity floor — a
	// `low` advisory-only verdict passes `allDimensionsPass` — so an advisory
	// resolver limitation can no longer zero the stamp and buy the re-grade
	// panel the stamp exists to skip. A BLOCKING finding (cycle, dropped
	// coverage) still withholds — fail-closed.
	const discharge =
		findings.every((f) => f.advisory === true) && citeRemedyDischarged(state, mapBody)
			? { citeDischarged: basename(latest.handle.path) }
			: undefined;
	return writeStructureVerdict("slice-check", latest.handle, findings, cwd, discharge);
};

/** A `## Slice N:` section heading — the target a cite-remedy finding's
 *  `where` names, and the section delimiter the seed lift walks. */
const SLICE_HEADING_RE = /^##\s+Slice\s+(\d+)/;

/** The `Draws on:` line the seed lift appends a demanded seed to. */
const DRAWS_ON_LINE_RE = /^\s*\*\*Draws on:\*\*/;

/**
 * One cite-remedy seed the lift acted on: the demanded `requires` citation,
 * the slice section it targeted, and — for a refused seed — why (the lift
 * refuses rather than guess where a seed belongs; a refused seed leaves the
 * discharge unsatisfied and the loop takes the structural fix arm).
 */
type SeedLiftRecord = {
	requires: string;
	slice?: number;
	reason?: "no-slice-heading" | "no-draws-on-line";
};

/**
 * Deterministic seed lift — the engine-owned half of the cite remedy. A
 * seed-only `design-readiness` fail (every finding demanding a concrete
 * `requires` citation) names EXACTLY the seeds to append; re-cutting the
 * whole map through the structural fix arm for them is a full LLM re-slice
 * plus re-grade that repairs nothing the verdict actually flagged. This
 * stage appends each demanded seed to its finding's named slice section's
 * `Draws on:` line, in place, and publishes the amended map as its row
 * artifact on its OWN stage channel (a script stage structurally cannot
 * carry an outcome, and none is needed: `latestFsArtifact(state, "slices")`
 * still resolves the same path, now carrying the amended bytes — the
 * plan-snapshot precedent for an in-place side-effecting script stage).
 * The re-run `slice-check` stamps `citeDischarged` when every seed landed on
 * a structurally unchanged map, so the gate folds green without a re-grade.
 *
 * Refusal semantics: a seed whose `where` names no `## Slice N:` heading, or
 * whose slice section carries no `Draws on:` line, is recorded `skipped`
 * with its reason and the map is left unchanged for it — never guessed onto
 * another slice. A seed already satisfied on the evolving body is not
 * re-appended (the discharge's own satisfaction test — dedup by
 * construction, so the post-lift every-seed-satisfied conjunct holds).
 *
 * Misroute guard: no map, or a latest verdict that is not seed-only, halts
 * loud via `haltPreflight` — this stage is reachable only from the seed-only
 * branch of the `slice-grade` route, so anything else is a wiring bug.
 */
const sliceSeedLift = ({ state, cwd }: ScriptContext): Omit<Output, "meta"> => {
	const latest = latestFsArtifact(state, "slices");
	if (latest?.handle.kind !== "fs") {
		throw haltPreflight(
			"slice-seed-lift",
			"slice-seed-lift: no slice map to lift seeds onto",
			"slice-seed-lift: no fs artifact on the 'slices' channel — slice must run before the seed lift",
		);
	}
	const verdict = latestVerdictPerDimension(state.named["slice-verdicts"]).get("design-readiness");
	const v = verdict?.data as SeedOnlyVerdict | undefined;
	if (!seedOnlyFindings(v)) {
		throw haltPreflight(
			"slice-seed-lift",
			"slice-seed-lift: latest design-readiness verdict is not seed-only",
			"slice-seed-lift: the slice-grade route dispatched the seed lift, but the latest design-readiness verdict is not a seed-only cite fail (pass false, remedy cite-or-absent, every finding carrying a concrete requires). This is a routing/wiring defect — investigate it; do not hand-edit the slice map to work around it",
		);
	}
	const mapPath = latest.handle.path;
	let body = readArtifactFile(mapPath, cwd);
	const lines = body.split("\n");
	const rawFindings = v?.findings;
	const findings = (Array.isArray(rawFindings) ? rawFindings : []).filter(
		(f): f is { requires?: unknown; where?: unknown } => f != null,
	);
	const lifted: SeedLiftRecord[] = [];
	const skipped: SeedLiftRecord[] = [];
	for (const f of findings) {
		const requires = typeof f.requires === "string" ? f.requires : "";
		if (requires.length === 0) continue; // unreachable past the guard; kept fail-soft
		// Dedup on the EVOLVING body: a seed already satisfied (the discharge's
		// own test) is never re-appended.
		if (citeFindingSatisfied(body, fencedSpans(body), f)) continue;
		const where = typeof f.where === "string" ? f.where : "";
		const heading = SLICE_HEADING_RE.exec(where);
		if (!heading) {
			skipped.push({ requires, reason: "no-slice-heading" });
			continue;
		}
		const slice = Number(heading[1]);
		// Locate the `Draws on:` line inside the `## Slice N:` section — the
		// section spans to the next `## Slice` heading or end of body, and the
		// walk is fence-aware (a fenced example line is never a real target).
		let drawsOn: number | undefined;
		let inTarget = false;
		forEachLineOutsideFences(body, (line, index) => {
			if (drawsOn !== undefined) return;
			const h = SLICE_HEADING_RE.exec(line);
			if (h) {
				inTarget = Number(h[1]) === slice;
				return;
			}
			if (inTarget && DRAWS_ON_LINE_RE.test(line)) drawsOn = index;
		});
		if (drawsOn === undefined) {
			skipped.push({ requires, slice, reason: "no-draws-on-line" });
			continue;
		}
		lines[drawsOn] = `${lines[drawsOn]}, ${requires}`;
		body = lines.join("\n");
		lifted.push({ requires, slice });
	}
	writeFileSync(isAbsolute(mapPath) ? mapPath : join(cwd, mapPath), body, "utf-8");
	return {
		kind: "json",
		artifacts: [{ handle: { kind: "fs", path: mapPath } }],
		data: { lifted, skipped },
	};
};

/**
 * `_<k>` cluster ordinal a partial sub-plan carries in its basename
 * (`<slug>_cluster-<k>.md`), emitted by `synthesize`'s partial mode from the
 * `--cluster <k>` the fanout threads on every cluster unit. The token a
 * `subplan-check` reconciliation keys dispatched sub-plans on. Anchored to the
 * basename TAIL (extension optional — extensionless agent writes happen, see
 * the implement-scope floor precedent) so a name carrying several `_cluster-`
 * tokens binds the trailing one deterministically, not the first match.
 */
const CLUSTER_TOKEN_RE = /_cluster-(\d+)(?:\.\w+)?$/;

/** The pre-filter cluster count the fanout received — the count
 * `subplanCoverageCheck` reconciles dispatched ordinals against. Delegates to
 * `clusterSliceDag`. */
const expectedClusterCount = (records: readonly PhaseRecord[]): number => clusterSliceDag(records).length;

/** Slice numbers that have NO design artifact on the `designs` channel — the gap
 * the missing-design preflight halts on (a slice with no design is unrepairable
 * by re-dispatch). */
const designCoverageGap = (sliceNumbers: Set<number>, designBySlice: Map<number, string>): number[] =>
	[...sliceNumbers].filter((n) => !designBySlice.has(n)).sort((a, b) => a - b);

/** Collect every dispatched sub-plan's `_cluster-<k>` ordinal from the `subplans`
 * channel. The `subplans` slot is a produces-fanout channel: `placeFanoutOutput`
 * pre-sizes it to the round's unit total and overwrites each unit's own index, so
 * with a stable unit set iterating it reflects the latest output per unit — a
 * re-dispatch's fresh artifacts re-evaluate cleanly. (A unit that FAILS on
 * re-dispatch leaves its prior-round output at its index; that stale entry
 * re-reads as current here.) Returns the resolved ordinals AND a `tokenless`
 * finding per basename that carries no `_cluster-<k>` token (the root merge
 * cannot attribute a tokenless sub-plan to a slice-DAG cluster). */
const dispatchedClusterOrdinals = (
	state: RunView,
): { dispatched: DispatchedCluster[]; tokenless: StructureFinding[] } => {
	const dispatched: DispatchedCluster[] = [];
	const tokenless: StructureFinding[] = [];
	for (const out of state.named.subplans ?? []) {
		for (const a of out.artifacts) {
			if (a.handle.kind !== "fs") continue;
			const name = basename(a.handle.path);
			const m = CLUSTER_TOKEN_RE.exec(name);
			if (!m) {
				tokenless.push({
					detail: `Tokenless sub-plan basename ${name} — it carries no '_cluster-<k>' ordinal, so the root merge cannot attribute it to a slice-DAG cluster. The cluster fanout threads '--cluster <k>' on every unit; a tokenless name means 'synthesize' dropped the flag. Re-dispatch the cluster with its '--cluster <k>' honored in the output filename.`,
					where: name,
				});
				continue;
			}
			dispatched.push({ path: handleToString(a.handle), k: Number(m[1]) });
		}
	}
	return { dispatched, tokenless };
};

/** A finding per `_cluster-<k>` ordinal claimed by MORE THAN ONE dispatched
 * sub-plan — a clobber (not a legitimate re-emit: within one round every unit
 * index is a distinct artifact because the channel is replaced each round, so a
 * shared `<k>` is the lost-cluster collision itself). */
const clobberedOrdinals = (dispatched: readonly DispatchedCluster[]): StructureFinding[] => {
	const pathsByK = new Map<number, string[]>();
	for (const d of dispatched) {
		const arr = pathsByK.get(d.k);
		if (arr) arr.push(d.path);
		else pathsByK.set(d.k, [d.path]);
	}
	const findings: StructureFinding[] = [];
	for (const [k, paths] of pathsByK) {
		if (paths.length > 1) {
			findings.push({
				detail: `Duplicate/clobbered cluster-${k} — ${paths.length} dispatched sub-plans claim the same '_cluster-${k}' ordinal (${paths.map((p) => basename(p)).join(", ")}). Two clusters collided on one filename token, so the root merge would fold one cluster's content over the other and lose a slice-DAG component. Re-dispatch with each cluster's '--cluster <k>' distinct.`,
				where: `cluster-${k}`,
			});
		}
	}
	return findings;
};

/** sources-coverage — every slice's design must appear in SOME sub-plan's
 * `sources:`. Reads the covered-slice set off each sub-plan's parsed `sources:`
 * (designs follow the `_slice-<N>` convention) and reconciles it against the full
 * slice map. A sub-plan whose frontmatter does not PARSE gets its own
 * re-dispatchable finding naming the FILE (never a terminal halt — the same
 * stray-colon class `artifact-collector` degrades on); when ANY sub-plan is
 * unparseable, the per-slice reconciliation DEFERS (an unreadable sub-plan's
 * coverage is unknowable; blaming its slices would misdirect the repair). */
const sourcesCoverageGaps = (state: RunView, cwd: string, sliceNumbers: Set<number>): StructureFinding[] => {
	const findings: StructureFinding[] = [];
	const coveredSlices = new Set<number>();
	let unparseable = false;
	for (const out of state.named.subplans ?? []) {
		for (const a of out.artifacts) {
			if (a.handle.kind !== "fs") continue;
			let frontmatter: unknown;
			try {
				({ frontmatter } = parseFrontmatter(readArtifactFile(handleToString(a.handle), cwd)));
			} catch {
				unparseable = true;
				findings.push({
					detail: `Unparseable frontmatter in sub-plan ${basename(a.handle.path)} — its YAML frontmatter does not parse (typically a bare ': ' inside an unquoted scalar), so its 'sources:' coverage cannot be read. Re-dispatch the cluster and re-write the sub-plan with parseable frontmatter listing every '--designs' path in 'sources:'.`,
					where: basename(a.handle.path),
				});
				continue;
			}
			const fm = frontmatter && typeof frontmatter === "object" ? (frontmatter as Record<string, unknown>) : {};
			const sources = fm.sources;
			if (!Array.isArray(sources)) continue;
			for (const s of sources) {
				if (typeof s !== "string") continue;
				const sm = DESIGN_SLICE_RE.exec(s);
				if (sm) coveredSlices.add(Number(sm[1]));
			}
		}
	}
	if (!unparseable) {
		for (const n of [...sliceNumbers].sort((a, b) => a - b)) {
			if (!coveredSlices.has(n)) {
				findings.push({
					detail: `Slice ${n} design absent from every sub-plan's 'sources:' — the cluster fanout threads each '--designs <path>' and 'synthesize' echoes them into 'sources:'; a slice whose design no sub-plan lists is one the root merge would silently drop. List every '--designs' path in its sub-plan's 'sources:'.`,
					where: `sources: slice ${n}`,
				});
			}
		}
	}
	return findings;
};

/**
 * Deterministic subplan cluster-coverage floor — the structural backstop between
 * the cluster fanout and the root merge. After `subplan` fans each slice-DAG
 * cluster out to a partial sub-plan, this reconciles what was DISPATCHED against
 * what the slice map PROMISED, before the root `plan` merge fans them in:
 *   • cluster-count conservation — the PRE-FILTER cluster count
 *     (`clusterSliceDag(sliceRecords(latest slices)).length`) must equal the
 *     number of distinct `_cluster-<k>` ordinals the fanout emitted. A re-dispatch
 *     that re-clobbered an ordinal (the pre-fix clobber bug — two clusters
 *     sharing `<k>`, or a tokenless basename) collapses the distinct count,
 *     surfacing as a missing cluster here.
 *   • token conformance — every dispatched sub-plan basename MUST carry a
 *     `_cluster-<k>` token; a tokenless name means `synthesize` dropped the
 *     `--cluster <k>` flag and the merge can't attribute it to a cluster.
 *   • duplicate/clobbered ordinal — two dispatched sub-plans sharing the same
 *     `<k>` (a clobber, not a legitimate re-emit: `placeFanoutOutput` overwrites
 *     each unit's own index in the channel slot, so within one round every unit
 *     index is a distinct artifact — a shared `<k>` is a real collision, the
 *     lost-cluster bug itself).
 *   • sources-coverage — every slice's design must appear in SOME sub-plan's
 *     `sources:` (the fanout threads each `--designs <path>` and `synthesize`
 *     echoes them into `sources:`). Designs follow the `_slice-<N>` convention, so
 *     the covered slice set is read off `sources:` and reconciled against the full
 *     slice map; a slice whose design no sub-plan lists is a slice the merge would
 *     silently drop. A sub-plan whose frontmatter does not PARSE gets its own
 *     re-dispatchable finding naming the FILE (never a `FAIL_SCRIPT_THREW` halt —
 *     the same stray-colon class `artifact-collector` degrades on), and the
 *     per-slice reconciliation defers until every sub-plan parses, so a parse
 *     failure is never mis-blamed on the slices it happened to cover.
 * Preflight: a slice with NO design on the `designs` channel halts LOUD before
 * any reconciliation — the fanout drops (or under-feeds) its cluster pre-dispatch
 * (`if (!designs.length) return undefined`), so re-dispatching `subplan` re-drops
 * it every round until the re-entry budgets exhaust (the `maxBackwardJumps`
 * cap, default 3, or the absolute `maxLaps` ceiling, default 8 — both fresh
 * per invocation) with a diagnostic naming the
 * refused re-entry instead of the cause. The missing design is upstream
 * (`slice-design`/`design-review`) and unreachable from this loop's backward
 * edge; halting here names the actual defect and spends no jump budget.
 * Emits `severity: pass ? "none" : "high"` (load-bearing — the route routes via
 * `allDimensionsPass`/`subplanGatePasses`, whose severity floor silently passes a
 * `pass:false` verdict rated `low`/`none`; a lost cluster MUST rate `high` or it
 * ships). Deliberately NOT the `match("verdict", …)` STOP idiom
 * `implementScopeCheck` uses — a lost cluster IS repairable by re-dispatch, so the
 * floor routes the backward edge to `subplan`, bounded by `maxBackwardJumps`
 * (default 3) under the absolute `maxLaps` ceiling (default 8; both budgets
 * fresh per invocation).
 * Deterministic ⇒ idempotent across re-dispatch rounds: the verdict basename is
 * keyed on the slice-map basename, so a re-run OVERWRITES its own slot.
 */
const subplanCoverageCheck = ({ state, cwd }: ScriptContext): Omit<Output, "meta"> => {
	const latestSliceMap = latestFsArtifact(state, "slices");
	if (latestSliceMap?.handle.kind !== "fs") {
		throw haltPreflight(
			"subplan-check",
			"subplan-check: no slice map to reconcile against",
			"subplan-check: no fs artifact on the 'slices' channel — slice must run before the subplan coverage check",
		);
	}
	const mapBody = readArtifactFile(latestSliceMap.handle.path, cwd);
	const records = sliceRecords(mapBody, "subplan-check", latestSliceMap.handle.path);
	// PRE-FILTER expected clusters — the count the fanout RECEIVED, not the
	// post-drop dispatched count. The fanout drops a zero-design cluster
	// (`if (!designs.length) return undefined` in SYNTH_CLUSTER_FANOUT's units);
	// design-review catches those upstream, so a healthy run lands here with
	// pre-filter == dispatched — an invariant the missing-design preflight below
	// enforces loudly rather than assumes.
	const expectedK = expectedClusterCount(records);
	const sliceNumbers = new Set(records.map((r) => r.n));

	// A slice with no design cannot be repaired by the backward edge: the fanout
	// drops a zero-design cluster pre-dispatch, so every `subplan` re-dispatch
	// reproduces the identical gap until the re-entry budgets exhaust (the
	// maxBackwardJumps cap, default 3, or the absolute maxLaps ceiling, default
	// 8) blaming the re-entry. Halt loud at the floor instead, naming the upstream cause.
	const designBySlice = designPathsBySlice(state);
	const undesigned = designCoverageGap(sliceNumbers, designBySlice);
	if (undesigned.length > 0) {
		throw haltPreflight(
			"subplan-check",
			`subplan-check: slice(s) ${undesigned.join(", ")} have no design on the 'designs' channel`,
			`subplan-check: slice(s) ${undesigned.join(", ")} in the slice map have no design artifact on the 'designs' channel, so the cluster fanout dropped (or under-fed) their cluster(s) before dispatch. Re-dispatching 'subplan' cannot repair this — no sub-plan can list a design that was never produced. The missing design(s) come from upstream ('slice-design' emits, 'design-review' re-emits the accepted docs); investigate why they never reached the 'designs' channel.`,
		);
	}

	const { dispatched, tokenless } = dispatchedClusterOrdinals(state);
	const findings: StructureFinding[] = [...tokenless];
	findings.push(...clobberedOrdinals(dispatched));

	// Cluster-count conservation — distinct dispatched ordinals vs the pre-filter
	// expected count. A clobber or a never-dispatched cluster both surface here.
	const dispatchedK = new Set(dispatched.map((d) => d.k)).size;
	if (dispatchedK < expectedK) {
		findings.push({
			detail: `Missing cluster coverage — the slice map promised ${expectedK} slice-DAG cluster(s) but the fanout dispatched ${dispatchedK} distinct '_cluster-<k>' sub-plan(s). A cluster went undispatched (or two collided on one ordinal — see any duplicate finding above); its slices would be absent from the merged plan. Re-dispatch the missing cluster(s).`,
			where: `clusters (expected ${expectedK}, dispatched ${dispatchedK})`,
		});
	}

	findings.push(...sourcesCoverageGaps(state, cwd, sliceNumbers));

	return writeStructureVerdict("subplan-check", latestSliceMap.handle, findings, cwd);
};

export { sliceSeedLift, sliceStructureCheck, subplanCoverageCheck };
