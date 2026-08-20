/**
 * The plan/review phase layer: `phases:` and `### Phase N` frontmatter parsing,
 * per-phase declared write-sets (with test-twin expansion), and the
 * implement/blueprint fanouts built on them.
 */
import { basename } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	type FanoutContext,
	fanout,
	handleToString,
	iterate,
	type Output,
	type RunView,
	type Unit,
} from "@juicesharp/rpiv-workflow/registration";
import { countHeadingsOutsideFences } from "./markdown-fence.js";
import {
	haltPreflight,
	latestFsArtifact,
	MAX_PHASES,
	type PhaseRecord,
	readArtifactFile,
	TEST_PATH_RE,
} from "./shared.js";

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
 * already guarantees. Applied at BOTH consumers of the declared set — the
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

export {
	FRONTMATTER_PHASE_FANOUT,
	IMPLEMENT_DAG_FANOUT,
	IMPLEMENT_PLANS_FANOUT,
	latestPlans,
	PLAN_PHASE_RE,
	phaseFiles,
	planPhaseRecords,
	REVIEW_PHASE_ITERATE,
	withTestTwins,
};
