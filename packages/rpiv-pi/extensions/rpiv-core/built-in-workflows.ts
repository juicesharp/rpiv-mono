/**
 * Built-in workflows shipped with rpiv-pi. Each workflow's `stages`
 * insertion order IS its linear stage order — `Object.keys(stages)` gives
 * the natural read order for previews and traversal alike.
 *
 * Route edges use `gate(...)` from `@juicesharp/rpiv-workflow`, which
 * attaches `.targets` metadata so reachability checks and graph
 * introspectors can enumerate possible branches without probing.
 *
 * These workflows name skills bundled by rpiv-pi (research, design, plan,
 * implement, validate, code-review, revise, commit). Installing
 * rpiv-workflow without rpiv-pi means these workflows aren't loaded —
 * users author their own over their own skills.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	type Artifact,
	acts,
	defineRoute,
	defineWorkflow,
	directoryPathCollector,
	type EdgeFn,
	eq,
	type FanoutContext,
	fanin,
	fanout,
	gate,
	gitCommitOutcome,
	gt,
	handleToString,
	iterate,
	jsonBodyParser,
	match,
	type Output,
	type PromptFn,
	produces,
	type RunView,
	type ScriptContext,
	setRouteNote,
	type Unit,
	type Workflow,
} from "@juicesharp/rpiv-workflow/registration";
import { rpivBucketOutcome } from "./artifact-collector.js";
import {
	countHeadingsOutsideFences,
	FILE_LINE_CITATION_RE,
	type FsArtifact,
	fencedSpans,
	forEachLineOutsideFences,
	haltPreflight,
	latestFsArtifact,
	MAX_PHASES,
	type PhaseRecord,
	readArtifactFile,
	type StructureFinding,
	TEST_PATH_RE,
	VERDICT_DIR,
	VERDICT_FAIL_SCORE,
	VERDICT_PASS_SCORE,
	writeStructureVerdict,
} from "./built-ins/index.js";

// The code-review stage's output schema is no longer declared here — every
// code-review stage sources it from the skill's contract `produces.data`
// (`blockers_count` required), validated by the runtime output loop via
// `effectiveOutputSchema`. One source of truth, in the skill, not copy-pasted
// per workflow. Every workflow with a `code-review` stage — polish AND vet —
// routes on the same numeric gate: `gate("blockers_count", { <fix>: gt(0), commit: eq(0) }, "commit")`.

/**
 * `## Phase N:` headings — the source of truth a plan's `phases:` frontmatter
 * array is derived from. Used to verify that derived array, not to enumerate
 * (enumeration reads the typed `phases:` array).
 */
const PLAN_PHASE_RE = /^## Phase (\d+):/gm;

/**
 * Parse a plan's `phases:` frontmatter into records, derive-checked against the
 * body's `## Phase N:` headings — the source of truth both the single-plan
 * (`FRONTMATTER_PHASE_FANOUT`) and multi-plan (`PLANS_PHASE_FANOUT`) fanouts
 * share. A length mismatch means the producer's rebuild step was skipped or the
 * array went stale; throw rather than dispatch a wrong unit list. `who`/`path`
 * shape the diagnostic.
 */
const planPhaseRecords = (content: string, who: string, path: string): readonly PhaseRecord[] => {
	const { frontmatter } = parseFrontmatter(content);
	const fm = frontmatter as Record<string, unknown>;
	const raw = fm.phases;
	const phases = Array.isArray(raw) ? raw : [];
	const headingCount = countHeadingsOutsideFences(content, PLAN_PHASE_RE);
	if (phases.length !== headingCount) {
		throw haltPreflight(
			who,
			`${who}: plan ${path} has mismatched phases`,
			`${who}: plan ${path} frontmatter phases (${phases.length}) ≠ '## Phase N:' headings (${headingCount}) — the derived array is stale against the body`,
		);
	}
	// The REQUIRED scalar `phase_count` must equal the derived phase count — it
	// drives the fanout unit count. Fire only when the file declares
	// plan-ness (has phases OR a phase_count) so a genuinely empty / non-plan file
	// still degrades to [] (the existing "neither phases nor headings" path); a plan
	// that declares phases but omits phase_count THROWS (the field is contract-required).
	if ((phases.length > 0 || fm.phase_count !== undefined) && fm.phase_count !== phases.length) {
		throw haltPreflight(
			who,
			`${who}: plan ${path} has invalid phase_count`,
			`${who}: plan ${path} frontmatter phase_count (${String(fm.phase_count)}) ≠ phases length (${phases.length}) — rebuild phase_count from the '## Phase N:' headings`,
		);
	}
	return phases.map((entry, index) => {
		const e = (entry ?? {}) as Record<string, unknown>;
		return {
			entry: e,
			n: typeof e.n === "number" ? e.n : index + 1,
			title: typeof e.title === "string" ? e.title : "",
			index,
			total: phases.length,
		};
	});
};

/**
 * Read the latest plan published to the named `"plans"` channel and parse its
 * `phases:` frontmatter into records — the shared read/halt body both
 * `FRONTMATTER_PHASE_FANOUT` and `IMPLEMENT_DAG_FANOUT` source from. Returns
 * `null` when no fs plan is published (each caller degrades to `[]`); throws
 * the two `haltPreflight` diagnostics (plan-not-found, exceeds `MAX_PHASES`)
 * attributed to `who`. `promptPath` is the plan handle's string form, so each
 * fanout emits the same `${promptPath} Phase N:` prompt arg.
 */
const readPlanPhaseRecords = (
	state: RunView,
	cwd: string,
	who: string,
): { records: readonly PhaseRecord[]; promptPath: string } | null => {
	const plan = latestFsArtifact(state, "plans");
	if (plan?.handle.kind !== "fs") return null;
	const path = plan.handle.path;
	let content: string;
	try {
		content = readArtifactFile(path, cwd);
	} catch (err) {
		throw haltPreflight(
			who,
			`${who}: plan file not found`,
			`${who}: could not read ${path} — ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const records = planPhaseRecords(content, who, path);
	if (records.length > MAX_PHASES) {
		throw haltPreflight(
			who,
			`${who}: plan ${path} exceeds phase limit`,
			`${who}: plan ${path} declares ${records.length} phases — exceeds MAX_PHASES (${MAX_PHASES}); split into smaller plans`,
		);
	}
	const promptPath = handleToString(plan.handle);
	return { records, promptPath };
};

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
 * Fan `implement` out over the structured `phases:` frontmatter array of the
 * latest plan published to the named `"plans"` channel. Sourcing from the named
 * channel (not the rolling primary) makes the stage's `reads: ["plans"]`
 * declaration semantically honest. Used by every workflow whose `implement`
 * inherits one plan (build/vet); polish's accumulating multi-plan
 * variant is `PLANS_PHASE_FANOUT`.
 */
const FRONTMATTER_PHASE_FANOUT = fanout({
	source: "plans",
	unit: { by: "frontmatter-array", pattern: "phases" },
	max: MAX_PHASES,
	units: ({ state, cwd }) => {
		const read = readPlanPhaseRecords(state, cwd, "FRONTMATTER_PHASE_FANOUT");
		if (!read) return [];
		const { records, promptPath } = read;
		return records.map((r) => ({
			prompt: `${promptPath} Phase ${r.n}: ${r.title}`.trimEnd(),
			label: `phase ${r.index + 1}/${r.total}`,
		}));
	},
});

/**
 * Derive the directed `deps` edges for ONE implement phase under the dep-gated
 * DAG fanout (`IMPLEMENT_DAG_FANOUT`). Edges point strictly downward (toward
 * LOWER phase numbers), so the graph is acyclic by construction. Two clauses:
 *
 *  - clause A (self declares a `files:` write-set): `self` depends on every
 *    LOWER phase whose declared `files:` shares ≥1 entry, UNIONED with `self`'s
 *    explicit `depends_on` (semantic ordering not visible in `files:`).
 *  - clause B (self declares NO `files:`): `self` conflicts with EVERY lower
 *    phase → full chain (a write-set-less phase's writes are unknown, so it
 *    cannot be proven independent of anything below it). This is the
 *    empty-set degradation that keeps a legacy / `files:`-less plan serial at
 *    any cap (one phase per Kahn wave).
 *
 * Returns `phase-<n>` unit ids, sorted ascending. Reads `phaseFiles`
 * and `phaseDeps` — both defined later textually, but only inside this
 * runtime closure, so no TDZ (same pattern as `sliceDeps`).
 */
const implementPhaseDeps = (records: readonly PhaseRecord[], self: PhaseRecord): string[] => {
	// Twin-expanded (`withTestTwins`) so a phase declaring `x.ts` conflicts with
	// one declaring `x.test.ts` — the production phase's implicit twin write would
	// otherwise race a concurrent sibling that owns the test explicitly.
	const selfFiles = withTestTwins(phaseFiles(self.entry));
	const explicit = phaseDeps(self.entry);
	const ns = new Set<number>();
	for (const e of explicit) if (e < self.n) ns.add(e);
	if (selfFiles.length === 0) {
		// clause B — unknown write-set ⇒ conflict with every lower phase.
		for (const r of records) if (r.n < self.n) ns.add(r.n);
	} else {
		// clause A — overlap on ≥1 declared write path.
		for (const r of records) {
			if (r.n >= self.n) continue;
			const rFiles = withTestTwins(phaseFiles(r.entry));
			if (rFiles.some((f) => selfFiles.includes(f))) ns.add(r.n);
		}
	}
	return [...ns].sort((a, b) => a - b).map((n) => `phase-${n}`);
};

/**
 * Dep-gated DAG variant of `FRONTMATTER_PHASE_FANOUT` — `implement`'s twin that
 * emits per-phase `id`/`deps` edges so the wave scheduler orders phases by their
 * declared write-set overlap + explicit `depends_on`. The spread idiom inherits
 * `source`/`unit`/`max`/`onCap`/`result`/`kind` verbatim from the base; the new
 * `units` closure emits the SAME `prompt`/`label` strings AND adds
 * `id: \`phase-${r.n}\`` + `deps: implementPhaseDeps(records, r)`. NO
 * `depArtifactFlag` — implement phases feed each other through the working tree
 * (not published artifacts), so `deps` drive ONLY wave ordering. NO
 * `concurrency` property is set (the spread overrides only `units`), so the loop
 * inherits the host cap and phases fan out concurrently, bounded by `deps`.
 */
const IMPLEMENT_DAG_FANOUT = {
	...FRONTMATTER_PHASE_FANOUT,
	units: ({ state, cwd }: FanoutContext) => {
		const read = readPlanPhaseRecords(state, cwd, "IMPLEMENT_DAG_FANOUT");
		if (!read) return [];
		const { records, promptPath } = read;
		return records.map((r) => ({
			prompt: `${promptPath} Phase ${r.n}: ${r.title}`.trimEnd(),
			label: `phase ${r.index + 1}/${r.total}`,
			id: `phase-${r.n}`,
			deps: implementPhaseDeps(records, r),
		}));
	},
};

// ===========================================================================
// polish — architecture-review → blueprint (iterate, per review phase) →
//          implement → validate → code-review → (blueprint loop) | commit
//          For a large architecture review that can't be planned in one pass:
//          plan each review phase sequentially, each plan building on the
//          ones before it, then implement/validate/review the lot.
// ===========================================================================

/**
 * `### Phase N — name` headings — the source of truth the review's `phases:`
 * frontmatter array is derived from. Used to verify that derived array, not to
 * enumerate (enumeration reads the typed `phases:` array).
 */
const REVIEW_PHASE_RE = /^### Phase (\d+) — (.+)$/gm;

/** Number of structured `phases` in the latest architecture review's frontmatter (0 if none). */
const reviewPhaseCount = (state: RunView, cwd: string): number => {
	const review = latestFsArtifact(state, "architecture-reviews");
	if (review?.handle.kind !== "fs") return 0;
	const { frontmatter } = parseFrontmatter(readArtifactFile(review.handle.path, cwd));
	const raw = (frontmatter as Record<string, unknown>).phases;
	return Array.isArray(raw) ? raw.length : 0;
};

/**
 * The plans from the most recent blueprint pass. blueprint's iterate stage
 * pushes one `Output` per review phase into `state.named["plans"]`; on a
 * corrective loop it re-plans every phase, so keep only the last `phaseCount`
 * (the review's phase count) and drop the stale generation. Shared by the
 * implement fanout and the validate prompt so both see the same plan set.
 */
const latestPlans = (state: RunView, cwd: string): readonly Output[] => {
	const plans = state.named.plans ?? [];
	const phaseCount = reviewPhaseCount(state, cwd);
	return phaseCount > 0 && plans.length > phaseCount ? plans.slice(-phaseCount) : plans;
};

/** Phase number for a `phases:` entry, falling back to its 1-based position. */
const phaseNum = (entry: unknown, index: number): number => {
	const n = (entry as { n?: unknown } | undefined)?.n;
	return typeof n === "number" ? n : index + 1;
};

/** `depends_on` phase numbers an entry declares (empty when absent). */
const phaseDeps = (entry: unknown): number[] => {
	const raw = (entry as { depends_on?: unknown } | undefined)?.depends_on;
	return Array.isArray(raw) ? raw.filter((d): d is number => typeof d === "number") : [];
};

/** The repo-root-relative paths a phase entry declares it creates/edits (its
 *  `files:` array — `[]` when absent). The open-schema twin of `phaseDeps`,
 *  read straight off `PhaseRecord.entry` so `planPhaseRecords` preserves the new
 *  key unchanged. Consumed by the plan-time coverage floor
 *  (`verifyPhaseFilesCoverage`) and, in a later phase, the dep-gated implement
 *  fanout (`implementPhaseDeps`). */
const phaseFiles = (entry: unknown): string[] => {
	const raw = (entry as { files?: unknown } | undefined)?.files;
	return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string") : [];
};

/**
 * Expand a declared write-set with each production file's co-located test twin
 * (`x.ts → x.test.ts`, likewise tsx/js/jsx). This monorepo's tests are
 * compile-coupled siblings — widening a declared file's signature forces the
 * mechanical follow-up edit in its twin — so requiring every plan author,
 * elaborator, and grader to re-declare the twin is paperwork the convention
 * already guarantees (a live run STOPPED at the scope floor over exactly this:
 * a declared `lane-switcher.ts` signature change whose five-assertion twin fix
 * was undeclared prose). Applied at BOTH consumers of the declared set — the
 * DAG conflict fold (`implementPhaseDeps`) and the scope floors — so the
 * planner and the floor can never disagree; on the DAG side it also closes the
 * latent race where phases declaring `x.ts` and `x.test.ts` counted as
 * disjoint yet predictably collide. Asymmetric by design: declaring a TEST
 * file licenses nothing extra — production writes remain the act that must be
 * declared, and a write to a non-twin test still fails the floor. A file
 * already matching `TEST_PATH_RE` maps to itself (no `x.test.test.ts`).
 */
const withTestTwins = (files: readonly string[]): string[] => {
	const out = new Set(files);
	for (const f of files) {
		if (TEST_PATH_RE.test(f)) continue;
		const twin = f.replace(/\.([tj]sx?)$/, ".test.$1");
		if (twin !== f) out.add(twin);
	}
	return [...out];
};

/**
 * Per-review-phase blueprint generator (the `iterate` dual of
 * FRONTMATTER_PHASE_FANOUT). One blueprint pass per review phase, enumerating the
 * review's structured `phases:` array (derived by architecture-review from its
 * `### Phase N — name` headings). blueprint writes its own natural plan file; the
 * `plans` collector captures whatever path it announces.
 *
 * Each phase reads only the plans of the phases it `depends_on` (vs. every prior
 * plan) — accurate context, and the seam a future scheduler could parallelize on.
 * `blast_radius`/`effort` tag the label. Absent `depends_on` falls back to all
 * prior plans.
 *
 * Guards (first call): the array's length must equal the `### Phase N — name`
 * heading count (stale derive), and every `depends_on` must reference an earlier
 * phase (exists, no self/forward/cyclic edge against body order).
 */
const REVIEW_PHASE_ITERATE = iterate({
	source: "architecture-reviews",
	unit: { by: "frontmatter-array", pattern: "phases" },
	max: MAX_PHASES,
	next: ({ artifact, state, accumulated, cwd }) => {
		// Source the review from the named registry — robust to corrective re-entry,
		// where the rolling primary is the latest code-review doc, not the review.
		const review = latestFsArtifact(state, "architecture-reviews") ?? artifact;
		if (review?.handle.kind !== "fs") return null;
		const reviewPath = review.handle.path; // captured: narrowing is lost inside nested closures below
		const content = readArtifactFile(reviewPath, cwd);
		const { frontmatter } = parseFrontmatter(content);
		const raw = (frontmatter as Record<string, unknown>).phases;
		const phases = Array.isArray(raw) ? raw : [];
		const i = accumulated.length;
		if (i === 0) {
			const headingCount = countHeadingsOutsideFences(content, REVIEW_PHASE_RE);
			if (phases.length !== headingCount) {
				throw haltPreflight(
					"REVIEW_PHASE_ITERATE",
					`REVIEW_PHASE_ITERATE: review ${reviewPath} has mismatched phases`,
					`REVIEW_PHASE_ITERATE: review ${reviewPath} frontmatter phases (${phases.length}) ≠ '### Phase N —' headings (${headingCount}) — the derived array is stale against the body`,
				);
			}
			const indexByN = new Map(phases.map((e, idx) => [phaseNum(e, idx), idx]));
			phases.forEach((e, idx) => {
				for (const d of phaseDeps(e)) {
					const di = indexByN.get(d);
					if (di === undefined)
						throw haltPreflight(
							"REVIEW_PHASE_ITERATE",
							`REVIEW_PHASE_ITERATE: review ${reviewPath} has invalid depends_on`,
							`REVIEW_PHASE_ITERATE: review ${reviewPath} phase ${phaseNum(e, idx)} depends_on ${d}, which is not a declared phase`,
						);
					if (di >= idx)
						throw haltPreflight(
							"REVIEW_PHASE_ITERATE",
							`REVIEW_PHASE_ITERATE: review ${reviewPath} has cyclic dependency`,
							`REVIEW_PHASE_ITERATE: review ${reviewPath} phase ${phaseNum(e, idx)} depends_on ${d}, which is not an earlier phase (self/forward/cyclic dependency)`,
						);
				}
			});
		}
		if (i >= phases.length) return null; // every phase planned → terminate
		const entry = (phases[i] ?? {}) as { title?: unknown; blast_radius?: unknown; effort?: unknown };
		const n = phaseNum(entry, i);
		const title = typeof entry.title === "string" ? entry.title : "";

		// accumulated[j] is phase j's output — map each prior phase number to its plans.
		const priorByN = new Map<number, string[]>();
		accumulated.forEach((o, j) => {
			const paths = o.artifacts.filter((a) => a.handle.kind === "fs").map((a) => handleToString(a.handle));
			if (paths.length) priorByN.set(phaseNum(phases[j], j), paths);
		});
		const deps = phaseDeps(phases[i]);
		const prior = deps.length ? deps.flatMap((d) => priorByN.get(d) ?? []) : [...priorByN.values()].flat();
		// On a corrective pass the latest code-review is in `reviews`; fold its blockers in.
		const feedback = latestFsArtifact(state, "reviews");

		let prompt = `${handleToString(review.handle)} Implement Phase ${n}: ${title}`;
		if (prior.length)
			prompt += `\nPrior phase plans (read first; build on them, don't duplicate): ${prior.join(", ")}`;
		if (feedback?.handle.kind === "fs")
			prompt += `\nAddress the blockers in the latest code review: ${handleToString(feedback.handle)}`;
		const tags = [entry.effort, entry.blast_radius].filter((t): t is string => typeof t === "string");
		let label = `phase ${i + 1}/${phases.length} — ${title}`;
		if (tags.length) label += ` [${tags.join(", ")}]`;
		return { prompt, label, id: `phase-${n}` };
	},
});

/**
 * Fan implement out over the `phases:` array of EVERY plan in the latest
 * blueprint pass (see `latestPlans` for the corrective-loop dedup), so blueprint
 * keeps its natural timestamped filenames. The single-plan
 * `FRONTMATTER_PHASE_FANOUT` is the same over one inherited plan; both share
 * `planPhaseRecords`. MAX_PHASES is enforced on the aggregate unit count, since
 * polish fans one implement pass over the whole plan set.
 */
const PLANS_PHASE_FANOUT = fanout({
	source: "plans",
	unit: { by: "frontmatter-array", pattern: "phases" },
	max: MAX_PHASES,
	units: ({ state, cwd }) => {
		const units: Unit[] = [];
		for (const out of latestPlans(state, cwd)) {
			for (const a of out.artifacts) {
				if (a.handle.kind !== "fs") continue;
				const path = a.handle.path;
				const content = readArtifactFile(path, cwd);
				const promptPath = handleToString(a.handle);
				for (const r of planPhaseRecords(content, "PLANS_PHASE_FANOUT", path)) {
					units.push({
						prompt: `${promptPath} Phase ${r.n}: ${r.title}`.trimEnd(),
						label: `${basename(path)} P${r.n}`,
					});
				}
			}
		}
		if (units.length > MAX_PHASES) {
			throw haltPreflight(
				"PLANS_PHASE_FANOUT",
				`PLANS_PHASE_FANOUT: phase limit exceeded`,
				`PLANS_PHASE_FANOUT: ${units.length} phases exceeds MAX_PHASES (${MAX_PHASES})`,
			);
		}
		return units;
	},
});

/** `implement`'s serial twin of `PLANS_PHASE_FANOUT` (polish's multi-plan variant) — serialized (`concurrency: 1`) because the fanout's units share a working tree and their write-sets are unknown, so the scheduler cannot derive dep edges (no scope floor guards it). */
const IMPLEMENT_PLANS_FANOUT = { ...PLANS_PHASE_FANOUT, concurrency: 1 };

/**
 * Hand the single validate session EVERY plan from the latest blueprint pass
 * (`latestPlans`). The runner's default rolling-primary — and a plain
 * `reads: ["plans"]`, which only reads `.at(-1)` — would point validate at the
 * LAST plan alone, leaving earlier phases unvalidated. A `prompt` stage owns
 * its whole message, so the `/skill:validate` prefix is explicit.
 */
const VALIDATE_PLANS_PROMPT: PromptFn = ({ state, cwd }) => {
	const paths = latestPlans(state, cwd)
		.flatMap((o) => o.artifacts)
		.filter((a) => a.handle.kind === "fs")
		.map((a) => handleToString(a.handle));
	return `/skill:validate ${paths.join(" ")}`;
};

const polishWorkflow = defineWorkflow({
	name: "polish",
	description:
		"Architecture-review-driven polish: review → per-phase blueprint (sequential, accumulating) → implement → validate → code-review → commit. Best when a large architecture review can't be planned in one pass and each phase's plan must build on the ones before it.",
	start: "architecture-review",
	stages: {
		"architecture-review": produces(),
		blueprint: produces({ loop: REVIEW_PHASE_ITERATE }),
		implement: acts({ loop: IMPLEMENT_PLANS_FANOUT, reads: ["plans"] }),
		validate: produces({ prompt: VALIDATE_PLANS_PROMPT }),
		"code-review": produces(),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
		"architecture-review": "blueprint",
		blueprint: "implement",
		implement: "validate",
		validate: "code-review",
		// Backward edge: code-review → blueprint re-plans (implement needs a plan).
		// The iterate stage re-runs over every review phase; bounded by the
		// runner's default maxBackwardJumps (3 → up to 4 review iterations).
		"code-review": gate("blockers_count", { blueprint: gt(0), commit: eq(0) }, "commit"),
		commit: "stop",
	},
});

// ===========================================================================
// build — goal (verbatim-brief capture) → research → slice → slice-check
//         (deterministic floor) → slice-grade (design-readiness, slice-fix loop)
//         → slice-design (fanout) → design-review (one human checkpoint) →
//         subplan (cluster fanout) → plan → plan-grade (plan-fix loop) →
//         code (fanout) → code-splice → code-grade (code-fix loop) →
//         implement → implement-scope-check → reconcile → validate → commit
//   The sliced, panel-gated heavy path: capture the user's brief verbatim as the
//   `goal` channel (the north star the judgment seams — the two grade panels'
//   completeness/correctness dimensions and validate — anchor against), research
//   the brief (so every slice
//   rests on a real, cited footing and the plan gate can grade architecture-fit),
//   decompose it into independent
//   vertical slices, gate that breakdown BEFORE any design so each slice is
//   chewable by one design-slice pass. The gate is two-phase: a DETERMINISTIC
//   floor (`slice-check`) enforces dependency-cycle freedom and brief-coverage
//   conservation (a slice-fix may redistribute the brief, never drop scope to pass),
//   then ONE LLM `design-readiness` judgment reconciles the formerly-opposing
//   split/merge forces. Then design every slice in parallel and pause at ONE
//   consolidated human checkpoint (`design-review`) — the single fan-in seam where
//   every design exists and nothing parallel runs — to accept or adjust the
//   proposed interfaces/data types before synthesis. Then merge hierarchically
//   (per-cluster sub-plans → one plan) so no pass holds every design, gate the
//   plan on quality dimensions BEFORE any code, elaborate code per phase and
//   splice it in, re-grade the code-bearing plan, then implement/validate/commit.
// ===========================================================================

/**
 * The single LLM dimension the EARLY gate grades the slice map against — before
 * any design. `design-readiness` asks the one question the whole gate exists to
 * answer: is each slice chewable by ONE `design-slice` pass? It subsumes the old
 * four-way panel (right-sizing + vertical-shape + design-readiness + the
 * contract-ownership half of independence) into one holistic judgment — taking
 * its own name from that design-readiness member, the dominant sub-aspect — so
 * the formerly-opposing split-pressure (right-sizing) and merge-pressure
 * (vertical-shape) forces are reconciled by ONE grader instead of two blind
 * panelists that ping-pong the reslice loop. The structural floor that was the
 * other half of independence — dependency-cycle freedom — plus brief-coverage
 * conservation are enforced DETERMINISTICALLY by `slice-check`, not graded
 * here. Mirrors the `design-readiness` rubric row in the `grade` skill.
 */
const SLICE_DIMENSIONS = ["design-readiness"] as const;

/**
 * Quality dimensions the LATER gate grades the synthesized plan against.
 * Includes `architecture-fit`: build front-loads a `research` stage, so the
 * research artifact is always present to feed that dimension's `--context`
 * (threaded in by `gradePanelFanout` for this one dimension).
 */
const PLAN_DIMENSIONS = [
	"completeness",
	"correctness",
	"actionability",
	"pattern-following",
	"architecture-fit",
] as const;

/**
 * The FIXED three-dimension roster ship's grade panel grades — the bespoke,
 * tier-independent counterpart of `PLAN_DIMENSIONS`. Ship is a lightweight
 * preset: it front-loads `research` (so `architecture-fit` always has its
 * `--context`) and grades a trimmed, always-on set regardless of run shape.
 * `SHIP_DIMENSION_FANOUT` and `shipGatePasses` bind this roster DIRECTLY — no
 * `gateRoster(gateTier(...))` wrap — so a single-phase ship run still grades
 * `architecture-fit`, the dimension a tiered gate would drop in the light
 * roster. Order mirrors `PLAN_DIMENSIONS` (goal-anchored dimensions first,
 * fit last) so the emitted units stay stable.
 */
export const SHIP_DIMENSIONS = ["completeness", "correctness", "architecture-fit"] as const;

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

/** Parse `git status --porcelain`/`--short` output into dirty paths. Strips the
 *  2-char `XY` status prefix and resolves rename targets (`XY old -> new` → `new`),
 *  so the two output forms (`--porcelain`, `--short`) normalize identically. A
 *  porcelain line is always `XY <path>` or `XY <old> -> <new>`; blank lines drop. */
const parseGitStatusPaths = (out: string): string[] =>
	out
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => {
			const rest = l.slice(3).trim();
			const arrow = rest.indexOf(" -> ");
			return arrow >= 0 ? rest.slice(arrow + 4).trim() : rest;
		});

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
 * Current dirty-path set via `git status --porcelain` (rename targets resolved by
 * the shared parser). Best-effort — `[]` on a non-repo / git-missing tree (the
 * scope floor degrades to unguarded rather than failing a non-repo run; the
 * catch treats that as a supported silent degrade). stdio: stderr is ignored,
 * otherwise git's "fatal: not a git repository" leaks to the parent's stderr
 * despite the catch. `-uall` enumerates untracked files individually (a collapsed
 * `newdir/` entry can never string-match a declared `files:` path) — the
 * baseline writer and both scope checks MUST share this flag or their path
 * universes diverge.
 */
const gitDirtyPaths = (cwd: string): string[] => {
	try {
		const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return parseGitStatusPaths(out);
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
 * `goal` displaces `research` as build's start stage, and ONLY the start stage
 * receives `originalInput` as its skill arg (`stageEntryArgs` case 1) — a plain
 * `produces()` research would silently receive the rolling primary (the goal
 * FILE PATH) instead of the brief text. A prompt stage owns its whole message,
 * so this rebuilds research's pre-goal dispatch byte-for-byte; the outcome
 * deriver still wires the `research` bucket off the record key (the polish
 * `validate` prompt-stage precedent).
 */
const RESEARCH_BRIEF_PROMPT: PromptFn = ({ state }) => `/skill:research ${state.originalInput}`;

/**
 * ship's research front-load — a LEANER grounding than build's `/skill:research`
 * pass. Bypasses the research skill and bounds the agent to at most TWO targeted
 * `codebase-analyzer` dispatches (sequentially — never parallel, never
 * `run_in_background`) to map only what a lightweight single-phase plan needs to
 * be correct: entry points, the relevant module's shape, and the conventions the
 * implement lane must match. The agent then `Write`s a grounding doc under
 * `.rpiv/artifacts/research/`, where the research bucket collector harvests it —
 * the grade panel's architecture-fit dimension threads it as `--context` exactly
 * as build's research artifact does. A prompt stage (no skill), so the stage
 * name `research` drives outcome derivation (research contract → `research`
 * bucket), exactly as build's `RESEARCH_BRIEF_PROMPT` stage does — the prompt
 * text, not dispatch, is what differs.
 */
const SHIP_RESEARCH_PROMPT: PromptFn = ({ state }) =>
	[
		"Ground this brief for a lightweight ship plan.",
		"Do NOT dispatch /skill:research. Instead dispatch at most TWO targeted codebase-analyzer subagents (sequentially — never parallel, never run_in_background) to map only what a single-phase plan needs to be correct: entry points, the relevant module's shape, and the conventions the implement lane must match.",
		"",
		`Brief: ${state.originalInput}`,
		"",
		"Then Write a grounding doc under .rpiv/artifacts/research/ (timestamped filename) carrying the findings, and stop.",
	].join("\n");

/** `## Slice N:` headings — the source of truth a slice map's `slices:` array is derived from. */
const SLICE_HEADING_RE = /^## Slice (\d+):/gm;

/**
 * Parse a slice map's `slices:` frontmatter into `{ n, title }` records,
 * derive-checked against the body's `## Slice N:` headings and the required
 * `slice_count` scalar — the slices twin of `planPhaseRecords`. A mismatch means
 * the producer's rebuild was skipped or the array went stale; throw rather than
 * dispatch a wrong unit list.
 */
const sliceRecords = (content: string, who: string, path: string): readonly PhaseRecord[] => {
	const { frontmatter } = parseFrontmatter(content);
	const fm = frontmatter as Record<string, unknown>;
	const raw = fm.slices;
	const slices = Array.isArray(raw) ? raw : [];
	const headingCount = countHeadingsOutsideFences(content, SLICE_HEADING_RE);
	if (slices.length !== headingCount) {
		throw haltPreflight(
			who,
			`${who}: slice map ${path} has mismatched slices`,
			`${who}: slice map ${path} frontmatter slices (${slices.length}) ≠ '## Slice N:' headings (${headingCount}) — the derived array is stale against the body`,
		);
	}
	if ((slices.length > 0 || fm.slice_count !== undefined) && fm.slice_count !== slices.length) {
		throw haltPreflight(
			who,
			`${who}: slice map ${path} has invalid slice_count`,
			`${who}: slice map ${path} frontmatter slice_count (${String(fm.slice_count)}) ≠ slices length (${slices.length}) — rebuild slice_count from the '## Slice N:' headings`,
		);
	}
	return slices.map((entry, index) => {
		const e = (entry ?? {}) as Record<string, unknown>;
		return {
			entry: e,
			n: typeof e.n === "number" ? e.n : index + 1,
			title: typeof e.title === "string" ? e.title : "",
			index,
			total: slices.length,
		};
	});
};

// Relocated ABOVE SLICE_DESIGN_FANOUT (deleted from its old location below) so it sits
// above its first textual reference. (No TDZ today even unrelocated — `sliceDeps` is only
// read inside the `units` runtime closure, which runs at dispatch, not module-eval — but
// placing it above the fanout keeps the read-order obvious and matches `clusterSliceDag`'s
// existing use below.)
/** The slice-number deps a slice-map entry declares (empty when absent). */
const sliceDeps = (entry: Record<string, unknown>): number[] => {
	const raw = entry.deps;
	return Array.isArray(raw) ? raw.filter((d): d is number => typeof d === "number") : [];
};

/** Fan `design-slice` out over the latest slice map's `slices:` array — one design
 *  session per slice, dependency-ordered. `deps` (slice-N unit ids) drive the wave
 *  scheduler; `depArtifactFlag` injects each completed dependency's design path as
 *  `--upstream <path>` so a dependent slice reads its dependency's decided Key Interfaces. */
const SLICE_DESIGN_FANOUT = fanout({
	source: "slices",
	unit: { by: "frontmatter-array", pattern: "slices" },
	max: MAX_PHASES,
	depArtifactFlag: "--upstream",
	units: ({ state, cwd }) => {
		const doc = latestFsArtifact(state, "slices");
		if (doc?.handle.kind !== "fs") return [];
		const path = doc.handle.path;
		const promptPath = handleToString(doc.handle);
		return sliceRecords(readArtifactFile(path, cwd), "SLICE_DESIGN_FANOUT", path).map((r) => ({
			prompt: `${promptPath} Slice ${r.n}: ${r.title}`.trimEnd(),
			label: `slice ${r.index + 1}/${r.total}`,
			id: `slice-${r.n}`,
			deps: sliceDeps(r.entry).map((n) => `slice-${n}`), // directed edges → unit ids (slice-N)
		}));
	},
});

/** Max slices per synth cluster — a context-budget proxy; oversized DAG components split by this. */
const MAX_CLUSTER_SLICES = 6;

/**
 * Group slices into clusters = connected components of the `deps` DAG (a slice
 * and everything it transitively depends on / that depends on it land together),
 * so coupled slices reconcile inside ONE subplan pass and only cross-cluster
 * seams reach the root. Components larger than `MAX_CLUSTER_SLICES` are chunked
 * (by slice number) to bound each pass's context. Returns clusters of slice
 * numbers, each sorted ascending; components ordered by their smallest slice.
 */
const clusterSliceDag = (records: readonly PhaseRecord[]): number[][] => {
	const ns = records.map((r) => r.n);
	const parent = new Map<number, number>(ns.map((n) => [n, n]));
	const find = (x: number): number => {
		let root = x;
		while (parent.get(root) !== root) root = parent.get(root) ?? root;
		let cur = x;
		while (parent.get(cur) !== root) {
			const next = parent.get(cur) ?? root;
			parent.set(cur, root);
			cur = next;
		}
		return root;
	};
	const union = (a: number, b: number): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};
	for (const r of records) for (const d of sliceDeps(r.entry)) if (parent.has(d)) union(r.n, d);
	const byRoot = new Map<number, number[]>();
	for (const n of ns) {
		const root = find(n);
		const arr = byRoot.get(root);
		if (arr) arr.push(n);
		else byRoot.set(root, [n]);
	}
	const clusters: number[][] = [];
	for (const comp of [...byRoot.values()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))) {
		const sorted = [...comp].sort((a, b) => a - b);
		for (let i = 0; i < sorted.length; i += MAX_CLUSTER_SLICES) {
			clusters.push(sorted.slice(i, i + MAX_CLUSTER_SLICES));
		}
	}
	return clusters;
};

/**
 * A directed dependency cycle in the slice DAG (`A→B→…→A`), returned as the slice
 * numbers on the cycle; empty when acyclic. `clusterSliceDag` groups by the
 * UNDIRECTED connected component, which a directed cycle survives — so the
 * design-readiness gate needs this separate directed check. A cycle is the true
 * independence defect (slices in a cycle cannot be designed independently); the
 * deterministic floor catches it without an LLM coin-flip.
 */
const sliceDepCycle = (records: readonly PhaseRecord[]): number[] => {
	const deps = new Map<number, number[]>(records.map((r) => [r.n, sliceDeps(r.entry)]));
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<number, number>();
	const stack: number[] = [];
	let cycle: number[] = [];
	const visit = (n: number): boolean => {
		color.set(n, GRAY);
		stack.push(n);
		for (const d of deps.get(n) ?? []) {
			if (!deps.has(d)) continue; // a dangling dep is a derive/numbering concern, not a cycle
			const c = color.get(d) ?? WHITE;
			if (c === GRAY) {
				cycle = stack.slice(stack.indexOf(d));
				return true;
			}
			if (c === WHITE && visit(d)) return true;
		}
		stack.pop();
		color.set(n, BLACK);
		return false;
	};
	for (const r of records) if ((color.get(r.n) ?? WHITE) === WHITE && visit(r.n)) break;
	return cycle;
};

/**
 * One frozen coverage unit — the brief's ID'd decomposition, set once at the
 * first (human-confirmed) cut and conserved across every reslice. The conserved
 * quantity the gate was missing: a reslice may REDISTRIBUTE units across slices,
 * never DROP one — which is what closes the "pass by simplifying / shrinking
 * scope" escape hatch the sizing dimensions can't see.
 */
interface CoverageUnit {
	id: string;
	brief: string;
}

/** Parse a slice map's `coverage:` frontmatter into `{ id, brief }` units (empty when absent). */
const sliceCoverageUnits = (content: string): CoverageUnit[] => {
	const { frontmatter } = parseFrontmatter(content);
	const raw = (frontmatter as Record<string, unknown>).coverage;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((e) => {
		const o = (e ?? {}) as Record<string, unknown>;
		return typeof o.id === "string" ? [{ id: o.id, brief: typeof o.brief === "string" ? o.brief : "" }] : [];
	});
};

/** The coverage-unit ids a slice entry claims to deliver (its `covers:` array). */
const sliceCovers = (entry: Record<string, unknown>): string[] => {
	const raw = entry.covers;
	return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
};

/**
 * Verify every `file:line` citation in `body` resolves against the working tree:
 * the cited file must exist AND carry at least the cited line (a range's high end).
 * A path that misses direct (repo-root/absolute) resolution falls back to the
 * tree file whose path ends with it on whole segments — bare basenames and
 * package-relative forms both back the citation iff exactly ONE tree file
 * matches; an ambiguous suffix stays unresolved (the finding names the
 * candidates so the fix arm can disambiguate). A citation that names no real
 * file, or points past end-of-file, is UNBACKED precision — a fabricated
 * reference that must fail the gate rather than propagate into design. A bare
 * `path` with no `:line` is not checked (the contract is "verifiable line
 * numbers, or omit them"). Returns one finding per bad citation.
 */
/** Trees a citation must never resolve INTO — vendored deps, build copies, or
 * prior pipeline artifacts (a stale artifact copy would back a fabricated line). */
const CITATION_WALK_SKIP: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "coverage", ".rpiv"]);
/** Backstop so a pathological tree can't stall the deterministic cite floor. */
const CITATION_WALK_FILE_CAP = 50_000;

/** The lazily-built basename → absolute-path(s) index backing the suffix
 *  fallback in `resolveCitationPath`. `truncated` marks a partial walk past
 *  `CITATION_WALK_FILE_CAP`, which disables the fallback (uniqueness
 *  untrustworthy). */
type BasenameIndex = { index: Map<string, string[]>; truncated: boolean };

/**
 * Index every source file's basename → its absolute path(s) under `cwd` — the
 * candidate pool behind the suffix fallback in `verifyCitations`. The generative
 * producers (slice/synthesize/elaborate) routinely cite a file by bare basename
 * (`built-in-workflows.ts:1431`) or by a package-relative suffix
 * (`validate/stage-rules.ts:70` for `packages/rpiv-workflow/validate/stage-rules.ts`)
 * — mechanical path-prefix omissions, not fabricated references. The basename
 * keys the candidates; `verifyCitations` narrows them by whole-segment suffix.
 * A UNIQUE match backs the citation; an AMBIGUOUS one stays unresolved so the
 * producer must disambiguate with the repo-root-relative path. Skips
 * vendored/generated trees so a citation never resolves to a build copy or a
 * prior artifact. Bounded by the file cap.
 */
const buildBasenameIndex = (cwd: string): BasenameIndex => {
	// Unreadable dir → empty listing, never a throw from the deterministic floor.
	const listDir = (dir: string) => {
		try {
			return readdirSync(dir, { withFileTypes: true });
		} catch {
			return [];
		}
	};
	const index = new Map<string, string[]>();
	const stack: string[] = [cwd];
	let seen = 0;
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		for (const e of listDir(dir)) {
			if (e.isDirectory()) {
				if (!CITATION_WALK_SKIP.has(e.name)) stack.push(join(dir, e.name));
				continue;
			}
			if (!e.isFile()) continue;
			// Past the cap the index is INCOMPLETE, so "exactly one match" can no
			// longer be trusted — mark it truncated and let the caller disable the
			// fallback (strict direct-resolution only) rather than back a possibly
			// wrong file off a partial walk.
			if (++seen > CITATION_WALK_FILE_CAP) return { index, truncated: true };
			const abs = join(dir, e.name);
			const arr = index.get(e.name);
			if (arr) arr.push(abs);
			else index.set(e.name, [abs]);
		}
	}
	return { index, truncated: false };
};

/** Outcome of resolving a single citation's `path` against `cwd`. `abs` is the
 *  one backing file when resolution is unique; `ambiguous` carries the candidate
 *  list (absolute paths) when more than one tree file matches, so the caller can
 *  render the disambiguation finding text. `undefined` ⇒ no match
 *  (does-not-exist). This is the minimal-deviation return shape — a plain
 *  `string | undefined` would drop the candidate list the disambiguation finding
 *  text depends on. */
type CitationResolution = { abs: string } | { ambiguous: string[] };

/** Strategy 4 of `resolveCitationPath`: tree files whose REPO-RELATIVE path ends
 *  with the cited `path` on WHOLE segments. A bare basename is the one-segment
 *  case; a multi-segment citation narrows the basename's candidates at a `/`
 *  boundary, so `workflow/validate/x.ts` can never match inside
 *  `rpiv-workflow/validate/x.ts`. Compared repo-relative (never against the
 *  absolute path) so the checkout directory's own name can never back a citation
 *  — `src/utils.ts` must not resolve to `<cwd>/utils.ts` just because the repo
 *  happens to be cloned at `/tmp/src`. Reads/writes the shared `indexHolder` so
 *  the basename index is built lazily ONCE and shared across citations (the
 *  first direct-resolution miss pays the tree walk). */
const suffixMatchesFor = (path: string, cwd: string, indexHolder: { value: BasenameIndex | undefined }): string[] => {
	indexHolder.value ??= buildBasenameIndex(cwd);
	if (indexHolder.value.truncated) return []; // partial index ⇒ uniqueness untrustworthy ⇒ strict
	const candidates = indexHolder.value.index.get(basename(path)) ?? [];
	if (!path.includes("/")) return candidates;
	const suffix = `/${path}`;
	return candidates.filter((abs) =>
		`/${abs
			.slice(cwd.length + 1)
			.split(sep)
			.join("/")}`.endsWith(suffix),
	);
};

/** Resolve a citation's `path` to one backing file under `cwd`, encapsulating
 *  all four strategies in order: (1) direct — `path` or `cwd/path`; (2,3)
 *  dependency probes — `node_modules/<path>` and `node_modules/@<path>` (the
 *  latter because the citation regex cannot carry `@`, so a cited
 *  `node_modules/@scope/pkg/f.js` parses as `scope/pkg/f.js`); DIRECT probes
 *  only — the suffix walk still skips `node_modules` (per `CITATION_WALK_SKIP`),
 *  so a bare basename never resolves into a dep; (4) suffix fallback — a UNIQUE
 *  tree-file suffix match backs the citation, an AMBIGUOUS one returns the
 *  candidate list. PURE: emits no findings and throws never — all finding text
 *  lives in `verifyCitations`. The lazily-built basename index is shared across
 *  calls via `indexHolder`. */
const resolveCitationPath = (
	path: string,
	cwd: string,
	indexHolder: { value: BasenameIndex | undefined },
): CitationResolution | undefined => {
	// Strategy 1 — direct.
	const direct = isAbsolute(path) ? path : join(cwd, path);
	if (existsSync(direct) && statSync(direct).isFile()) return { abs: direct };
	// Strategies 2 & 3 — dependency probes (lockfile-pinned dep source; the regex
	// cannot carry `@`, so `node_modules/@scope/pkg/f.js` is cited as `scope/pkg/f.js`).
	for (const candidate of [join(cwd, "node_modules", path), join(cwd, "node_modules", `@${path}`)]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return { abs: candidate };
	}
	// Strategy 4 — suffix fallback: back the citation iff exactly ONE tree file matches.
	const matches = suffixMatchesFor(path, cwd, indexHolder);
	if (matches.length === 1) return { abs: matches[0] };
	if (matches.length > 1) return { ambiguous: matches };
	return undefined;
};

/** Example-path namespaces the skill prompts use in illustrative citations
 *  (`path/to/file.ext:12`, `packages/x/y.ts:42`). Artifacts quote — and models
 *  imitate — these examples in unfenced prose, where the fence skip cannot
 *  reach them; a citation under one of these prefixes is documentation shape,
 *  never a claim about the tree, and prosecuting one buys a full LLM fix round
 *  for zero risk averted (three of f329's floor failures were this class). */
const PLACEHOLDER_CITATION_PREFIXES: readonly string[] = ["path/to/", "packages/x/"];

const verifyCitations = (body: string, cwd: string): { detail: string; where: string }[] => {
	const findings: { detail: string; where: string }[] = [];
	const seen = new Set<string>();
	// Fenced text is example/fixture territory, not prose asserting a real
	// file:line — a fenced placeholder shaped like a citation must not fail the
	// floor (it false-failed the very plan that fixes this). Span check, not a
	// placeholder-pattern skip: a REAL citation that merely looks placeholder-ish
	// still verifies when it appears in prose.
	const fenced = fencedSpans(body);
	// Built lazily and reused across citations — only the first direct-resolution
	// miss pays the tree walk, and only when at least one such citation exists.
	const indexHolder: { value: BasenameIndex | undefined } = { value: undefined };
	for (const m of body.matchAll(FILE_LINE_CITATION_RE)) {
		const [, path, startStr, endStr] = m;
		if (!path || !startStr) continue;
		if (fenced.some(([s, e]) => m.index >= s && m.index < e)) continue;
		if (PLACEHOLDER_CITATION_PREFIXES.some((p) => path.startsWith(p))) continue;
		const key = `${path}:${startStr}${endStr ? `-${endStr}` : ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const resolved = resolveCitationPath(path, cwd, indexHolder);
		if (resolved && "ambiguous" in resolved) {
			// More than one tree file matches — name the candidates so the fix arm can disambiguate.
			const shown = resolved.ambiguous
				.slice(0, 3)
				.map((a) => (a.startsWith(cwd + sep) ? a.slice(cwd.length + 1) : a));
			findings.push({
				detail: `Unbacked citation ${key} — ${path} matches ${resolved.ambiguous.length} tree files (${shown.join(", ")}${resolved.ambiguous.length > shown.length ? ", …" : ""}); a citation must name ONE file. Disambiguate with the repo-root-relative path.`,
				where: key,
			});
			continue;
		}
		const abs = resolved?.abs;
		if (!abs) {
			findings.push({
				detail: `Unbacked citation ${key} — the cited file does not exist at this revision. A file:line citation must resolve, or the line numbers must be omitted. Fix the path (repo-root-relative, or node_modules/<pkg>/… for an installed dependency file) or drop the citation.`,
				where: key,
			});
			continue;
		}
		// A file that vanishes or turns unreadable between resolution and the read
		// is an unbacked citation, never a throw out of the deterministic floor.
		let lineCount: number;
		try {
			lineCount = readFileSync(abs, "utf-8").split("\n").length;
		} catch {
			findings.push({
				detail: `Unbacked citation ${key} — ${path} resolved but could not be read at this revision. A file:line citation must be verifiable, or the line numbers must be omitted. Fix the path (repo-root-relative) or drop the citation.`,
				where: key,
			});
			continue;
		}
		const high = Math.max(Number(startStr), endStr ? Number(endStr) : 0);
		if (high > lineCount) {
			findings.push({
				detail: `Unbacked citation ${key} — ${path} has ${lineCount} lines, so line ${high} matches no version of the file. A file:line citation must be verifiable, or the line numbers must be omitted. Correct the range or drop the line numbers.`,
				where: key,
			});
		}
	}
	return findings;
};

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

/** The verdict fields the cite-only discharge consults. */
type CiteRemedyVerdict = {
	pass?: boolean;
	remedy?: string;
	findings?: readonly { requires?: unknown }[];
};

/**
 * Deterministic discharge of a CITE-ONLY `design-readiness` fail — the middle
 * case between "carry a passing verdict" (impossible on the slice gate: its
 * lone dimension failed) and "buy a full re-grade panel" (wasteful when the
 * grader already named the exact citations to add or refresh). A fix that
 * also restructured forfeits the discharge and takes the normal re-grade.
 */
const citeRemedyDischarged = (state: RunView, mapBody: string): boolean => {
	const verdict = latestVerdictPerDimension(state.named["slice-verdicts"]).get("design-readiness");
	const v = verdict?.data as CiteRemedyVerdict | undefined;
	if (v?.pass !== false || v.remedy !== "cite") return false;
	// A fix must have LANDED since the verdict — discharging the judged map
	// unchanged would contradict the grader, who read it and found the cites
	// wrong. Basename inequality cannot witness the fix (a re-slice may
	// legitimately edit the map in place); publication order can: the latest
	// `slices` round must postdate the verdict.
	const entries = state.named.slices ?? [];
	const verdictTs = verdict?.meta?.ts;
	const currentTs = entries.at(-1)?.meta?.ts;
	if (typeof verdictTs !== "string" || typeof currentTs !== "string" || currentTs <= verdictTs) return false;
	const findings = Array.isArray(v.findings) ? v.findings : [];
	if (findings.length === 0) return false;
	const spans = fencedSpans(mapBody);
	if (!findings.every((f) => f != null && citeFindingSatisfied(mapBody, spans, f))) return false;
	// Shape must match the round the grader judged — located by publication
	// order, not filename, for the same in-place reason.
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
	const findings: { detail: string; where: string }[] = [];

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

	// Stamp the cite-only discharge ONLY on a green floor: structure clean +
	// citation backing verified + demanded seeds present + shape unchanged is
	// exactly what a fresh design-readiness pass on this map would re-establish,
	// so the `sliceGatePasses` skip stays provably equivalent to "re-grade, then pass".
	const discharge =
		findings.length === 0 && citeRemedyDischarged(state, mapBody)
			? { citeDischarged: basename(latest.handle.path) }
			: undefined;
	return writeStructureVerdict("slice-check", latest.handle, findings, cwd, discharge);
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
 * it every round until `maxBackwardJumps` exhausts with a diagnostic naming the
 * refused re-entry instead of the cause. The missing design is upstream
 * (`slice-design`/`design-review`) and unreachable from this loop's backward
 * edge; halting here names the actual defect and spends no jump budget.
 * Emits `severity: pass ? "none" : "high"` (load-bearing — the route routes via
 * `allDimensionsPass`/`subplanGatePasses`, whose severity floor silently passes a
 * `pass:false` verdict rated `low`/`none`; a lost cluster MUST rate `high` or it
 * ships). Deliberately NOT the `match("verdict", …)` STOP idiom
 * `implementScopeCheck` uses — a lost cluster IS repairable by re-dispatch, so the
 * floor routes the backward edge to `subplan`, bounded by `maxBackwardJumps`.
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
	// reproduces the identical gap until maxBackwardJumps exhausts blaming the
	// re-entry. Halt loud at the floor instead, naming the upstream cause.
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

/**
 * Slice a plan body into per-phase text keyed by phase number, splitting on
 * `## Phase N:` headings OUTSIDE fenced code blocks (a heading inside a ``` or
 * ~~~ fence is example/fixture text, not a structural phase boundary — mirrors
 * `countHeadingsOutsideFences` so the slice and the derive-check agree). The
 * body for phase N runs from its heading line up to (not including) the next
 * out-of-fence `## Phase M:` heading, or end-of-text for the last phase.
 * Returns a `Map<number, string>` (phase n → body text, heading included).
 */
const phaseBodySlices = (content: string): Map<number, string> => {
	const lineRe = new RegExp(PLAN_PHASE_RE.source); // drop g/m; per-line test, lastIndex can't drift
	const lines = content.split("\n");
	const openings: { n: number; start: number }[] = [];
	forEachLineOutsideFences(content, (line, i) => {
		const m = lineRe.exec(line);
		if (m?.[1]) openings.push({ n: Number(m[1]), start: i });
	});
	const slices = new Map<number, string>();
	for (let idx = 0; idx < openings.length; idx++) {
		const end = idx + 1 < openings.length ? openings[idx + 1].start : lines.length;
		slices.set(openings[idx].n, lines.slice(openings[idx].start, end).join("\n"));
	}
	return slices;
};

/** Strip a trailing `:line` or `:line-line` citation suffix from a path token. */
const stripLineSuffix = (p: string): string => p.replace(/:\d+(?:-\d+)?$/, "");

/** Well-known extensionless filenames — the extension heuristic below would drop
 *  them, so an undeclared write to one would silently escape the coverage floor.
 *  Recognized bare or as the basename of a path. */
const EXTENSIONLESS_FILENAME_RE =
	/^(?:Makefile|Dockerfile|Rakefile|Gemfile|Justfile|Procfile|LICENSE|NOTICE|CODEOWNERS)$/;

/** Path-like test mirroring slice-overlap.mjs's `looksLikePath`, applied AFTER
 *  stripping a `:line` suffix (the blueprint MODIFY heading — `#### N. path/to/file.ext`
 *  with a `:12-30` range appended — carries a line range the bare form rejects).
 *  Extensionless recognition is allowlist-only (never "any `/`-bearing token"):
 *  prose like `and/or` must not read as a declared write. */
const isPathLike = (s: string): boolean => {
	if (/\s/.test(s)) return false;
	if (EXTENSIONLESS_FILENAME_RE.test(s.slice(s.lastIndexOf("/") + 1))) return true;
	return /\.[A-Za-z0-9]+$/.test(s) && (s.includes("/") || /^[\w.-]+\.[A-Za-z0-9]+$/.test(s));
};

/**
 * Extract the edit paths a phase body names, across the three artifact
 * conventions the plan/blueprint/synthesize skills emit, OUTSIDE fenced code
 * blocks (a path inside a ``` fence is a code reference, not a declared write —
 * post-`code-splice` safety, since code-splice folds elaborations' fenced code
 * into the plan and those fenced paths must NOT read as phase writes):
 *   • `**File**:` / `**Files**:` — plan/blueprint's per-change file line
 *     (a backticked comma-list under `**Files**:`, or a single path under `**File**:`).
 *   • `#### N. path/to/file.ext` — blueprint's change subsection heading
 *     (may carry a `:line`-range suffix on MODIFY entries — stripped).
 *   • `- `path/to/file.ts`` — synthesize's backticked-path list item under
 *     `### Changes` (the form `elaborate`/`synthesize` emit).
 * Strips a trailing `:line`/`:line-line` suffix. Mirrors slice-overlap.mjs's
 * `filesOf` + `looksLikePath` and extends them with the synthesize list-item
 * form. Returns a de-duplicated `string[]`.
 */
const editPathsOfPhase = (phaseBody: string): string[] => {
	const files = new Set<string>();
	const add = (raw: string) => {
		const stripped = stripLineSuffix(raw.replace(/[`*]/g, "").trim());
		if (stripped && isPathLike(stripped)) files.add(stripped);
	};
	forEachLineOutsideFences(phaseBody, (line) => {
		const fm = line.match(/^\*\*Files?\*\*:\s*(.+)$/);
		if (fm) {
			for (const tok of fm[1].split(/[,\s]+/)) add(tok);
			return;
		}
		const hm = line.match(/^#{3,4}\s+\d+\.\s+(\S+)/);
		if (hm) {
			add(hm[1]);
			return;
		}
		const lm = line.match(/^-\s+`([^`]+)`/);
		if (lm) add(lm[1]);
	});
	return [...files];
};

/**
 * Deterministic plan-time coverage floor: every edit path a phase body NAMES
 * (in `### Changes`/`#### N. path`/`**File**:`) must be DECLARED in that phase's
 * frontmatter `files:` array. An undeclared write is the per-phase attribution
 * gap the dep-gated implement fanout and the lane-level scope floor both need
 * closed upstream — a body edit not in `files:` is invisible to dependency
 * derivation and unattributable under concurrency. PURE: no LLM judgment, never
 * throws (a malformed frontmatter degrades to `[]`). A `files:`-LESS phase
 * (absent key) yields NO findings — empty-set degradation so a legacy/
 * `files:`-less plan never false-fails; a phase that declares `files: []` is
 * checked (every body edit is a gap). Folded into `planCitationCheck(who)` so
 * both the `plan-cite-check` and `code-cite-check` arms emit coverage findings
 * on their shared `dimension: "structure"` verdict — no new stage/channel/route.
 */
const verifyPhaseFilesCoverage = (content: string, who: string, path: string): { detail: string; where: string }[] => {
	let fm: Record<string, unknown>;
	try {
		const { frontmatter } = parseFrontmatter(content);
		fm = frontmatter as Record<string, unknown>;
	} catch {
		return []; // malformed frontmatter → degrade to no findings, never throw
	}
	const phases = Array.isArray(fm.phases) ? fm.phases : [];
	const entryByN = new Map<number, Record<string, unknown>>();
	phases.forEach((entry, idx) => {
		const e = (entry ?? {}) as Record<string, unknown>;
		const n = typeof e.n === "number" ? e.n : idx + 1;
		entryByN.set(n, e);
	});
	const findings: { detail: string; where: string }[] = [];
	for (const [n, body] of phaseBodySlices(content)) {
		const entry = entryByN.get(n);
		if (!entry) continue; // body phase with no matching frontmatter entry — derive-check's concern, not coverage's
		// `files:` key ABSENT → degradation (legacy plan): skip. Present (even `[]`) → check.
		if (!Array.isArray(entry.files)) continue;
		const declared = new Set(phaseFiles(entry));
		for (const editPath of editPathsOfPhase(body)) {
			if (declared.has(editPath)) continue;
			findings.push({
				detail: `Phase ${n} names edit path ${editPath} in its body but does not declare it in its frontmatter 'files:' array. Every path a phase creates or edits must be listed in 'files:' (repo-root-relative, never a bare basename) so the plan-time coverage floor and the dep-gated implement fanout see the phase's full write set. Add ${editPath} to phase ${n}'s 'files:' array, or drop the body reference if the write belongs to another phase.`,
				where: `${who} ${path} phase ${n}: ${editPath}`,
			});
		}
	}
	return findings;
};

/**
 * Deterministic citation floor for a synthesized/spliced plan — the plan-scope
 * twin of `sliceStructureCheck`'s citation backing, extending the citation
 * floor past the slice map to the plan and the code-bearing plan (a fabricated `file:line` in
 * the plan misdirects `implement`). Verifies every
 * citation resolves against the working tree and emits a `{ dimension:
 * "structure" }` verdict on `who`'s channel that the gate route folds via
 * `allDimensionsPass`; the matching `<fix>` stage reads `fanin(who)` so the
 * findings DRIVE the amend rather than blind-halt. Reuses `verifyCitations` — no
 * fuzzy wrong-symbol heuristic. Basename-keyed ⇒ idempotent across fix rounds.
 */
const planCitationCheck =
	(who: string) =>
	({ state, cwd }: ScriptContext): Omit<Output, "meta"> => {
		const latest = latestFsArtifact(state, "plans");
		if (latest?.handle.kind !== "fs") {
			throw haltPreflight(
				who,
				`${who}: no plan to check`,
				`${who}: no fs artifact on the 'plans' channel — the plan must be produced before the citation check`,
			);
		}
		const body = readArtifactFile(latest.handle.path, cwd);
		const findings = verifyCitations(body, cwd);
		// Plan-time coverage floor: a body edit not declared in its phase's `files:`
		// fails structurally, same channel/verdict/route as an unbacked citation.
		findings.push(...verifyPhaseFilesCoverage(body, who, latest.handle.path));
		return writeStructureVerdict(who, latest.handle, findings, cwd);
	};

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
	const pass = findings.length === 0;
	const data = {
		dimension: "scope",
		pass,
		verdict: pass ? "pass" : "fail",
		score: pass ? VERDICT_PASS_SCORE : VERDICT_FAIL_SCORE,
		severity: pass ? "none" : "high",
		artifact: handleToString(latest.handle),
		findings,
		feedback: pass ? "" : findings.map((f) => f.detail).join(" "),
	};
	// Basename-keyed, NOT round-stamped (unlike grade's timestamped slug): each
	// fix-loop round overwrites the file. Deliberate — the route reads the
	// accumulating channel, and on disk only the latest round's scope verdict
	// matters; round-stamp here if a consumer ever needs the history.
	const rel = join(VERDICT_DIR, `implement-scope-check__${basename(latest.handle.path, ".md")}.json`);
	mkdirSync(join(cwd, VERDICT_DIR), { recursive: true });
	writeFileSync(join(cwd, rel), JSON.stringify(data, null, 2), "utf-8");
	return { kind: "json", artifacts: [{ handle: { kind: "fs", path: rel } }], data };
};

/**
 * vet's `implement-scope-check` — the loop-aware scope floor (twin of build's
 * `implementScopeCheck` above). Deterministic (no LLM): the implement lane may
 * write ONLY the paths a plan phase declares in its `files:` set; any other dirty
 * path (not in the run-start baseline, not under `.rpiv/`/`thoughts/`) is excess
 * and halts before `validate`.
 *
 * vet differs from build in ONE place: build's extra `plans` entries are
 * superseding amendments (`plan-fix` re-publishes the whole plan) so build reads
 * latest-only; vet's review-fix loop pushes a DISTINCT non-superseding fix plan
 * per iteration (completing a `produces` stage APPENDS to its named slot, and
 * backward jumps don't reset channels), so this function builds `declared` as the
 * UNION of Phase 1's `phaseFiles` over the FULL `state.named.plans` history — a
 * path a prior iteration's plan legitimately wrote is not excess against the
 * latest plan. The latest plan's handle is used ONLY for the basename-keyed
 * verdict path (idempotent across fix rounds) and the `artifact` field.
 *
 * Otherwise byte-for-byte `implementScopeCheck` above: the baseline via
 * `goalBaselinePath` (satisfied now that vet has a `goal` stage), the dirty set
 * via `git status --porcelain` with explicit `stdio`, the shared `scopeExcess`
 * core + `parseGitStatusPaths`, and the `dimension:"scope"` verdict
 * (carrying BOTH `pass` and `verdict` — the route is the `match("verdict", …)`
 * gate idiom, NOT `allDimensionsPass`, so a fail always halts) written to
 * `VERDICT_DIR`. Non-repo / git-missing ⇒ empty dirty ⇒ pass (never throws).
 * Basename-keyed off the latest plan ⇒ idempotent across review-fix rounds.
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
	const pass = findings.length === 0;
	const data = {
		dimension: "scope",
		pass,
		verdict: pass ? "pass" : "fail",
		score: pass ? VERDICT_PASS_SCORE : VERDICT_FAIL_SCORE,
		severity: pass ? "none" : "high",
		artifact: handleToString(latest.handle),
		findings,
		feedback: pass ? "" : findings.map((f) => f.detail).join(" "),
	};
	// Basename-keyed, NOT round-stamped (unlike grade's timestamped slug): each
	// fix-loop round overwrites the file. Deliberate — the route reads the
	// accumulating channel, and on disk only the latest round's scope verdict
	// matters; round-stamp here if a consumer ever needs the history.
	const rel = join(VERDICT_DIR, `implement-scope-check__${basename(latest.handle.path, ".md")}.json`);
	mkdirSync(join(cwd, VERDICT_DIR), { recursive: true });
	writeFileSync(join(cwd, rel), JSON.stringify(data, null, 2), "utf-8");
	return { kind: "json", artifacts: [{ handle: { kind: "fs", path: rel } }], data };
};

/**
 * One `#### Reconciliation` directive parsed from a plan body: a machine-applicable
 * `find → replace` against a single test-expectation file. The implement lane records
 * these in a phase's OWN section when a correct change invalidates a test that lives
 * in a sibling phase's landed section (which the implementer may NOT edit); `reconcile`
 * applies them write-restricted to `*.test.*` targets.
 */
interface ReconciliationDirective {
	/** Repo-root-relative test target (`*.test.*`). */
	target: string;
	/** Substring to find (replaced exactly once via `String.replace`). */
	find: string;
	/** Replacement string. */
	replace: string;
}

/** Directive grammar: `` - `<target>`: replace `<find>` → `<replace>` — <rationale> ``.
 *  The `→` (U+2192) separates find/replace; the em-dash `—` (U+2014) + rationale is
 *  optional. Find/replace carry no inner backticks. The two spans are intentionally
 *  asymmetric and MUST NOT be symmetrized: `find` is one-or-more `[^`]+` (an empty
 *  find has no anchored target and `String.replace("")` prepends the replacement on
 *  every run, so the parser rejects it at parse time), while `replace` is
 *  zero-or-more `[^`]*` (an empty replace is a legitimate deletion directive). */
const RECONCILE_DIRECTIVE_RE = /^-\s+`([^`]+)`\s*:\s*replace\s+`([^`]+)`\s*→\s*`([^`]*)`\s*(?:—\s+.*)?$/;
/** A directive ATTEMPT — `- `<target>`:` — that does not match the full grammar. Used
 *  to surface a malformed directive as a finding rather than silently dropping it. */
const RECONCILE_DIRECTIVE_ATTEMPT_RE = /^-\s+`[^`]+`\s*:/;

/**
 * Parse every `#### Reconciliation` directive from a plan body. Returns the
 * well-formed directives AND the malformed attempts (lines that carry the
 * `- `<target>`:` shape but not the full `replace … → …` grammar); `reconcile`
 * turns each malformed attempt into a finding so a broken directive is visible,
 * never silently dropped. Prose list items are ignored. Pure: no I/O, no throw.
 * A section opens at a `#### Reconciliation` heading and closes at the next
 * `#{1,4}` heading (so `### Success Criteria` / `## Phase N:` / a sibling
 * `#### Automated Verification:` all end it).
 */
const reconciliationRecords = (
	body: string,
): {
	directives: ReconciliationDirective[];
	malformed: string[];
} => {
	const directives: ReconciliationDirective[] = [];
	const malformed: string[] = [];
	let inSection = false;
	for (const raw of body.split("\n")) {
		const line = raw.trimEnd();
		if (/^####\s+Reconciliation\b/.test(line)) {
			inSection = true;
			continue;
		}
		// Any other heading ends the section (the open-heading branch above `continue`s,
		// so this only fires for non-`#### Reconciliation` headings).
		if (/^#{1,4}\s/.test(line)) {
			inSection = false;
			continue;
		}
		if (!inSection) continue;
		const m = RECONCILE_DIRECTIVE_RE.exec(line);
		if (m) {
			directives.push({ target: m[1]!.trim(), find: m[2]!, replace: m[3]! });
		} else if (RECONCILE_DIRECTIVE_ATTEMPT_RE.test(line)) {
			malformed.push(line.trim());
		}
	}
	return { directives, malformed };
};

const isTestPath = (target: string): boolean => TEST_PATH_RE.test(target);

/**
 * Apply each `#### Reconciliation` directive, write-restricted to test-expectation
 * files (`isTestPath` — reconcile writes ONLY test files; a non-test target is a
 * finding, left untouched, fail-closed). A present `find` is replaced exactly
 * once (`String.replace`, first match); an absent `find` whose `replace` is empty
 * is the idempotent-re-run no-op for a deletion (find-absent is the deletion's
 * success condition — the directive was already applied, no finding, no write); an
 * absent `find` whose non-empty `replace` is ALSO absent is a finding (reconcile
 * does not guess); an absent `find` whose non-empty `replace` is already present is
 * the idempotent-re-run no-op for a substitution (a prior successful apply, no
 * finding, no write). Paths resolve through `cwd` (`isAbsolute` short-circuit else
 * `join(cwd, target)`). Fail-soft: a read/apply throw degrades to a finding naming
 * the target, never a terminal throw. Returns findings in DIRECTIVE order and
 * performs the side-effecting writes itself (`reconcile` spreads the return).
 */
const applyReconciliationDirectives = (
	directives: readonly ReconciliationDirective[],
	cwd: string,
): { detail: string; where: string }[] => {
	const findings: { detail: string; where: string }[] = [];
	// Apply directives, write-restricted to test-expectation files.
	for (const d of directives) {
		if (!isTestPath(d.target)) {
			findings.push({
				detail: `reconcile: directive target ${d.target} is not a test-expectation file (*.test.{ts,tsx,js,jsx}) — reconcile writes only test files; record the directive against a test target or apply the edit in the owning phase`,
				where: d.target,
			});
			continue;
		}
		try {
			const abs = isAbsolute(d.target) ? d.target : join(cwd, d.target);
			const content = readFileSync(abs, "utf-8");
			if (content.includes(d.find)) {
				// `String.replace` with a string pattern replaces the FIRST match exactly once.
				writeFileSync(abs, content.replace(d.find, d.replace), "utf-8");
			} else if (d.replace !== "" && content.includes(d.replace)) {
				// Idempotent re-run: the find is gone but the replacement is present ⇒ the
				// directive was already applied (e.g. a vet review-fix loop re-running
				// reconcile). Treated as satisfied — reconcile must not fail on its own
				// prior successful apply.
			} else if (d.replace === "") {
				// Idempotent re-run of a deletion: the find is gone and the replacement is
				// empty ⇒ find-absent is the deletion's success condition (a prior successful
				// apply removed it). Treated as satisfied — reconcile must not fail on its
				// own prior successful apply (e.g. a validate-fix loop re-running reconcile).
			} else {
				findings.push({
					detail: `reconcile: directive find substring not present in ${d.target} (and the replacement is absent — not already applied) — the expected text to replace is absent; the directive is stale or the test no longer matches`,
					where: d.target,
				});
			}
		} catch (err) {
			findings.push({
				detail: `reconcile: could not apply directive to ${d.target} — ${err instanceof Error ? err.message : String(err)}`,
				where: d.target,
			});
		}
	}
	return findings;
};

/**
 * Deterministic post-implement reconciliation — the coherence backstop the
 * parallel implement lane needs. Sibling phases run concurrently in one tree;
 * each phase's own `#### Automated Verification:` passed in isolation, but a
 * phase's correct change can invalidate a test that lives in a SIBLING phase's
 * landed section (which the implementer may not edit), and the combined tree can
 * break in ways no single phase's checks surface. `reconcile` runs after the
 * scope floor (which proved the write-set) and before `validate`:
 *
 *  1. reads the latest plan (`latestFsArtifact(state, "plans")` — latest-wins);
 *  2. parses every `#### Reconciliation` directive — fail-soft (a malformed
 *     directive / unreadable plan degrades to a finding, never a terminal
 *     `FAIL_SCRIPT_THREW` halt — a `produces.script` that throws becomes one);
 *  3. applies each directive write-restricted to test paths (`isTestPath`); a
 *     present `find` is replaced exactly once (`String.replace`); an absent `find`
 *     whose replacement is ALSO absent is a finding (reconcile does not guess);
 *  4. appends a timestamped `### Reconciliation Log (<iso>)` under the plan's
 *     `## Synthesis Notes` (best-effort bookkeeping write — non-fatal);
 *  5. emits one `{ dimension: "reconcile" }` verdict, basename-keyed off the plan
 *     ⇒ idempotent across fix rounds (the verdict file is overwritten each round).
 *
 * Reconcile deliberately does NOT re-execute the plan's `#### Automated
 * Verification:` commands. That re-run (bare `execFileSync`, no shell, exit-0
 * contract) was measured across the full run history at zero genuine catches and
 * a 100% false-positive finding rate — stale cross-phase presence probes, agent-
 * shell-only binaries (`rg`), prose greps — each halting a finished run at a
 * fail route with no fix arm. The downstream `validate` stage runs the same AV
 * commands as an agent, with a real shell and the judgment to tell a legitimate
 * post-rename mismatch from actual plan-vs-tree drift.
 *
 * The route is the `match("verdict", …, { from: "reconcile" })` gate idiom — pass ⇒
 * validate, fail/missing ⇒ STOP (no fallback), mirroring `implementScopeCheck`.
 * Mirrors `implementScopeCheck`'s `ScriptContext` shape, basename-keyed verdict
 * path, and `dimension`/`pass`/`verdict`/`score`/`severity` data shape. `reads:
 * ["plans"]` only — reconcile consumes no run-start `goal` baseline (the scope
 * floor already proved the write-set; reconcile's own writes are directive targets
 * + the plan bookkeeping). The `from` form suppresses the READS_DATA outputSchema
 * lint, so no schema is declared (matching `slice-check`/`plan-cite-check`/
 * `implement-scope-check`).
 */
const reconcile = ({ state, cwd }: ScriptContext): Omit<Output, "meta"> => {
	const latest = latestFsArtifact(state, "plans");
	if (latest?.handle.kind !== "fs") {
		throw haltPreflight(
			"reconcile",
			"reconcile: no plan to reconcile",
			"reconcile: no fs artifact on the 'plans' channel — implement / scope-check must run before reconcile",
		);
	}
	const planPath = latest.handle.path;
	const planAbs = isAbsolute(planPath) ? planPath : join(cwd, planPath);
	const findings: { detail: string; where: string }[] = [];

	// Fail-soft read + parse: an unreadable plan or malformed directive degrades
	// to a finding, never a terminal throw. If the read fails there is nothing to
	// apply.
	let body = "";
	let directives: ReconciliationDirective[] = [];
	let malformed: string[] = [];
	try {
		body = readArtifactFile(planPath, cwd);
		const parsed = reconciliationRecords(body);
		directives = parsed.directives;
		malformed = parsed.malformed;
	} catch (err) {
		findings.push({
			detail: `reconcile: could not read or parse the plan ${planPath} — ${err instanceof Error ? err.message : String(err)}`,
			where: planPath,
		});
	}
	for (const m of malformed) {
		findings.push({
			detail: `reconcile: malformed Reconciliation directive — expected a line of the form: - \`<target>\`: replace \`<find>\` → \`<replace>\` (target/find/replace each backtick-wrapped) — ${m}`,
			where: "reconciliation-directive",
		});
	}

	findings.push(...applyReconciliationDirectives(directives, cwd));

	// Best-effort bookkeeping: append a timestamped log under ## Synthesis Notes.
	// Non-fatal — a write failure here is silent (the verdict below is the signal).
	if (body) {
		try {
			const stamp = new Date().toISOString();
			const verdict = findings.length === 0 ? "pass" : "fail";
			const logBlock = `\n### Reconciliation Log (${stamp})\nApplied ${directives.length} directive(s); ${findings.length} finding(s); verdict: ${verdict}.\n`;
			const heading = "## Synthesis Notes";
			const idx = body.indexOf(heading);
			let updated: string;
			if (idx >= 0) {
				const lineEnd = body.indexOf("\n", idx);
				const at = lineEnd >= 0 ? lineEnd + 1 : body.length;
				updated = body.slice(0, at) + logBlock + body.slice(at);
			} else {
				updated = `${body.replace(/\s+$/, "")}\n${logBlock}`;
			}
			writeFileSync(planAbs, updated, "utf-8");
		} catch {
			// bookkeeping — ignore
		}
	}

	const pass = findings.length === 0;
	const data = {
		dimension: "reconcile",
		pass,
		verdict: pass ? "pass" : "fail",
		score: pass ? VERDICT_PASS_SCORE : VERDICT_FAIL_SCORE,
		severity: pass ? "none" : "high",
		artifact: handleToString(latest.handle),
		findings,
		feedback: pass ? "" : findings.map((f) => f.detail).join(" "),
	};
	// Basename-keyed off the latest plan ⇒ idempotent across fix rounds (mirrors
	// implementScopeCheck / planCitationCheck, NOT round-stamped like grade).
	const rel = join(VERDICT_DIR, `reconcile__${basename(planPath, ".md")}.json`);
	mkdirSync(join(cwd, VERDICT_DIR), { recursive: true });
	writeFileSync(join(cwd, rel), JSON.stringify(data, null, 2), "utf-8");
	return { kind: "json", artifacts: [{ handle: { kind: "fs", path: rel } }], data };
};

/** A design filename encodes its slice as `…slice-<N>…` — the design-fanout naming convention. */
const DESIGN_SLICE_RE = /slice-(\d+)/;

/**
 * Map slice number → its design artifact path, from the design fanout's published
 * outputs. An identity resolver: it maps an ARTIFACT to a slice NUMBER. It FAILS
 * LOUD only when identity is genuinely UNRESOLVABLE — a design filename that
 * carries no `slice-<N>` token, where a positional `idx + 1` guess would scramble
 * the cluster→design wiring and drop slices.
 *
 * A slice claimed by MORE THAN ONE output is NOT ambiguous: the `designs` channel
 * legitimately accumulates several entries per slice — `slice-design` emits it,
 * then `design-review` re-emits the accepted/edited design on the SAME channel
 * (its documented "latest-wins, same paths" contract, so `subplan`/`synthesize`
 * read the accepted docs). So the newest entry wins, deterministically — throwing
 * on a duplicate would halt every normal run at `subplan`. (The resume re-dispatch
 * that once left CONFLICTING designs on the channel is fixed at its source,
 * so there is no corruption left to fail loud on here.)
 */
const designPathsBySlice = (state: RunView): Map<number, string> => {
	const bySlice = new Map<number, string>();
	for (const out of state.named.designs ?? []) {
		for (const a of out.artifacts) {
			if (a.handle.kind !== "fs") continue;
			const name = basename(a.handle.path);
			const match = DESIGN_SLICE_RE.exec(name);
			if (!match) {
				throw haltPreflight(
					"designPathsBySlice",
					`designPathsBySlice: design ${name} has no slice number`,
					`designPathsBySlice: design artifact ${a.handle.path} carries no 'slice-<N>' token — cannot resolve which slice it designs; a positional guess would mis-route the cluster→design mapping and drop slices`,
				);
			}
			// Latest design per slice wins — the channel holds multiple entries per
			// slice by design (design-review re-emits), and the newest is authoritative.
			bySlice.set(Number(match[1]), handleToString(a.handle));
		}
	}
	return bySlice;
};

/**
 * Fan `subplan` out over slice-DAG clusters. Each unit merges ONE cluster's
 * per-slice designs into a sub-plan (`--as-subplan`), so no single pass holds
 * every design — the context-bounding twin of the flat fan-in `synthesize`.
 */
const SYNTH_CLUSTER_FANOUT = fanout({
	source: "designs",
	unit: { by: "slice-dag-cluster", pattern: "clusters" },
	max: MAX_PHASES,
	units: ({ state, cwd }) => {
		const doc = latestFsArtifact(state, "slices");
		if (doc?.handle.kind !== "fs") return [];
		const records = sliceRecords(readArtifactFile(doc.handle.path, cwd), "SYNTH_CLUSTER_FANOUT", doc.handle.path);
		const designBySlice = designPathsBySlice(state);
		// Thread the research the slices rest on into every cluster's subplan pass,
		// so cross-slice constraints and acceptance criteria reach synthesis DIRECTLY
		// (not only via each design's refraction). `synthesize` accepts `--research`
		// in partial mode; the flat `synthesize` fan-in already received it, but the
		// hierarchical cluster fanout dropped it.
		const research = latestFsArtifact(state, "research");
		const researchFlag = research?.handle.kind === "fs" ? ` --research ${handleToString(research.handle)}` : "";
		return clusterSliceDag(records)
			.map((cluster, i) => {
				const designs = cluster
					.map((n) => designBySlice.get(n))
					.filter((p): p is string => p !== undefined)
					.map((p) => `--designs ${p}`);
				if (!designs.length) return undefined;
				return {
					// Stamp each cluster's ordinal into its prompt so the partial-mode pass
					// writes a distinct `_cluster-<k>.md` — a re-dispatched unit must never
					// reuse a sibling's filename and clobber it. `<k>` matches `id: cluster-<k>`.
					prompt: `${designs.join(" ")}${researchFlag} --cluster ${i + 1} --as-subplan`,
					label: `cluster ${i + 1} (slices ${cluster.join(",")})`,
					id: `cluster-${i + 1}`,
				};
			})
			.filter((u): u is { prompt: string; label: string; id: string } => u !== undefined);
	},
});

/**
 * The two dimensions the grade panels anchor against the verbatim brief.
 * "Complete" and "correct" MEAN "against what the user asked" — without the
 * goal, completeness grades the plan against the plan's own claims. The other
 * dimensions (and the slice gate's `design-readiness`) deliberately stay
 * goal-blind: fit/actionability/pattern-following judge the artifact against
 * the codebase, and an ambient goal at those seams invites scope inflation.
 */
const GOAL_DIMENSIONS: ReadonlySet<string> = new Set(["completeness", "correctness"]);

// ---------------------------------------------------------------------------
// Adaptive gate scaling — tier, roster, verdict freshness.
// ---------------------------------------------------------------------------

/** Latest `data` record published under `name` (undefined when absent/non-record). */
const latestChannelData = (state: RunView, name: string): Record<string, unknown> | undefined => {
	const data = state.named[name]?.at(-1)?.data;
	return data !== null && typeof data === "object" && !Array.isArray(data)
		? (data as Record<string, unknown>)
		: undefined;
};

/** A finite numeric field off the latest `data` on `name` (undefined otherwise). */
const channelNumber = (state: RunView, name: string, field: string): number | undefined => {
	const v = latestChannelData(state, name)?.[field];
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/** Repo-relative path of the latest fs artifact on `name` (undefined if none). */
const latestArtifactPath = (state: RunView, name: string): string | undefined => {
	const a = latestFsArtifact(state, name);
	return a?.handle.kind === "fs" ? handleToString(a.handle) : undefined;
};

/**
 * Gate scrutiny tier, derived ONLY from signals already replayed by the resume
 * fold (the slices/plans channels' frontmatter data and the gate's own verdict
 * severities) — deterministic by construction, so routes and fanout units that
 * consult it stay resume-safe.
 *
 * `risks:` flags are deliberately NOT a tier signal: `synthesize` declares
 * them routinely (observed: 1-phase plans shipping 2-3 flags), so counting
 * them would push every small run out of the light tier. Risk flags are
 * already force-ruled per dimension via `risk_rulings`, and a blocking
 * verdict lifts the tier on its own (below).
 *
 * A missing signal never yields light, and verdict severities are read over
 * the FULL channel history (a stale medium/high is still evidence of a risky
 * run) — ambiguity always resolves toward more scrutiny.
 */
type GateTier = "light" | "standard" | "strict";
const TIER_LIGHT_MAX_SLICES = 1;
const TIER_LIGHT_MAX_PHASES = 2;
const TIER_STRICT_MIN_SLICES = 5;
const TIER_STRICT_MIN_PHASES = 6;

/**
 * The dimensions a light-tier run still grades: correctness and completeness
 * are the two whose failures ship real defects (and the two that anchor on the
 * goal); fit/actionability/pattern-following are low-consequence on a
 * one-slice, <=2-phase diff, and `validate` still runs at every tier.
 */
const LIGHT_ROSTER: ReadonlySet<string> = new Set(["correctness", "completeness"]);

const gateTier = (state: RunView, verdictChannel: string): GateTier => {
	const slices = channelNumber(state, "slices", "slice_count");
	const phases = channelNumber(state, "plans", "phase_count");
	const severities = new Set<string>();
	for (const o of state.named[verdictChannel] ?? []) {
		const v = o.data as { severity?: unknown; findings?: unknown } | undefined;
		const s = v?.severity;
		// Anchor-nit clamp: an all-drift-nit verdict must not escalate the tier.
		if (typeof s === "string") severities.add(anchorNitsOnly(v) ? "low" : s);
	}
	if (
		(slices !== undefined && slices >= TIER_STRICT_MIN_SLICES) ||
		(phases !== undefined && phases >= TIER_STRICT_MIN_PHASES) ||
		severities.has("high")
	) {
		return "strict";
	}
	if (
		slices !== undefined &&
		slices <= TIER_LIGHT_MAX_SLICES &&
		phases !== undefined &&
		phases <= TIER_LIGHT_MAX_PHASES &&
		!severities.has("medium")
	) {
		return "light";
	}
	return "standard";
};

/**
 * The subset of `dimensions` the tier actually grades. Never empty: a
 * dimension list with no light-roster member (the slice gate's lone
 * `design-readiness`) keeps its full list at every tier.
 */
const gateRoster = (tier: GateTier, dimensions: readonly string[]): readonly string[] => {
	if (tier !== "light") return dimensions;
	const light = dimensions.filter((d) => LIGHT_ROSTER.has(d));
	return light.length > 0 ? light : dimensions;
};

/**
 * Drop verdicts judged against an artifact the channel has since REPLACED. A
 * grade verdict embeds the `artifact` path it judged; when a fix REGENERATES
 * the artifact (`slice-fix` re-slices to a NEW file) a passing verdict on the
 * old document must not carry forward to a document that was never judged —
 * the carry-forward would otherwise let a regenerated slice map skip its
 * design-readiness judgment entirely. An in-place `amend` keeps the path, so
 * the plan-fix/code-fix carry-forward is unaffected. A verdict without an
 * `artifact` field (older trails, the deterministic structure checks) is kept:
 * matching is the compat default.
 */
const freshVerdicts = (entries: readonly Output[] = [], currentArtifact?: string): readonly Output[] => {
	if (!currentArtifact) return entries;
	const current = basename(currentArtifact);
	return entries.filter((o) => {
		const a = (o.data as { artifact?: unknown } | undefined)?.artifact;
		return typeof a !== "string" || a.length === 0 || basename(a) === current;
	});
};

/**
 * Latest verdict per dimension off an accumulated verdict channel — the shared
 * fold under `dimensionsToRegrade` (which dimensions still block) and the
 * confirm panels' `--prior` threading (which verdict file the confirming
 * grader must adjudicate).
 */
const latestVerdictPerDimension = (entries: readonly Output[] = []): Map<string, Output> => {
	const latest = new Map<string, Output>();
	for (const o of entries) {
		const dim = (o.data as { dimension?: unknown } | undefined)?.dimension;
		if (typeof dim === "string") latest.set(dim, o);
	}
	return latest;
};

/**
 * Anchor-drift-nit phrasing, two tiers: only phrasings naming drift itself
 * count standalone; the location shapes (off-by-N, "is at line N", "line N is
 * the/a") also match REAL defects ("line 42 is a comment that falsely claims
 * X", "the loop bound is off by one") and count ONLY alongside citing-context
 * vocabulary — every observed drift nit has it, real-defect phrasings don't.
 * Do NOT widen, and do NOT promote a location shape to standalone.
 */
const ANCHOR_NIT_DRIFT_RE = /\bdrifted?\s+~?\d+\s+lines?\b|\bcitation (?:is )?drifted\b/i;
const ANCHOR_NIT_LOCATION_RE =
	/\boff[- ]by[- ](?:one|two|three|\d+)\b|(?::\d+|\bline \d+) is (?:the|a)\b|\bis at line \d+\b/i;
const ANCHOR_NIT_CITE_CONTEXT_RE = /\bcit(?:es?|ed|ation)\b|\banchor/i;

const isAnchorNitDetail = (detail: string): boolean =>
	ANCHOR_NIT_DRIFT_RE.test(detail) || (ANCHOR_NIT_LOCATION_RE.test(detail) && ANCHOR_NIT_CITE_CONTEXT_RE.test(detail));

/**
 * TRUE when a verdict carries ≥1 finding and EVERY finding is an anchor-drift
 * nit (`isAnchorNitDetail`). Such a verdict is severity-clamped to non-blocking
 * at the gate fold regardless of the grader's own `severity` — line-number
 * drift was measured at 34% of all grader findings with zero downstream harm,
 * and a mis-rated all-nit `medium` verdict buys a full fix round + re-grade
 * panel that repairs nothing. A verdict mixing a drift nit with ANY other
 * finding is untouched — the other finding may be the real blocker.
 */
const anchorNitsOnly = (v: { findings?: unknown } | undefined): boolean => {
	const findings = Array.isArray(v?.findings) ? v.findings : [];
	return (
		findings.length > 0 &&
		findings.every((f) => {
			const detail = (f as { detail?: unknown } | undefined)?.detail;
			return typeof detail === "string" && isAnchorNitDetail(detail);
		})
	);
};

/**
 * The subset of `dimensions` a re-grade must actually re-run, given the latest
 * verdict per dimension accumulated so far. A dimension needs re-grading when it
 * has NO prior verdict (first pass ⇒ grade every dimension), when its latest
 * verdict fails above the severity floor, or when that verdict ruled any plan
 * risk flag `fail` (the ruling is re-opened by re-grading its owning dimension).
 * A dimension that already passed — dimension AND its risk rulings — is carried
 * forward untouched: re-running it after a surgical fix only re-rolls a free LLM
 * judgment that flaps pass↔fail on an unchanged artifact, manufacturing extra
 * loops (the observed correctness risk-flag flap). The accumulating verdict
 * channel + `allDimensionsPass`'s latest-per-dimension fold mean a carried
 * dimension's prior passing verdict still counts at the gate.
 */
const dimensionsToRegrade = (
	dimensions: readonly string[],
	latest: ReadonlyMap<string, Output>,
	risks: ReadonlyMap<string, RiskRecord> = new Map(),
): string[] => {
	return dimensions.filter((d) => {
		const o = latest.get(d);
		if (!o) return true; // never graded — must grade at least once
		const v = o.data as { pass?: boolean; severity?: string; findings?: unknown } | undefined;
		const dimPass = v?.pass === true || v?.severity === "low" || v?.severity === "none" || anchorNitsOnly(v);
		if (!dimPass) return true;
		return verdictRiskRulings(o).some((r) => !rulingEffectivePass(r, risks.get(r.id)));
	});
};

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

/**
 * A grade panel: one `grade` session per dimension over the latest artifact on
 * `channel`. Each unit's prompt is the `grade` skill's flags
 * (`--dimension <d> --artifact <path>`); the per-dimension verdicts fold via
 * `allDimensionsPass`. Shared by the slice gate (over `slices`) and the plan +
 * code gates (over `plans`), each on its own `verdictChannel`.
 *
 * The panel grades the tier's ROSTER (`gateTier`/`gateRoster`), over verdicts
 * still FRESH for the current artifact (`freshVerdicts`) — a light run grades
 * two dimensions, a regenerated artifact re-grades from scratch. On a re-grade
 * it emits ONLY the dimensions `dimensionsToRegrade` says still need it (the
 * rest carry their prior passing verdict forward) — but never an EMPTY set: an
 * empty `units()` return falls through to a single dimensionless `grade`
 * dispatch, so when nothing needs re-grading we fall back to the full roster.
 * The route into the stage already skips it entirely when the accumulated
 * verdicts clear the gate (see `plan-cite-check`/`code-cite-check`/`slice-check`
 * edges), so this fallback only fires in the degenerate case where a fix left the
 * cite floor red while every dimension passed.
 *
 * `architecture-fit` is the one dimension `grade` requires a `--context` for: it
 * grades the plan against the research the slices rest on. The build flow always
 * front-loads a `research` stage, so we thread the latest `research` artifact in
 * as `--context` for that dimension only; likewise the latest `goal` artifact
 * threads in as `--goal` for the `GOAL_DIMENSIONS` only. Every other dimension
 * (and the slice gate's `design-readiness`, which never grades fit or
 * goal-completeness) gets the bare flags.
 *
 * A CONFIRM panel (`confirm: true`) additionally threads each still-blocking
 * dimension's latest verdict in as `--prior`: the confirming grader must
 * adjudicate the prior round's findings — uphold or refute each with cited
 * evidence — instead of silently out-voting them (a blind second opinion once
 * rationalized past a checkable fact and its pass overwrote a correct fail at
 * the latest-per-dimension fold). Only PENDING dimensions get the flag: in the
 * degenerate full-roster fallback a carried passing verdict has nothing to
 * adjudicate, and a first grade has no prior at all.
 */
const gradePanelFanout = (
	channel: string,
	dimensions: readonly string[],
	verdictChannel: string,
	{ confirm = false, priorChannel }: { confirm?: boolean; priorChannel?: string } = {},
) =>
	fanout({
		source: channel,
		unit: { by: "dimension-list", pattern: "dimensions" },
		max: dimensions.length,
		units: ({ state, cwd }) => {
			const doc = latestFsArtifact(state, channel);
			if (doc?.handle.kind !== "fs") return [];
			const target = handleToString(doc.handle);
			const research = latestFsArtifact(state, "research");
			const contextFlag = research?.handle.kind === "fs" ? ` --context ${handleToString(research.handle)}` : "";
			const goal = latestFsArtifact(state, "goal");
			const goalFlag = goal?.handle.kind === "fs" ? ` --goal ${handleToString(goal.handle)}` : "";
			const roster = gateRoster(gateTier(state, verdictChannel), dimensions);
			const latest = latestVerdictPerDimension(freshVerdicts(state.named[verdictChannel], target));
			const risks = planAuthoredRisks(state, channel);
			const pending = dimensionsToRegrade(roster, latest, risks);
			// Delta re-grade fallback guard (plan/code gates only — `priorChannel`
			// is unset for the slice gate and both confirm panels). When the snapshot
			// stage published a prior, compare it to the current plan: a SURGICAL
			// amend (touched only sections a failing finding cited, ≤ threshold
			// lines) re-grades only the still-pending dimensions; a NON-surgical
			// amend (broad / out-of-scope / over-threshold / unreadable / unparseable)
			// re-grades the FULL roster — a broad amend may have regressed a passing
			// dimension the carry-forward would otherwise trust. With NO prior
			// (round 1 / first re-grade) the carry-forward applies unchanged. See
			// `isSurgicalFix` for the fail-closed contract.
			const surgical =
				!confirm && priorChannel !== undefined && isSurgicalFix(state, priorChannel, cwd, target, latest, pending);
			const priorPresent = priorChannel !== undefined && priorArtifact(state, priorChannel) !== undefined;
			const priorFlag = (d: string): string => {
				if (!confirm || !pending.includes(d)) return "";
				const handle = latest.get(d)?.artifacts.find((a) => a.handle.kind === "fs")?.handle;
				return handle ? ` --prior ${handleToString(handle)}` : "";
			};
			const carryForward = pending.length > 0 ? pending : roster;
			// A non-surgical result WITH a prior present re-grades the FULL roster;
			// with NO prior the carry-forward applies (never an empty unit set —
			// empty ⇒ single dimensionless grade fall-through).
			const toGrade = surgical ? carryForward : priorPresent ? roster : carryForward;
			return toGrade.map((d) => ({
				prompt: `--dimension ${d} --artifact ${target}${d === "architecture-fit" ? contextFlag : ""}${GOAL_DIMENSIONS.has(d) ? goalFlag : ""}${priorFlag(d)}`,
				label: d,
				id: `${channel}-dim-${d}`,
			}));
		},
	});

const SLICE_DIMENSION_FANOUT = gradePanelFanout("slices", SLICE_DIMENSIONS, "slice-verdicts");
const PLAN_DIMENSION_FANOUT = gradePanelFanout("plans", PLAN_DIMENSIONS, "plan-verdicts", {
	priorChannel: "plan-snapshot",
});
// The post-splice code gate re-grades the SAME `plans` artifact on its own
// `code-verdicts` channel, so its carry-forward reads the code gate's verdicts,
// never the pre-elaborate plan gate's.
const CODE_DIMENSION_FANOUT = gradePanelFanout("plans", PLAN_DIMENSIONS, "code-verdicts", {
	priorChannel: "code-snapshot",
});
// The confirm stages re-run the SAME panel machinery on the SAME verdict
// channel: with the failing dimensions the only ones pending, the panel emits
// exactly the blocking dimensions — one second judgment each, in confirm mode:
// each unit carries the blocking verdict as `--prior`, and the grade skill is
// contract-bound to rule on every prior finding (uphold, or refute with cited
// evidence) so a confirming pass records WHY the fail died instead of silently
// out-voting it at the latest-per-dimension fold.
// Distinct fanout instances (not aliases) so each stage owns its loop object.
const PLAN_CONFIRM_FANOUT = gradePanelFanout("plans", PLAN_DIMENSIONS, "plan-verdicts", { confirm: true });
const CODE_CONFIRM_FANOUT = gradePanelFanout("plans", PLAN_DIMENSIONS, "code-verdicts", { confirm: true });

/**
 * Ship's grade panel — a bespoke `fanout({...})` mirroring `gradePanelFanout`'s
 * body but binding the roster to `SHIP_DIMENSIONS` DIRECTLY (no
 * `gateRoster(gateTier(...))` wrap) and dropping the confirm / `priorChannel`
 * / surgical-fix machinery ship's single-pass grade does not carry. Kept: the
 * `latestFsArtifact` guard (no plan → no units), the dimension-keyed
 * `--context` (architecture-fit only, sourced from the front-loaded `research`
 * artifact), the `--goal` flag for `GOAL_DIMENSIONS` (completeness/
 * correctness), and the `freshVerdicts` / `latestVerdictPerDimension` /
 * `dimensionsToRegrade` carry-forward so a re-grade emits only still-pending
 * dimensions. Tier-independence is structural: the roster never shrinks, so a
 * light run still grades `architecture-fit`.
 */
export const SHIP_DIMENSION_FANOUT = fanout({
	source: "plans",
	unit: { by: "dimension-list", pattern: "dimensions" },
	max: SHIP_DIMENSIONS.length,
	units: ({ state }) => {
		const doc = latestFsArtifact(state, "plans");
		if (doc?.handle.kind !== "fs") return [];
		const target = handleToString(doc.handle);
		const research = latestFsArtifact(state, "research");
		const contextFlag = research?.handle.kind === "fs" ? ` --context ${handleToString(research.handle)}` : "";
		const goal = latestFsArtifact(state, "goal");
		const goalFlag = goal?.handle.kind === "fs" ? ` --goal ${handleToString(goal.handle)}` : "";
		// Tier-independent roster: SHIP_DIMENSIONS verbatim — never gateRoster(gateTier(...)).
		const roster = SHIP_DIMENSIONS;
		const latest = latestVerdictPerDimension(freshVerdicts(state.named["ship-verdicts"], target));
		const risks = planAuthoredRisks(state, "plans");
		const pending = dimensionsToRegrade(roster, latest, risks);
		const carryForward = pending.length > 0 ? pending : roster;
		return carryForward.map((d) => ({
			prompt: `--dimension ${d} --artifact ${target}${d === "architecture-fit" ? contextFlag : ""}${GOAL_DIMENSIONS.has(d) ? goalFlag : ""}`,
			label: d,
			id: `plans-dim-${d}`,
		}));
	},
});

/**
 * Fold the per-dimension verdicts into a gate decision: keep the latest verdict
 * per dimension (verdicts accumulate across fix loops), require all-pass.
 * Deterministic ⇒ resume-safe for a `readsData: false` route.
 *
 * Severity floor: a verdict whose worst finding is `low`/`none` never blocks the
 * gate, even when the grader set `pass: false` on a nit. `grade` decides `pass`
 * by a free judgment against a prose bar (independent of `severity`), so a
 * marginal dimension can flip pass↔fail across rounds on an unchanged artifact —
 * that flapping, ANDed over a 5-dimension panel, stalled the build gate loops
 * until the backward-jump guard halted them. Flooring on severity reserves a hard
 * fail for `medium`+ findings (the deterministic `slice-check` check emits
 * `high` on a real structural break, so it still blocks). A verdict with no
 * `severity` (an older or replayed grade) falls back to the raw `pass` boolean.
 */
const allDimensionsPass = (entries: readonly Output[] = [], roster?: readonly string[]): boolean => {
	// Roster-filtered when given: a verdict for a dimension outside the tier's
	// roster (a wider earlier round, a shrunk re-slice) neither blocks nor passes
	// a gate it no longer governs.
	const member = roster ? new Set(roster) : undefined;
	const latest = new Map<string, boolean>();
	for (const o of entries) {
		const v = o.data as { dimension?: string; pass?: boolean; severity?: string; findings?: unknown } | undefined;
		if (typeof v?.dimension !== "string") continue;
		if (member && !member.has(v.dimension)) continue;
		// The anchor-nit clamp: an all-drift-nit verdict never blocks, whatever
		// severity the grader typed (backstop for the citation-resolution rule).
		const lowOrNone = v.severity === "low" || v.severity === "none" || anchorNitsOnly(v);
		latest.set(v.dimension, v.pass === true || lowOrNone);
	}
	const verdicts = [...latest.values()];
	return verdicts.length > 0 && verdicts.every(Boolean);
};

/**
 * One plan-authored risk flag ruled by a grade panel. The plan declares a
 * `risks:` frontmatter array (`{ id, claim }`) — the structured, first-class
 * channel that replaces the old prose-in-a-Notes-section flagging that graders
 * were free to skip. Each grade verdict that engages a flag emits a ruling here.
 */
interface RiskRuling {
	id: string;
	pass: boolean;
	/**
	 * `mechanics` marks a risk whose `pass` asserts a verified mechanism (a
	 * behavior that holds because code was checked), so a passing ruling MUST
	 * cite the checked `file:line` in `evidence` — an un-evidenced mechanics
	 * pass demotes. Absent on
	 * an ordinary risk ⇒ no evidence duty.
	 */
	claim_type?: string;
	/** The `file:line`-shaped citation a mechanics pass must ground itself on. */
	evidence?: string;
	/**
	 * `verify-at-implement` marks a risk the panel defers: ruled `pass` ONLY when
	 * a concrete `procedure` + `owner` phase will re-check it at implement/validate
	 * time. Absent ⇒ the risk is judged in this panel, not deferred.
	 */
	disposition?: string;
	/** Named command/test the owner phase runs to discharge a deferred risk. */
	procedure?: string;
	/** The phase (`n`) that owns the deferred verify step. */
	owner?: number;
}

/** The `risk_rulings` a grade verdict emitted (empty when it ruled on none). */
const verdictRiskRulings = (o: Output): RiskRuling[] => {
	const raw = (o.data as { risk_rulings?: unknown } | undefined)?.risk_rulings;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((e) => {
		const r = (e ?? {}) as Record<string, unknown>;
		if (typeof r.id !== "string") return [];
		// Read the duty fields defensively (same typeof-guard idiom as id/pass):
		// absent on an older/ordinary verdict ⇒ undefined ⇒ the duty helpers no-op.
		const claim_type = typeof r.claim_type === "string" ? r.claim_type : undefined;
		const evidence = typeof r.evidence === "string" ? r.evidence : undefined;
		const disposition = typeof r.disposition === "string" ? r.disposition : undefined;
		const procedure = typeof r.procedure === "string" ? r.procedure : undefined;
		const owner = typeof r.owner === "number" ? r.owner : undefined;
		return [
			{
				id: r.id,
				pass: r.pass === true,
				...(claim_type !== undefined ? { claim_type } : {}),
				...(evidence !== undefined ? { evidence } : {}),
				...(disposition !== undefined ? { disposition } : {}),
				...(procedure !== undefined ? { procedure } : {}),
				...(owner !== undefined ? { owner } : {}),
			},
		];
	});
};

/**
 * A plan-authored risk flag — the duty shape `synthesize` declares in the plan
 * frontmatter `risks:` array (`synthesize/SKILL.md:136`: `{ id, claim,
 * claim_type?, disposition?, procedure?, owner? }`). The prose `claim` is grading
 * copy, not a duty signal, so it is not carried here. `claim_type: "mechanics"`
 * and `disposition: "verify-at-implement"` are the two duty TRIGGERS — sourced
 * from the PLAN (not the ruling) so a panel cannot drop its discharge obligation
 * by simply omitting the field from its ruling (the dropped-duty bypass).
 */
interface RiskRecord {
	id: string;
	claim_type?: string;
	disposition?: string;
	procedure?: string;
	owner?: number;
}

/**
 * Read the plan-authored risk flags off the latest record on `channel`, keyed
 * by `id`. The duty triggers live HERE (the plan's `risks:` frontmatter), not on
 * the grade panel's ruling, so a ruling that drops its discharge field cannot
 * escape the duty the plan declared (a bare `{ id, pass }` ruling against a
 * plan-authored `claim_type: "mechanics"` risk still demotes). Reads only
 * `state.named[channel]` via `latestChannelData` — no `readFileSync`, no
 * `cwd`, no throw — so the route's `readsData: false` / determinism /
 * resume-safety contract holds and a resumed run re-evaluates identically.
 * Degrades to an empty map (fail-open ⇒ no duty ⇒ plain ruling ⇒
 * `rulingEffectivePass(r) === r.pass`) when `risks:` is absent/non-array/
 * malformed, mirroring `latestChannelData`'s degrade-to-undefined contract.
 */
const planAuthoredRisks = (state: RunView, channel: string): Map<string, RiskRecord> => {
	const risks = latestChannelData(state, channel)?.risks;
	const out = new Map<string, RiskRecord>();
	if (!Array.isArray(risks)) return out;
	for (const e of risks) {
		const r = (e ?? {}) as Record<string, unknown>;
		if (typeof r.id !== "string") continue;
		const claim_type = typeof r.claim_type === "string" ? r.claim_type : undefined;
		const disposition = typeof r.disposition === "string" ? r.disposition : undefined;
		const procedure = typeof r.procedure === "string" ? r.procedure : undefined;
		const owner = typeof r.owner === "number" ? r.owner : undefined;
		const rec: RiskRecord = { id: r.id };
		if (claim_type !== undefined) rec.claim_type = claim_type;
		if (disposition !== undefined) rec.disposition = disposition;
		if (procedure !== undefined) rec.procedure = procedure;
		if (owner !== undefined) rec.owner = owner;
		out.set(r.id, rec);
	}
	return out;
};

/**
 * A mechanics-pass ruling's evidence duty: when the plan AUTHORED a
 * `claim_type: "mechanics"` risk for the ruling's id, a `pass` ruling MUST
 * cite the checked `file:line` in `evidence` (forces engagement — a pass with
 * no evidence is an unverified mechanism). The trigger is sourced from the
 * plan-authored `RiskRecord`, NOT the ruling — so a panel cannot drop the
 * evidence duty by omitting `claim_type` from its ruling (the dropped-duty
 * bypass). Reuses `FILE_LINE_CITATION_RE` via `.match()` — NOT `.test()`: the
 * regex carries the `/g` flag, so `.test()` is stateful across calls
 * (`lastIndex` advances) and would
 * intermittently miss a present citation. An id with no authored mechanics
 * risk carries no evidence duty ⇒ returns `true`.
 */
const evidenceCitesFileLine = (r: RiskRuling, authored?: RiskRecord): boolean => {
	if (authored?.claim_type !== "mechanics") return true;
	return typeof r.evidence === "string" && r.evidence.match(FILE_LINE_CITATION_RE) !== null;
};

/**
 * A deferred-risk's verify-at-implement duty: when the plan AUTHORED a
 * `disposition: "verify-at-implement"` risk for the ruling's id, a `pass`
 * ruling MUST carry a concrete `procedure` (the named command/test the owner
 * phase runs) AND a numeric `owner` phase — a bare "verify later" with no
 * procedure demotes. The trigger is sourced from the plan-authored
 * `RiskRecord`, NOT the ruling (the dropped-duty bypass). An id with no
 * authored verify-at-implement risk is judged in THIS panel, not deferred ⇒
 * returns `true`.
 */
const procedureSatisfiesDuty = (r: RiskRuling, authored?: RiskRecord): boolean => {
	if (authored?.disposition !== "verify-at-implement") return true;
	return typeof r.procedure === "string" && r.procedure.length > 0 && typeof r.owner === "number";
};

/**
 * The single gate-fold authority: a ruling is effective-pass iff it is a bare
 * `pass` AND (when the plan authored a mechanics risk for its id) its evidence
 * cites a `file:line` AND (when the plan authored a verify-at-implement risk
 * for its id) its procedure+owner discharge the verify duty. `allRiskFlagsPass`,
 * `dimensionsToRegrade` clause 3, and `confirmDue`'s `riskFail` ALL consult this
 * — so the three risk folds agree on what "passing" means and a demoted
 * mechanics/deferred pass blocks the gate AND re-opens its owning dimension
 * AND counts as blocking for confirm (no incoherent re-grading). For a ruling
 * whose id the plan authored no duty for (no mechanics/verify-at-implement
 * risk, no `risks:` at all, or no matching id) every duty no-ops, so
 * `rulingEffectivePass(r, authored) === r.pass` — prior behavior is preserved.
 */
const rulingEffectivePass = (r: RiskRuling, authored?: RiskRecord): boolean =>
	r.pass === true && evidenceCitesFileLine(r, authored) && procedureSatisfiesDuty(r, authored);

/**
 * Fold the grade panel's per-flag risk rulings into a gate decision: every
 * plan-authored risk flag the panel ruled on must be ruled PASS (latest ruling
 * per flag wins, mirroring `allDimensionsPass`). A flag ruled `fail` — the
 * grader confirmed the risk is real and unaddressed — blocks the gate, so a
 * self-flagged risk (e.g. an override-vs-env validation mismatch) can no longer
 * ride a green conformance pass into commit. An empty panel (no flag engaged)
 * imposes no constraint; the plan simply declared no risks.
 */
const allRiskFlagsPass = (
	entries: readonly Output[] = [],
	risks: ReadonlyMap<string, RiskRecord> = new Map(),
): boolean => {
	const latest = new Map<string, boolean>();
	for (const o of entries)
		for (const r of verdictRiskRulings(o)) latest.set(r.id, rulingEffectivePass(r, risks.get(r.id)));
	return [...latest.values()].every(Boolean);
};

/**
 * The three gates' pass predicates — the SINGLE authority each gate consults at
 * BOTH of its seams. A gate is satisfied when its deterministic cite/structure
 * floor is green AND every quality dimension passes (severity-floored) AND — for
 * the plan/code gates — every plan-authored risk flag is ruled pass.
 *
 * Reading the identical predicate at the cite/structure-check edge (which SKIPS
 * the re-grade straight to the next stage) and at the grade edge (which gates
 * forward-vs-fix) makes the skip provably equivalent to "re-grade, then pass",
 * minus the wasted panel: after a fix that only cleared the deterministic floor,
 * the accumulated verdicts already clear the gate, so re-running the LLM panel
 * would at best reproduce them and at worst flap a passing dimension into a
 * spurious fix loop. On the FIRST pass the verdict channel is empty, so
 * `allDimensionsPass` returns false and the edge correctly routes INTO the grade
 * panel. Any regression a fix introduces is still caught downstream: the plan
 * gate by the full first-time `code-grade`, the code gate by `validate`.
 */
// Each predicate folds the verdicts still FRESH for the channel's current
// artifact, restricted to the tier's roster — the SAME projections the panel's
// `units()` uses, so "skip the re-grade" stays provably equivalent to
// "re-grade, then pass". The deterministic cite/structure channels fold
// unfiltered: they re-run every round and carry no tier.
// The latest structure verdict carries a `citeDischarged` stamp for the
// CURRENT slice map. After a fix for a `remedy: "cite"` fail, the failing
// design-readiness verdict is stale (the fix re-sliced to a NEW file) and the
// gate's lone dimension has no fresh verdict, so the verdict fold can never
// pass — yet the fix is deterministically verifiable: `sliceStructureCheck`
// stamps the map basename it verified (demanded seeds present + shape
// unchanged, see `citeRemedyDischarged`). Honoring the stamp only for the
// current map means it can never carry across a later re-slice.
const citeDischargeCoversCurrentMap = (state: RunView): boolean => {
	const stamp = (state.named["slice-check"]?.at(-1)?.data as { citeDischarged?: unknown } | undefined)?.citeDischarged;
	const current = latestArtifactPath(state, "slices");
	return typeof stamp === "string" && current !== undefined && stamp === basename(current);
};
const sliceGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["slice-verdicts"], latestArtifactPath(state, "slices"));
	const roster = gateRoster(gateTier(state, "slice-verdicts"), SLICE_DIMENSIONS);
	if (!allDimensionsPass(state.named["slice-check"])) return false;
	return allDimensionsPass(fresh, roster) || citeDischargeCoversCurrentMap(state);
};
// The single authority the new `subplan-check` edge consults — the twin of
// `sliceGatePasses`, but carrying no LLM-verdict roster or risk flags: the
// `subplan-check` floor is the sole (deterministic) dimension on its channel.
const subplanGatePasses = (state: RunView): boolean => allDimensionsPass(state.named["subplan-check"]);
const planGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["plan-verdicts"], latestArtifactPath(state, "plans"));
	const roster = gateRoster(gateTier(state, "plan-verdicts"), PLAN_DIMENSIONS);
	const risks = planAuthoredRisks(state, "plans");
	return (
		allDimensionsPass(state.named["plan-cite-check"]) &&
		allDimensionsPass(fresh, roster) &&
		allRiskFlagsPass(fresh, risks)
	);
};
const codeGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["code-verdicts"], latestArtifactPath(state, "plans"));
	const roster = gateRoster(gateTier(state, "code-verdicts"), PLAN_DIMENSIONS);
	const risks = planAuthoredRisks(state, "plans");
	return (
		allDimensionsPass(state.named["code-cite-check"]) &&
		allDimensionsPass(fresh, roster) &&
		allRiskFlagsPass(fresh, risks)
	);
};

/**
 * Ship's grade gate — the tier-independent fold over `SHIP_DIMENSIONS` reading
 * the `ship-verdicts` channel. Satisfied when every ship dimension passes
 * (severity-floored) AND every plan-authored risk flag is ruled pass. Unlike
 * `planGatePasses`/`codeGatePasses` it folds NO deterministic cite channel —
 * ship's `plan-cite-check` gate is routed at its own edge — and binds the
 * roster to `SHIP_DIMENSIONS` verbatim (never `gateRoster(gateTier(...))`), so
 * the gate consults the same fixed set the panel graded.
 */
export const shipGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["ship-verdicts"], latestArtifactPath(state, "plans"));
	const risks = planAuthoredRisks(state, "plans");
	return allDimensionsPass(fresh, SHIP_DIMENSIONS) && allRiskFlagsPass(fresh, risks);
};

/**
 * Confirm-before-block: a dimension's FIRST blocking verdict against the
 * current artifact gets ONE independent second judgment before it buys a fix
 * round. Single-judge verdicts observably flap (pass/score/severity disagree
 * across rolls on a near-unchanged artifact), and a spurious block
 * manufactures an entire grade→fix cycle. Routing to the confirm stage
 * re-runs only the pending dimensions on the same verdict channel;
 * latest-per-dimension wins, so a confirming pass clears the gate and a
 * confirming fail routes to the fix with two agreeing judgments behind it. A
 * blocker already judged twice for this artifact routes straight to the fix —
 * confirmation is one extra opinion, not an unbounded re-roll.
 *
 * No tier guard is needed: a blocking verdict is medium+ by the severity
 * floor, and a medium+ severity already lifts `gateTier` out of light — every
 * run with a genuine blocker has confirm-level scrutiny by construction.
 */
const confirmDue = (
	state: RunView,
	channel: string,
	verdictChannel: string,
	dimensions: readonly string[],
): boolean => {
	const roster = new Set(gateRoster(gateTier(state, verdictChannel), dimensions));
	const fresh = freshVerdicts(state.named[verdictChannel], latestArtifactPath(state, channel));
	const risks = planAuthoredRisks(state, channel);
	const byDim = new Map<string, { blocking: boolean; count: number }>();
	for (const o of fresh) {
		const v = o.data as { dimension?: string; pass?: boolean; severity?: string; findings?: unknown } | undefined;
		if (typeof v?.dimension !== "string" || !roster.has(v.dimension)) continue;
		// anchorNitsOnly keeps this floor coherent with the other three
		// severity-fold consumers (gateTier/dimensionsToRegrade/allDimensionsPass).
		const floored = v.pass === true || v.severity === "low" || v.severity === "none" || anchorNitsOnly(v);
		const riskFail = verdictRiskRulings(o).some((r) => !rulingEffectivePass(r, risks.get(r.id)));
		byDim.set(v.dimension, {
			blocking: !floored || riskFail,
			count: (byDim.get(v.dimension)?.count ?? 0) + 1,
		});
	}
	const blockers = [...byDim.values()].filter((e) => e.blocking);
	return blockers.length > 0 && blockers.some((e) => e.count < 2);
};

/**
 * Verdict channels — grade writes JSON to `.rpiv/artifacts/verdicts/`, so these
 * use the JSON directory collector + `jsonBodyParser` (NOT the md
 * `rpivBucketOutcome`). The slice gate and plan gate publish to DISTINCT named
 * channels (same dir, different artifact basenames) so their verdicts never
 * collide and `plan-fix`/`code-fix` can pick each via the `-verdicts` suffix convention.
 */
const verdictOutcome = (name: string) => ({
	name,
	collector: directoryPathCollector({ dir: ".rpiv/artifacts/verdicts", ext: "json" }),
	parser: jsonBodyParser,
});
const sliceVerdictOutcome = verdictOutcome("slice-verdicts");
const planVerdictOutcome = verdictOutcome("plan-verdicts");
// The post-splice code gate re-grades the now code-bearing plan on its own
// channel, so its verdicts never mix with the pre-elaborate plan gate's. Named
// for the object under judgment — the code the gate grades — completing the
// slice-verdicts / plan-verdicts / code-verdicts parallel.
const codeVerdictOutcome = verdictOutcome("code-verdicts");

// Ship's grade panel writes its verdicts to a DISTINCT channel (same
// directory, different artifact basenames) so they never mix with build's
// plan/code verdicts — named for the workflow, completing the slice-verdicts
// / plan-verdicts / code-verdicts / ship-verdicts parallel.
export const shipVerdictOutcome = verdictOutcome("ship-verdicts");

/**
 * Absolute path to rpiv-pi's bundled deterministic stitch script. Resolved off
 * this module's own URL so it points inside the installed package at runtime
 * (built-in-workflows lives in extensions/rpiv-core; the script in skills/_shared).
 */
const STITCH_SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"skills",
	"_shared",
	"stitch-elaborations.mjs",
);

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
 */
const VALIDATE_GOAL_PROMPT: PromptFn = ({ state }) => {
	const parts = ["/skill:validate"];
	const plan = latestFsArtifact(state, "plans");
	if (plan?.handle.kind === "fs") parts.push(handleToString(plan.handle));
	const goal = latestFsArtifact(state, "goal");
	if (goal?.handle.kind === "fs") parts.push(`--goal ${handleToString(goal.handle)}`);
	const baseline = goalBaselinePath(state);
	if (baseline) parts.push(`--baseline ${baseline}`);
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

// ===========================================================================
// vet — goal → code-review → (blueprint → implement → implement-scope-check
//       → validate → loop) | commit. Examine existing changes; capture the
//       brief as a goal artifact, review, and if not approved blueprint a fix
//       plan, implement it, scope-check it, validate, and re-review. Loops
//       until approved. NOTE: defined here (after captureGoal /
//       implementScopeCheckVet) rather than beside polish because its graph
//       references those later-declared `const`s — the same precedent
//       buildWorkflow follows (defined after its deps).
// ===========================================================================

const vetWorkflow = defineWorkflow({
	name: "vet",
	description:
		"Examine existing changes for approval; loop a fix cycle if not approved. Best when a diff already exists (yours or a teammate's) and you want a structured review with optional repair. Chain: goal → code-review → (blueprint → implement → implement-scope-check → reconcile → validate → loop) → commit.",
	start: "goal",
	stages: {
		// Capture the user's brief verbatim on its own `goal` channel, and snapshot
		// the run-start pre-existing-dirty paths (role "baseline"). Reuses build's
		// `captureGoal` verbatim — no new function — so the scope-check's
		// `reads: ["plans", "goal"]` resolves a baseline to subtract and the goal md
		// rides the channel face. `goal` as start publishes the goal-md as
		// `artifacts[0]`; `code-review` is a plain `produces()` SKILL stage (skill
		// defaults to its stage key "code-review"), so it inherits that goal-md PATH
		// as its rolling primary — the same pattern polish's code-review uses,
		// and the fallback Risk r1's note conceded "likely tolerates a goal-md-path
		// arg." The goal-md's CONTENT is the brief (`captureGoal` writes
		// `state.originalInput` into it), so the skill still reaches it.
		//
		// NOTE: the plan's r1 resolution made code-review PROMPT-dispatched to
		// preserve `state.originalInput` byte-for-byte, but that is REVERSED here: a
		// prompt stage carries NO skill, so the `code-review` contract no longer
		// attaches its `outputSchema` and the `blockers_count` gate would read
		// UNVALIDATED data (NaN-route risk, not just a warning). Keeping it a skill
		// stage keeps `skill="code-review"` → contract schema attaches → validated.
		goal: produces.script({ run: captureGoal }),
		"code-review": produces(),
		blueprint: produces(),
		// Dep-gated DAG variant: implement phases now
		// carry `id: phase-<n>` + `deps` derived from each phase's `files:` overlap /
		// authored `depends_on`, so the host cap may fan them out in parallel.
		implement: acts({ loop: IMPLEMENT_DAG_FANOUT, reads: ["plans"] }),
		// Deterministic scope floor (no LLM): the lane may write ONLY the union of
		// every plan iteration's declared `files:` (vet's loop pushes DISTINCT
		// non-superseding fix plans, so the declared set is the UNION over the full
		// `plans` history — `implementScopeCheckVet`). The `from` form suppresses
		// the READS_DATA outputSchema lint, so no schema is declared, matching
		// `slice-check`/`plan-cite-check`. Pass → validate; fail/missing → STOP
		// (no fallback), mirroring build's `validate → commit` route.
		"implement-scope-check": produces.script({ reads: ["plans", "goal"], run: implementScopeCheckVet }),
		// Deterministic post-implement reconciliation (no LLM) — the SAME `reconcile`
		// run-function as build (no vet twin): applies every `#### Reconciliation`
		// directive (write-restricted to test files) + re-runs every per-phase
		// `#### Automated Verification:` command, fail-soft. Pass ⇒ validate; fail/
		// missing ⇒ STOP (no fallback). `reads: ["plans"]` only — no run-start goal
		// baseline. The `from` form suppresses the READS_DATA outputSchema lint.
		reconcile: produces.script({ reads: ["plans"], run: reconcile }),
		validate: produces(),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
		goal: "code-review",
		// Same numeric gate as polish: zero remaining blockers → commit;
		// any blockers → loop a fix pass through blueprint. The `blockers_count`
		// field is sourced + validated from the code-review contract.
		"code-review": gate("blockers_count", { blueprint: gt(0), commit: eq(0) }, "commit"),
		blueprint: "implement",
		// Scope-check inserts BEFORE validate, INSIDE the review-fix loop. Pass →
		// validate; fail/missing terminates (STOP, no fallback). Byte-for-byte
		// build's route.
		implement: "implement-scope-check",
		// Scope-check still gates onward, but now into `reconcile` (not validate):
		// the coherence backstop runs after the write-set is proven. Pass ⇒
		// reconcile; fail/missing ⇒ STOP (no fallback).
		"implement-scope-check": match("verdict", { reconcile: "pass" }, { from: "implement-scope-check" }),
		// Reconciliation gate. Pass ⇒ validate; a `fail` (non-test directive target /
		// absent find / failed AV command) or a missing verdict ⇒ STOP (no fix arm —
		// a reconciliation failure is plan-vs-tree drift the agent reconciles manually).
		reconcile: match("verdict", { validate: "pass" }, { from: "reconcile" }),
		// Backward edge: validate → code-review creates the review-fix loop —
		// UNCHANGED. The scope-check inserts before validate, so a failing scope
		// verdict halts before re-review, and a passing one flows into validate and
		// back to code-review exactly as today. Bounded by the runner's default
		// maxBackwardJumps (3 → at most 4 review iterations).
		validate: "code-review",
		commit: "stop",
	},
});

const buildWorkflow = defineWorkflow({
	name: "build",
	description:
		"Ship, sliced: capture the verbatim brief as a goal artifact (the north star the quality gates' completeness/correctness dimensions and validate anchor against) → research the brief → decompose it into vertical slices → two-phase slice gate (a deterministic floor — dependency-cycle freedom + brief-coverage conservation so a slice-fix can't pass by dropping scope — then one LLM design-readiness judgment that each slice is chewable by a single design pass) with a slice-fix loop → design each slice in parallel → one consolidated developer checkpoint (accept or adjust the proposed interfaces/data types, adjustments applied surgically and cascaded to dependents) → synthesize hierarchically (per-cluster sub-plans → one merged plan) → tier-scaled quality-panel gate (a one-slice, <=2-phase run grades correctness+completeness only; larger or previously-failing runs grade the full completeness/correctness/actionability/pattern-following/architecture-fit roster) where a dimension's first blocking verdict gets one confirming second judgment before it buys a plan-fix round → elaborate code per phase in parallel → splice it into the plan → re-grade the code-bearing plan (same tier + confirm contract) → implement → implement-scope-check → reconcile → validate → commit. Research-led; three automated gates plus one human design checkpoint, before design, before code, and after the splice.",
	start: "goal",
	stages: {
		// The user's brief, verbatim, on its own channel — the judgment seams
		// (plan/code gates' completeness+correctness, validate) anchor against
		// it. Deliberately NOT fed to the generative stages (slice, design-slice):
		// bounded per-slice context is build's whole point, and an ambient goal
		// there invites re-litigating settled decompositions.
		goal: produces.script({ run: captureGoal }),
		// Front-loaded research grounds every slice's footing and feeds the plan
		// gate's architecture-fit dimension its --context. Prompt-dispatched so it
		// still receives the raw brief now that `goal` holds the start slot.
		research: produces({ prompt: RESEARCH_BRIEF_PROMPT }),
		slice: produces(),
		// Deterministic floor (no LLM): dependency-cycle freedom + brief-coverage conservation.
		"slice-check": produces.script({ reads: ["slices"], run: sliceStructureCheck }),
		// One LLM design-readiness judgment; verdicts on their own channel.
		"slice-grade": produces({
			skill: "grade",
			loop: SLICE_DIMENSION_FANOUT,
			outcome: sliceVerdictOutcome,
			reads: ["slices"],
		}),
		// Re-cut the slice map from the failing verdicts. Routes through `slice`
		// (re-slice mode), NOT the surgical `amend`: a `design-readiness` or structural
		// failure needs STRUCTURAL authority — split an epic, break a cycle, renumber —
		// which a surgical "touch only the cited line" edit cannot do, so `amend`
		// looped without converging until the backward-jump guard halted the run.
		"slice-fix": produces({
			skill: "slice",
			outcome: rpivBucketOutcome("slices"),
			reads: ["slices", fanin("slice-verdicts"), fanin("slice-check")],
		}),
		// Design every slice in parallel.
		"slice-design": produces({ skill: "design-slice", loop: SLICE_DESIGN_FANOUT }),
		// One consolidated developer checkpoint over EVERY per-slice design, at the
		// single fan-in seam where they all exist and nothing parallel is running.
		// Presents the proposed shape (interfaces, data types, scope) and lets the
		// developer accept or adjust; an adjustment is applied surgically in place
		// and cascaded to the changed contract's dependents BEFORE synthesis sees
		// the designs. Re-emits designs on their channel (latest-wins, same paths),
		// so `subplan`/`synthesize` read the accepted/edited docs. The interactive
		// counterpart to the LLM gates — the one human pass on the parallel path.
		"design-review": produces({
			skill: "design-review",
			outcome: rpivBucketOutcome("designs"),
			reads: [fanin("designs"), "slices"],
		}),
		// Hierarchical fan-in: merge each slice-DAG cluster into a sub-plan in
		// parallel (bounded context), then merge the sub-plans into one plan.
		subplan: produces({
			skill: "synthesize",
			loop: SYNTH_CLUSTER_FANOUT,
			outcome: rpivBucketOutcome("subplans"),
		}),
		// Deterministic cluster-coverage floor between the cluster fanout and the
		// root merge — the subplan twin of `slice-check`. Reconciles dispatched
		// `_cluster-<k>` sub-plans against the slice map's promised cluster count +
		// `sources:` design coverage BEFORE the root merge fans them in, so a lost
		// or clobbered cluster fails structurally and routes back to `subplan`
		// rather than silently dropping slices from the merged plan.
		"subplan-check": produces.script({ reads: [fanin("subplans"), "slices"], run: subplanCoverageCheck }),
		// The root merge reads `research` (threaded as `--research` so cross-slice
		// constraints reach the merge directly, not only via each subplan's
		// refraction) alongside the cluster sub-plans it fans in.
		plan: produces({ skill: "synthesize", reads: ["research", fanin("subplans")] }),
		// Deterministic citation floor BEFORE the LLM plan gate (twin of `slice-check`):
		// a fabricated `file:line` in the plan fails structurally and routes to `plan-fix`.
		"plan-cite-check": produces.script({ reads: ["plans"], run: planCitationCheck("plan-cite-check") }),
		// Quality gate over the plan; verdicts on their own channel.
		"plan-grade": produces({
			skill: "grade",
			loop: PLAN_DIMENSION_FANOUT,
			outcome: planVerdictOutcome,
			// `research` is read so the architecture-fit unit can thread it as
			// --context; `goal` so completeness/correctness anchor on the brief.
			reads: ["plans", "research", "goal"],
		}),
		// Stamp the duty demotion onto the graded verdicts as legible on-disk data
		// (a `risk_duty_demotions` array written in place onto each demoted
		// verdict JSON) one hop BEFORE the gate routes — the gate's route lives on
		// `plan-demote` so this write-back lands before confirm/`--prior`/amend
		// read the verdict. Reads `plans` (the plan-authored risk flags) and fans
		// in the verdicts it just graded. Gate outcomes are unchanged: every fold
		// consults in-memory `state.named` via `rulingEffectivePass`, never the
		// rewritten file (the write-back is an additive, read-only signal).
		"plan-demote": produces.script({ reads: ["plans", fanin("plan-verdicts")], run: planDemote }),
		// One independent second judgment on the blocking dimensions before they
		// buy a fix round (see `confirmDue`). Same panel machinery, same verdict
		// channel — its OWN stage name so a stronger judge model can be pinned to
		// exactly the verdicts about to block (models.json `stages["plan-confirm"]`).
		"plan-confirm": produces({
			skill: "grade",
			loop: PLAN_CONFIRM_FANOUT,
			outcome: planVerdictOutcome,
			reads: ["plans", "research", "goal"],
		}),
		"plan-fix": produces({
			skill: "amend",
			outcome: rpivBucketOutcome("plans"),
			// Lineage threads for completeness-class repairs: `goal` (verbatim brief),
			// `research` (architecture/precedent findings), `subplans` (per-cluster
			// sub-plans). `goal`/`research` mirror `plan-confirm`'s reads; `subplans`
			// mirrors `plan`'s own `reads: ["research", fanin("subplans")]`. `subplans`
			// is plan-fix-ONLY — by the code gate the plan's completeness is settled, so
			// code-fix repairs code-shape defects and threads no subplans.
			reads: ["plans", fanin("plan-verdicts"), fanin("plan-cite-check"), "goal", "research", fanin("subplans")],
		}),
		// Snapshot the graded plan BEFORE plan-fix amends it — one deterministic
		// hop inside the existing fix loop (plan-grade/plan-confirm → plan-snapshot
		// → plan-fix). The re-grade reads the prior off the snapshot's OWN channel
		// (`plan-snapshot`) to decide whether the amend was surgical (re-grade only
		// the failing dims) or broad (re-grade the full roster). `produces.script`
		// rides its stage-name channel, so this publishes to `plan-snapshot`, NOT
		// `plans` — `latestFsArtifact(state, "plans")` still resolves to the real
		// (amended) plan.
		"plan-snapshot": produces.script({ reads: ["plans"], run: planSnapshot }),
		// Elaborate implement-ready code into each phase in parallel (fanout),
		// deterministically splice it back into the plan (code-splice), then
		// re-grade the now code-bearing plan — guarding the blind-splice risk.
		code: produces({ skill: "elaborate", loop: FRONTMATTER_PHASE_FANOUT, reads: ["plans"] }),
		"code-splice": acts.script({
			reads: ["plans"],
			run: ({ state, cwd }) => {
				const plan = latestFsArtifact(state, "plans");
				if (plan?.handle.kind !== "fs") {
					throw haltPreflight(
						"code-splice",
						"code-splice: no plan to splice into",
						"code-splice: no fs plan artifact on the 'plans' channel — synthesize must run before elaborate/code-splice",
					);
				}
				const planPath = isAbsolute(plan.handle.path) ? plan.handle.path : join(cwd, plan.handle.path);
				execFileSync("node", [STITCH_SCRIPT, planPath], { cwd });
			},
		}),
		// Deterministic citation floor over the SPLICED (code-bearing) plan before
		// the LLM code gate — the code-scope twin of `plan-cite-check`.
		"code-cite-check": produces.script({ reads: ["plans"], run: planCitationCheck("code-cite-check") }),
		"code-grade": produces({
			skill: "grade",
			loop: CODE_DIMENSION_FANOUT,
			outcome: codeVerdictOutcome,
			// `research` is read so the architecture-fit unit can thread it as
			// --context; `goal` so completeness/correctness anchor on the brief.
			reads: ["plans", "research", "goal"],
		}),
		// The code-gate twin of `plan-demote`: stamp the duty demotion onto the
		// code-graded verdicts (re-grading `plans` on `code-verdicts`) one hop
		// before the code gate routes (`code-demote` owns the route body).
		"code-demote": produces.script({ reads: ["plans", fanin("code-verdicts")], run: codeDemote }),
		// Repair arm for the code gate. Surgical `amend` over the SAME code-bearing
		// plan from the code verdicts — NOT a blind re-elaborate: `elaborate` never
		// sees the findings and can only rewrite a phase's code body, so it cannot fix
		// what the gate actually fails on (fabricated edit anchors, drifted line
		// citations, a cross-phase naming collision) and sometimes regressed a passing
		// dimension. `amend` reads the verdicts and edits the spliced plan in place
		// (its embedded code blocks included), then loops straight back to re-grade —
		// the mirror of the plan gate's `plan-fix` arm, on its own `code-verdicts`
		// channel so the two loops' verdicts never cross.
		// The code gate's confirm arm — the mirror of `plan-confirm`, on the
		// `code-verdicts` channel.
		"code-confirm": produces({
			skill: "grade",
			loop: CODE_CONFIRM_FANOUT,
			outcome: codeVerdictOutcome,
			reads: ["plans", "research", "goal"],
		}),
		"code-fix": produces({
			skill: "amend",
			outcome: rpivBucketOutcome("plans"),
			// Lineage threads for code-shape repairs: `goal`/`research` give amend the
			// brief + architecture context (mirroring `code-confirm`'s reads). NO
			// `subplans` — the plan's completeness was settled at the plan gate, so the
			// code arm only repairs code-shape defects (fabricated edit anchors, drifted
			// `file:line` citations, cross-phase naming collisions).
			reads: ["plans", fanin("code-verdicts"), fanin("code-cite-check"), "goal", "research"],
		}),
		// Snapshot the graded plan BEFORE code-fix amends it — the code-gate twin
		// of `plan-snapshot` (code-grade/code-confirm → code-snapshot → code-fix),
		// publishing the prior on the `code-snapshot` channel.
		"code-snapshot": produces.script({ reads: ["plans"], run: codeSnapshot }),
		implement: acts({ loop: IMPLEMENT_DAG_FANOUT, reads: ["plans"] }),
		// Lane-level scope floor — the structural backstop beneath the quality
		// gates. After the (now concurrent) implement lane lands, judge the working
		// tree's dirty set against the plan's declared write-set: any undeclared
		// write is a phase that escaped the upstream write-scope discipline and
		// raced on a sibling's in-flight edit. Fail ⇒ STOP (no fix arm). The `from`
		// form suppresses the READS_DATA outputSchema lint, so no schema is declared
		// (matching slice-check/plan-cite-check). Reads `goal` for the run-start
		// baseline that subtracts pre-existing dirt.
		"implement-scope-check": produces.script({ reads: ["plans", "goal"], run: implementScopeCheck }),
		// Deterministic post-implement reconciliation (no LLM): applies every
		// `#### Reconciliation` directive (find→replace, write-restricted to test
		// files) and re-runs every per-phase `#### Automated Verification:`
		// command, fail-soft — a coherence backstop the parallel implement lane
		// needs (a phase's correct change can invalidate a sibling's test, and the
		// combined tree can break in ways no single phase's checks surface). Pass ⇒
		// validate; fail/missing ⇒ STOP (no fallback). `reads: ["plans"]` only — no
		// run-start goal baseline (the scope floor already proved the write-set). The
		// `from` form suppresses the READS_DATA outputSchema lint.
		reconcile: produces.script({ reads: ["plans"], run: reconcile }),
		validate: produces({ prompt: VALIDATE_GOAL_PROMPT }),
		// Repair arm the validate gate dispatches on a `verdict: "fail"`. `acts()`
		// (not `produces()`) because remediate is `side-effect`/`code-mutation` (the
		// tools twin of `implement`: re-runs verification commands via `Bash(*)` and
		// edits the working tree) — NOT produced-validating and NOT routed-on (its
		// edge is deterministic), so it owns no outcome. `reads: ["plans","validation"]`
		// ⇒ `stageEntryArgs` derives `--plans <plan> --validation <latest-report>`;
		// `validation` is validate's own publish bucket, so validate-fix always reads
		// the latest failing report.
		"validate-fix": acts({ skill: "remediate", reads: ["plans", "validation"] }),
		commit: acts({ prompt: COMMIT_BASELINE_PROMPT, outcome: gitCommitOutcome }),
	},
	edges: {
		goal: "research",
		// Research's artifact is auto-fed to slice as its argument (the slice skill's
		// "Fresh" input is a research path).
		research: "slice",
		slice: "slice-check",
		// Skip the design-readiness re-grade when the gate is already satisfied — after
		// a `slice-fix` that only cleared the deterministic structure floor (the common
		// case: a bare-basename citation), the accumulated design-readiness verdict
		// already passes, so re-grading would only re-roll a flappy judgment. Also
		// skips after a fix for a `remedy: "cite"` fail once `slice-check` has
		// deterministically verified the demanded seeds landed on a structurally
		// unchanged map (the `citeDischarged` stamp — see `citeRemedyDischarged`).
		// First pass (no verdict yet) ⇒ not satisfied ⇒ into `slice-grade`.
		"slice-check": defineRoute(
			["slice-design", "slice-grade"],
			({ state }) => (sliceGatePasses(state) ? "slice-design" : "slice-grade"),
			{ readsData: false },
		),
		// Design-readiness gate BEFORE any design. Structure + design-readiness pass⇒ design; any fails ⇒
		// slice-fix and loop back. Bounded by the runner's maxBackwardJumps (default 3).
		"slice-grade": defineRoute(
			["slice-design", "slice-fix"],
			({ state }) => (sliceGatePasses(state) ? "slice-design" : "slice-fix"),
			{ readsData: false },
		),
		"slice-fix": "slice-check",
		// Design fanout → consolidated human checkpoint → hierarchical synthesis.
		"slice-design": "design-review",
		"design-review": "subplan",
		// Route the cluster fanout through the deterministic coverage floor before
		// the root merge — the twin of `slice → slice-check`. A pass folds straight
		// to `plan`; a lost/clobbered cluster routes the backward edge to `subplan`,
		// bounded by the runner's maxBackwardJumps.
		subplan: "subplan-check",
		// Subplan coverage gate. Pass ⇒ root merge. A fail (lost cluster, clobbered
		// ordinal, tokenless basename, or a slice design absent from every sources:)
		// routes the backward edge to `subplan` — re-dispatch the cluster fanout,
		// which re-supplies each cluster's '--cluster <k>'. Bounded by the runner's
		// maxBackwardJumps. `readsData: false` — the route consults only the
		// deterministic verdict channel (mirrors the slice-check/plan-cite-check routes).
		"subplan-check": defineRoute(
			["plan", "subplan"],
			({ state }) => (subplanGatePasses(state) ? "plan" : "subplan"),
			{ readsData: false },
		),
		plan: "plan-cite-check",
		// Skip the quality re-grade straight to `code` when the gate is already
		// satisfied — a `plan-fix` that only cleared the citation floor leaves every
		// dimension + risk flag already passing, so re-grading the whole panel would
		// only re-roll flappy judgments. First pass (empty verdict channel) ⇒ not
		// satisfied ⇒ into `plan-grade`. If a fix left the cite floor RED, the gate
		// isn't satisfied and we re-enter `plan-grade` (which re-runs the subset).
		"plan-cite-check": defineRoute(
			["code", "plan-grade"],
			({ state }) => (planGatePasses(state) ? "code" : "plan-grade"),
			{ readsData: false },
		),
		// Quality gate BEFORE any code. The grade runs at `plan-grade`; the route
		// lives one hop later on `plan-demote` so the duty-demotion write-back
		// lands on the verdict JSON BEFORE this fold consults the downstream
		// readers. `plan-grade` is now a simple always-hop edge to `plan-demote`;
		// the route body below is the verbatim logic that used to live here.
		"plan-grade": "plan-demote",
		// Pass ⇒ code. A dimension's FIRST blocking verdict ⇒ plan-confirm (one
		// independent second judgment — see `confirmDue`); a confirmed blocker, or
		// a failure with no dimension blocking (the citation floor alone is red) ⇒
		// plan-fix, looping back THROUGH the citation floor so the amended plan
		// re-verifies. Route logic unchanged — merely shifted one hop later so the
		// demote write-back precedes it.
		"plan-demote": defineRoute(
			["code", "plan-confirm", "plan-snapshot"],
			({ state }) =>
				planGatePasses(state)
					? "code"
					: confirmDue(state, "plans", "plan-verdicts", PLAN_DIMENSIONS)
						? "plan-confirm"
						: "plan-snapshot",
			{ readsData: false },
		),
		// After the second judgment the gate re-folds on the latest verdicts: a
		// confirming pass overwrote the flap and clears the gate; a confirming
		// fail routes to the fix with two agreeing judgments behind it.
		"plan-confirm": defineRoute(
			["code", "plan-snapshot"],
			({ state }) => (planGatePasses(state) ? "code" : "plan-snapshot"),
			{ readsData: false },
		),
		// The snapshot is one deterministic hop between the grade/confirm route and
		// the fix — no new backward edge, inside the existing fix loop.
		"plan-snapshot": "plan-fix",
		"plan-fix": "plan-cite-check",
		code: "code-splice",
		"code-splice": "code-cite-check",
		// Skip the code re-grade straight to `implement` when the code gate is already
		// satisfied — a `code-fix` that only cleared the citation floor leaves the
		// panel already green. First pass (empty channel) ⇒ into `code-grade`.
		"code-cite-check": defineRoute(
			["implement", "code-grade"],
			({ state }) => (codeGatePasses(state) ? "implement" : "code-grade"),
			{ readsData: false },
		),
		// Re-grade the code-bearing plan at `code-grade`; the route lives one hop
		// later on `code-demote` (the twin of the plan gate's split) so the
		// duty-demotion write-back lands before this fold. `code-grade` is now a
		// simple always-hop edge to `code-demote`; the route body below is verbatim.
		"code-grade": "code-demote",
		// Pass ⇒ implement. A first blocking verdict ⇒ code-confirm (the plan
		// gate's confirm contract, on the code-verdicts channel); a confirmed
		// blocker or cite-floor-only failure ⇒ code-fix. Routes to `code-fix`, NOT
		// back to `code`: the gate fails on plan-text defects (edit anchors, line
		// citations, naming) that a per-phase code rewrite cannot reach, so the
		// surgical arm is the one with authority over them. Route logic unchanged —
		// merely shifted one hop later. Bounded by the runner's maxBackwardJumps.
		"code-demote": defineRoute(
			["implement", "code-confirm", "code-snapshot"],
			({ state }) =>
				codeGatePasses(state)
					? "implement"
					: confirmDue(state, "plans", "code-verdicts", PLAN_DIMENSIONS)
						? "code-confirm"
						: "code-snapshot",
			{ readsData: false },
		),
		"code-confirm": defineRoute(
			["implement", "code-snapshot"],
			({ state }) => (codeGatePasses(state) ? "implement" : "code-snapshot"),
			{ readsData: false },
		),
		// The code-gate twin of `plan-snapshot → plan-fix`.
		"code-snapshot": "code-fix",
		"code-fix": "code-cite-check",
		implement: "implement-scope-check",
		// Lane-level scope floor gate. Pass ⇒ reconcile (the coherence backstop
		// runs after the write-set is proven). A `fail` (undeclared write) or a
		// missing verdict routes to STOP — no fix arm, because a scope violation is
		// plan-vs-tree drift the agent must reconcile manually (a phase wrote
		// outside its declared set), not a defect an auto-fix loop can repair. Safe
		// by construction: the sole path onward is an explicit `verdict: "pass"`.
		// Sourced from the scope-check's published verdict channel via the `from`
		// form (the stage key for an outcome-less `produces.script`, per
		// `resolvePublishName`), which suppresses the READS_DATA outputSchema lint.
		"implement-scope-check": match("verdict", { reconcile: "pass" }, { from: "implement-scope-check" }),
		// Reconciliation gate. Pass ⇒ validate; a `fail` (non-test directive target
		// / absent find / failed AV command) or a missing verdict ⇒ STOP (no fix
		// arm — a reconciliation failure is plan-vs-tree drift the agent reconciles
		// manually). Safe by construction: the sole path onward is an explicit
		// `verdict: "pass"`. Sourced from the reconcile channel via the `from` form.
		reconcile: match("verdict", { validate: "pass" }, { from: "reconcile" }),
		// Gate commit on validate's own verdict — an unconditional `validate → commit`
		// let a `verdict: fail` (incomplete goal coverage) commit anyway. Now the
		// gate splits: `pass` ⇒ commit; `fail` ⇒ validate-fix (the repair arm above,
		// which re-runs the failing `verify-at-implement` risk-ruling procedures and
		// surgically fixes the tree, then re-enters at implement-scope-check to
		// re-reconcile + re-validate — bounded by the per-destination backward-jump
		// budget). Deliberately NOT a `fallback`: a missing/unexpected verdict stays
		// terminal STOP, so un-anticipated data can never route INTO commit OR the
		// repair arm. Safe by construction: the sole path to commit is an explicit
		// pass. The `match` branch key (`validate-fix`) doubles as the reachability/
		// stage declaration, so naming it both routes `fail` and declares the stage
		// reachable. Sourced from validate's published verdict channel
		// (`from: "validation"` — the bucket its contract's `artifactKind` derives) —
		// a prompt stage owns its message and can't inherit its contract's output
		// schema, so route on the channel, not the raw (un-validated) stage output.
		validate: match("verdict", { commit: "pass", "validate-fix": "fail" }, { from: "validation" }),
		// Deterministic re-entry after the repair arm: remediate's code-mutation is
		// followed by a fresh scope check → reconcile → validate pass, so a fix is
		// re-verified end-to-end before the gate re-folds. A non-counted edge (a
		// deterministic hop into the loop body), so it never trips a backward-jump
		// budget on its own — the budget-consuming decision edge is the validate
		// gate's `validate-fix` branch above.
		"validate-fix": "implement-scope-check",
		commit: "stop",
	},
});

/**
 * Reason strings for ship's two bespoke stop picks — persisted on the
 * `RoutingDecision` row via `setRouteNote` so `summarizeRun` can surface
 * "stopped at <gate>: <why>" in the end-of-run recap and toast. `match`/`gate`
 * edges attach their own no-match diagnostics; only these two `defineRoute`
 * gates would otherwise stop silently. Best-effort DIAGNOSTICS, not gates:
 * `allDimensionsPass`/`shipGatePasses` stay the sole routing authorities, and
 * these mirror their severity floor only to NAME the blockers.
 */
const shipCiteStopNote = (state: RunView): string => {
	const data = state.named["plan-cite-check"]?.at(-1)?.data as { findings?: unknown } | undefined;
	const n = Array.isArray(data?.findings) ? data.findings.length : 0;
	return n > 0 ? `plan citation check failed (${n} finding${n === 1 ? "" : "s"})` : "plan citation check failed";
};
const shipGradeStopNote = (state: RunView): string => {
	const fresh = freshVerdicts(state.named["ship-verdicts"], latestArtifactPath(state, "plans"));
	if (fresh.length === 0) return "no fresh verdicts for the current plan";
	const risks = planAuthoredRisks(state, "plans");
	const latest = latestVerdictPerDimension(fresh);
	const blockers: string[] = [];
	for (const d of SHIP_DIMENSIONS) {
		const o = latest.get(d);
		if (!o) continue;
		const v = o.data as { pass?: boolean; severity?: string; findings?: unknown };
		const floored = v.pass === true || v.severity === "low" || v.severity === "none" || anchorNitsOnly(v);
		if (!floored) blockers.push(`${d} failed (${v.severity ?? "unrated"})`);
		else if (verdictRiskRulings(o).some((r) => !rulingEffectivePass(r, risks.get(r.id))))
			blockers.push(`${d} risk flag failed`);
	}
	return blockers.length > 0 ? blockers.join(", ") : "gate failed";
};

// Named (not inline) so the stop branch can self-reference for setRouteNote —
// the same closure-over-own-binding pattern gate()/match() use internally.
// Citation-floor gate. Pass ⇒ grade; fail ⇒ STOP (no fix arm — the lightweight
// preset terminates on any red gate). The route folds `allDimensionsPass` over
// the stage's OWN published channel, NOT `match("verdict", …)`:
// `writeStructureVerdict` (the floor's envelope) carries no `verdict` field, so
// a verdict match would misread — this mirrors build's `planGatePasses` first
// clause. `readsData: false` — the route consults the deterministic verdict
// channel only.
const shipCiteGate: EdgeFn = defineRoute(
	["grade", "stop"],
	({ state }) => {
		if (allDimensionsPass(state.named["plan-cite-check"])) return "grade";
		setRouteNote(shipCiteGate, shipCiteStopNote(state));
		return "stop";
	},
	{ readsData: false },
);
// Quality gate PRE-implement. `shipGatePasses` (the bespoke fold over
// SHIP_DIMENSIONS + risk flags on the `ship-verdicts` channel) does NOT re-fold
// the citation floor; this edge is the sole gate. Pass ⇒ implement; fail ⇒
// STOP — no confirm/snapshot/fix loop.
const shipGradeGate: EdgeFn = defineRoute(
	["implement", "stop"],
	({ state }) => {
		if (shipGatePasses(state)) return "implement";
		setRouteNote(shipGradeGate, shipGradeStopNote(state));
		return "stop";
	},
	{ readsData: false },
);

/**
 * ship — the lightweight `/wf` preset: the no-ceremony path for small-to-
 * midsize tasks whose approach is obvious. goal → research → plan →
 * plan-cite-check → grade → implement → implement-scope-check → reconcile →
 * validate → commit, stop-on-fail at every gate with NO backward edges: a red
 * gate terminates the run (the agent hand-repairs and re-invokes) instead of
 * looping a fix cycle. Research stays front-loaded — a ≤2-subagent grounding
 * pass (SHIP_RESEARCH_PROMPT, not a full `/skill:research` run) — because the
 * single PRE-implement grade's architecture-fit dimension needs its artifact as
 * `--context`. That grade is tier-independent: the bespoke SHIP_DIMENSION_FANOUT
 * always grades the full correctness/completeness/architecture-fit roster (no
 * gateTier/gateRoster light-tier drop), and SHIP's gate folds risk flags without
 * re-folding the citation floor (that floor folds at its own edge).
 */
const shipWorkflow = defineWorkflow({
	name: "ship",
	description:
		"Ship, unsliced: capture the verbatim brief as a goal artifact → ground it with at most two targeted codebase-analyzer dispatches (no /skill:research) → one lightweight quick-plan pass → deterministic citation floor → single tier-independent quality gate (correctness/completeness/architecture-fit, stop-on-fail) → implement → implement-scope-check → reconcile → validate → commit. Every gate terminates the run on fail; no fix loops.",
	start: "goal",
	stages: {
		// build's verbatim goal capture — the brief on its own channel, plus the
		// run-start pre-existing-dirty snapshot the scope-check subtracts.
		goal: produces.script({ run: captureGoal }),
		// The lean grounding pass — SHIP_RESEARCH_PROMPT (a custom prompt, NOT
		// /skill:research): ≤2 sequential codebase-analyzer subagents, then one
		// grounding doc under .rpiv/artifacts/research/. A prompt stage, so the
		// stage name `research` drives outcome derivation (research contract →
		// `research` bucket) exactly as build's RESEARCH_BRIEF_PROMPT stage does.
		research: produces({ prompt: SHIP_RESEARCH_PROMPT }),
		// The lightweight planner — quick-plan: ONE targeted
		// codebase-pattern-finder dispatch, one `status: ready` plan, no risks
		// frontmatter, no multi-slice decomposition. Derives its `plans` outcome
		// from the quick-plan contract (artifactKind: plan). Reads BOTH channels
		// explicitly (`--research <path> --goal <path>`) — without `goal` the
		// stage falls to the rolling primary and the planner sees only the
		// research doc, whose grounding routinely narrows the brief; the grade
		// panel's completeness dimension anchors on the VERBATIM goal, so the
		// planner must anchor on the same artifact to defer narrowed-out asks
		// explicitly instead of silently inheriting the drop.
		plan: produces({ skill: "quick-plan", reads: ["research", "goal"] }),
		// Deterministic citation floor BEFORE the LLM gate — build's verifier
		// verbatim. A fabricated `file:line` fails structurally and STOPs the run.
		"plan-cite-check": produces.script({ reads: ["plans"], run: planCitationCheck("plan-cite-check") }),
		// Single PRE-implement grade over the fixed three-dimension roster
		// (SHIP_DIMENSION_FANOUT — tier-independent, no confirm/snapshot arms);
		// verdicts on the `ship-verdicts` channel. `research` is read so the
		// architecture-fit unit threads it as --context; `goal` so
		// completeness/correctness anchor on the verbatim brief.
		grade: produces({
			skill: "grade",
			loop: SHIP_DIMENSION_FANOUT,
			outcome: shipVerdictOutcome,
			reads: ["plans", "research", "goal"],
		}),
		// Dep-gated DAG implement — build's lane verbatim.
		implement: acts({ loop: IMPLEMENT_DAG_FANOUT, reads: ["plans"] }),
		// Lane-level scope floor — build's latest-only variant (vet uses the
		// union variant for its fix loop; ship has no loop, so the latest plan's
		// declared write-set is the whole contract). Pass ⇒ reconcile; fail ⇒ STOP.
		"implement-scope-check": produces.script({ reads: ["plans", "goal"], run: implementScopeCheck }),
		// Deterministic post-implement reconciliation — build's run-function
		// verbatim. Pass ⇒ validate; fail/missing ⇒ STOP (no fallback).
		reconcile: produces.script({ reads: ["plans"], run: reconcile }),
		validate: produces({ prompt: VALIDATE_GOAL_PROMPT }),
		commit: acts({ prompt: COMMIT_BASELINE_PROMPT, outcome: gitCommitOutcome }),
	},
	edges: {
		goal: "research",
		research: "plan",
		plan: "plan-cite-check",
		// Both gates are the named EdgeFns above — they attach a stop-reason
		// ROUTE_NOTE the recap surfaces; routing semantics are unchanged.
		"plan-cite-check": shipCiteGate,
		grade: shipGradeGate,
		implement: "implement-scope-check",
		// Scope floor gate — build's route verbatim: the sole path onward is an
		// explicit `verdict: "pass"`; a fail (undeclared write) or a missing
		// verdict is terminal STOP. Sourced from the stage's own channel via the
		// `from` form (suppresses the READS_DATA outputSchema lint).
		"implement-scope-check": match("verdict", { reconcile: "pass" }, { from: "implement-scope-check" }),
		// Reconciliation gate — build's route verbatim: pass ⇒ validate;
		// fail/missing ⇒ STOP (plan-vs-tree drift the agent reconciles manually).
		reconcile: match("verdict", { validate: "pass" }, { from: "reconcile" }),
		// Validate gate — build's validate edge (match verdict pass⇒commit,
		// from "validation") minus the `validate-fix` arm: `pass` ⇒ commit; `fail`
		// or missing ⇒ STOP — deliberately NO validate-fix/remediate repair arm
		// (the lightweight preset does not loop). NOT vet's tail: vet's validate
		// routes to code-review, which gates back to blueprint (a bounded backward
		// loop, not stop-on-fail). Sourced from validate's published verdict
		// channel (`from: "validation"`).
		validate: match("verdict", { commit: "pass" }, { from: "validation" }),
		commit: "stop",
	},
});

// ===========================================================================
// Exports
// ===========================================================================

// Position 0 is load-bearing: `build` is the default `/wf` workflow when no
// project/user config sets one (resolve-default.ts resolves
// `Map.keys().next().value`), so it MUST stay first in this array.
export const builtInWorkflows: readonly Workflow[] = [buildWorkflow, vetWorkflow, polishWorkflow, shipWorkflow];
