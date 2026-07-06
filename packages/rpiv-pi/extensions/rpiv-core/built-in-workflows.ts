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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	type Artifact,
	acts,
	defineRoute,
	defineWorkflow,
	directoryPathCollector,
	eq,
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
	type Unit,
	type Workflow,
} from "@juicesharp/rpiv-workflow/registration";
import { StagePreflightError } from "@juicesharp/rpiv-workflow/runner";
import { rpivBucketOutcome } from "./artifact-collector.js";

// The code-review stage's output schema is no longer declared here — every
// code-review stage sources it from the skill's contract `produces.data`
// (`blockers_count` required), validated by the runtime output loop via
// `effectiveOutputSchema`. One source of truth, in the skill, not copy-pasted
// per workflow. Every workflow — build/arch/polish AND vet — routes on the
// same numeric gate: `gate("blockers_count", { <fix>: gt(0), commit: eq(0) }, "commit")`.

/**
 * A plan's structured `phases:` frontmatter array — the machine-readable phase
 * enumeration a plan-producing skill (`blueprint`, `plan`) derives from its
 * `## Phase N:` body headings — is what drives `implement` fanout. The
 * convention lives here; rpiv-workflow knows nothing about phases.
 *
 * Cap: a plan declaring more than 32 phases throws. The rpiv-pi planning skills
 * cap around 8 phases in practice; 32 leaves headroom for stretch plans without
 * letting a pathological (or hostile) plan drive an unbounded fanout loop.
 */
const MAX_PHASES = 32;

/**
 * `## Phase N:` headings — the source of truth a plan's `phases:` frontmatter
 * array is derived from. Used to verify that derived array, not to enumerate
 * (enumeration reads the typed `phases:` array).
 */
const PLAN_PHASE_RE = /^## Phase (\d+):/gm;

/**
 * Count lines matching `re` (a `^…` heading pattern) that sit OUTSIDE fenced code
 * blocks. A `## Phase N:` / `## Slice N:` / `### Phase N —` inside a ``` or ~~~
 * fence is example/fixture text — a meta-plan (one whose subject is the pipeline)
 * legitimately embeds the pipeline's own plan/slice fixtures — not a structural
 * heading. Mirrors the fence-aware boundary scan in
 * skills/_shared/stitch-elaborations.mjs so the derive-check and the stitch that
 * produced the body agree on what a heading is (a naive `matchAll` counts fenced
 * examples and false-throws the derived-array staleness guard).
 */
const countHeadingsOutsideFences = (content: string, re: RegExp): number => {
	const lineRe = new RegExp(re.source); // per-line test; drop g/m so lastIndex can't drift
	let count = 0;
	let inFence = false;
	let fenceLen = 0;
	for (const line of content.split("\n")) {
		const fence = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence) {
			const len = fence[1].length;
			if (!inFence) {
				inFence = true;
				fenceLen = len;
			} else if (len >= fenceLen && line.trim().length === len) {
				inFence = false;
				fenceLen = 0;
			}
			continue;
		}
		if (!inFence && lineRe.test(line)) count++;
	}
	return count;
};

/**
 * One parsed entry of a plan's `phases:` array. `entry` carries the whole raw
 * frontmatter object, so a consumer can read fields beyond `{ n, title }`
 * without this parser knowing about them.
 */
interface PhaseRecord {
	entry: Record<string, unknown>;
	/** From `entry.n`, falling back to the 1-based array position. */
	n: number;
	/** From `entry.title`, or "" when absent. */
	title: string;
	/** 0-based position in the array. */
	index: number;
	/** Total phases in this plan. */
	total: number;
}

/** Read an artifact file, resolving a workflow-relative path against `cwd`. */
const readArtifactFile = (path: string, cwd: string): string =>
	readFileSync(isAbsolute(path) ? path : join(cwd, path), "utf-8");

/** Build the halting `StagePreflightError` shape every phase fanout/iterate guard `throw`s. */
const haltPreflight = (who: string, summary: string, detail: string): StagePreflightError =>
	new StagePreflightError("halt", who, summary, detail, true);

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

/** Latest `fs`-handle artifact most recently published under `name` (undefined if none). */
const latestFsArtifact = (state: RunView, name: string): Artifact | undefined =>
	state.named[name]?.at(-1)?.artifacts.find((a) => a.handle.kind === "fs");

/**
 * Fan `implement` out over the structured `phases:` frontmatter array of the
 * latest plan published to the named `"plans"` channel. Sourcing from the named
 * channel (not the rolling primary) makes the stage's `reads: ["plans"]`
 * declaration semantically honest. Used by every workflow whose `implement`
 * inherits one plan (ship/build/arch/vet); polish's accumulating multi-plan
 * variant is `PLANS_PHASE_FANOUT`.
 */
const FRONTMATTER_PHASE_FANOUT = fanout({
	source: "plans",
	unit: { by: "frontmatter-array", pattern: "phases" },
	max: MAX_PHASES,
	units: ({ state, cwd }) => {
		const plan = latestFsArtifact(state, "plans");
		if (plan?.handle.kind !== "fs") return [];
		const path = plan.handle.path;
		let content: string;
		try {
			content = readArtifactFile(path, cwd);
		} catch (err) {
			throw haltPreflight(
				"FRONTMATTER_PHASE_FANOUT",
				`FRONTMATTER_PHASE_FANOUT: plan file not found`,
				`FRONTMATTER_PHASE_FANOUT: could not read ${path} — ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const records = planPhaseRecords(content, "FRONTMATTER_PHASE_FANOUT", path);
		if (records.length > MAX_PHASES) {
			throw haltPreflight(
				"FRONTMATTER_PHASE_FANOUT",
				`FRONTMATTER_PHASE_FANOUT: plan ${path} exceeds phase limit`,
				`FRONTMATTER_PHASE_FANOUT: plan ${path} declares ${records.length} phases — exceeds MAX_PHASES (${MAX_PHASES}); split into smaller plans`,
			);
		}
		const promptPath = handleToString(plan.handle);
		return records.map((r) => ({
			prompt: `${promptPath} Phase ${r.n}: ${r.title}`.trimEnd(),
			label: `phase ${r.index + 1}/${r.total}`,
		}));
	},
});

/**
 * `implement`'s serial twin of `FRONTMATTER_PHASE_FANOUT`. Applying a plan to ONE
 * working tree is a patch-series / migration: phases share files (a later phase
 * EDITS a file an earlier phase CREATES) and mutate shared state, so running them
 * in parallel races on those files and lets a dependent phase run before its
 * prerequisite has landed. `concurrency: 1` serializes the units in the plan's
 * (topological) phase order — same units, no race, prerequisites always present.
 * `elaborate` keeps the parallel fanout: it writes ISOLATED per-phase docs.
 */
const IMPLEMENT_PHASE_FANOUT = { ...FRONTMATTER_PHASE_FANOUT, concurrency: 1 };

// ===========================================================================
// vet — code-review → (blueprint → implement → validate → loop) | commit
//       Examine existing changes; if not approved, blueprint a fix plan,
//       implement it, validate, and re-review. Loops until approved.
// ===========================================================================

const vetWorkflow = defineWorkflow({
	name: "vet",
	description:
		"Examine existing changes for approval; loop a fix cycle if not approved. Best when a diff already exists (yours or a teammate's) and you want a structured review with optional repair. Chain: code-review → (blueprint → implement → validate → loop) → commit.",
	start: "code-review",
	stages: {
		"code-review": produces(),
		blueprint: produces(),
		implement: acts({ loop: IMPLEMENT_PHASE_FANOUT, reads: ["plans"] }),
		validate: produces(),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
		// Same numeric gate as build/arch/polish: zero remaining blockers →
		// commit; any blockers → loop a fix pass through blueprint. The
		// `blockers_count` field is sourced + validated from the code-review
		// contract (`produces.data`, required), so a missing field fails
		// output validation rather than silently routing.
		"code-review": gate("blockers_count", { blueprint: gt(0), commit: eq(0) }, "commit"),
		blueprint: "implement",
		implement: "validate",
		// Backward edge: validate → code-review creates the review-fix loop.
		// Bounded by the runner's default maxBackwardJumps (2), permitting at
		// most 3 review iterations (initial + 2 retries) before the guard halts.
		validate: "code-review",
		commit: "stop",
	},
});

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

/** `implement`'s serial twin of `PLANS_PHASE_FANOUT` (polish's multi-plan variant) — same serialize-shared-tree rationale as `IMPLEMENT_PHASE_FANOUT`. */
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
		// runner's default maxBackwardJumps (2 → up to 3 review iterations).
		"code-review": gate("blockers_count", { blueprint: gt(0), commit: eq(0) }, "commit"),
		commit: "stop",
	},
});

// ===========================================================================
// carve — goal (verbatim-brief capture) → research → slice → slice-check
//         (deterministic floor) → slice-grade (design-readiness, slice-fix loop)
//         → slice-design (fanout) → design-review (one human checkpoint) →
//         subplan (cluster fanout) → plan → plan-grade (plan-fix loop) →
//         code (fanout) → code-splice → code-grade (code-fix loop) →
//         implement → validate → commit
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
//   The parallel generalization of `arch`.
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
 * Includes `architecture-fit`: carve front-loads a `research` stage, so the
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

/** Bucket directory the goal capture writes into — carve's verbatim-brief channel. */
const GOAL_DIR = ".rpiv/artifacts/goal";

/**
 * Capture the user's brief VERBATIM as carve's `goal` channel — the north-star
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
	// commit stage must scope to the work the workflow itself produces and never
	// sweep a pre-existing, unrelated working-tree change into its commit. The
	// commit skill's `git-changes.mjs` reads this baseline and fences those paths
	// off. Best-effort: a non-repo / git-unavailable cwd writes an empty baseline,
	// so the commit path degrades to today's behavior rather than failing the
	// deterministic goal capture.
	writeCommitBaseline(cwd);
	return { kind: "md", artifacts: [{ handle: { kind: "fs", path: rel } }], data: {} };
};

/** Where the run's pre-existing-dirty snapshot lands for `git-changes.mjs` to read. */
const COMMIT_BASELINE_REL = ".rpiv/artifacts/commit-baseline.json";

/** Record the paths dirty before the run (best-effort; empty on any git failure). */
const writeCommitBaseline = (cwd: string): void => {
	let paths: string[] = [];
	try {
		const out = execFileSync("git", ["status", "--short"], { cwd, encoding: "utf-8" });
		paths = out
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => {
				const rest = l.slice(3).trim();
				const arrow = rest.indexOf(" -> ");
				return arrow >= 0 ? rest.slice(arrow + 4).trim() : rest;
			});
	} catch {
		paths = [];
	}
	mkdirSync(dirname(join(cwd, COMMIT_BASELINE_REL)), { recursive: true });
	writeFileSync(join(cwd, COMMIT_BASELINE_REL), JSON.stringify({ paths }, null, 2), "utf-8");
};

/**
 * `goal` displaces `research` as carve's start stage, and ONLY the start stage
 * receives `originalInput` as its skill arg (`stageEntryArgs` case 1) — a plain
 * `produces()` research would silently receive the rolling primary (the goal
 * FILE PATH) instead of the brief text. A prompt stage owns its whole message,
 * so this rebuilds research's pre-goal dispatch byte-for-byte; the outcome
 * deriver still wires the `research` bucket off the record key (the polish
 * `validate` prompt-stage precedent).
 */
const RESEARCH_BRIEF_PROMPT: PromptFn = ({ state }) => `/skill:research ${state.originalInput}`;

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

/** The verdict directory the deterministic checks and the LLM grade panel share. */
const VERDICT_DIR = ".rpiv/artifacts/verdicts";

/**
 * A `path:line` (or `path:line-line`) citation in an artifact's prose. Requires a
 * dotted extension so timestamps (`17:13:27`), ratios, and bare `Slice 2:` labels
 * never match — only file references with a real extension are verified.
 */
const FILE_LINE_CITATION_RE = /([\w][\w./-]*\.[a-zA-Z][a-zA-Z0-9]{0,4}):(\d+)(?:-(\d+))?/g;

/**
 * Verify every `file:line` citation in `body` resolves against the working tree:
 * the cited file must exist AND carry at least the cited line (a range's high end).
 * A citation that names no real file, or points past end-of-file, is UNBACKED
 * precision — a fabricated reference that must fail the gate rather than propagate
 * into design. A bare `path` with no `:line` is not checked (the contract is
 * "verifiable line numbers, or omit them"). Returns one finding per bad citation.
 */
const verifyCitations = (body: string, cwd: string): { detail: string; where: string }[] => {
	const findings: { detail: string; where: string }[] = [];
	const seen = new Set<string>();
	for (const m of body.matchAll(FILE_LINE_CITATION_RE)) {
		const [, path, startStr, endStr] = m;
		if (!path || !startStr) continue;
		const key = `${path}:${startStr}${endStr ? `-${endStr}` : ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const abs = isAbsolute(path) ? path : join(cwd, path);
		if (!existsSync(abs) || !statSync(abs).isFile()) {
			findings.push({
				detail: `Unbacked citation ${key} — the cited file does not exist at this revision. A file:line citation must resolve, or the line numbers must be omitted. Fix the path or drop the citation.`,
				where: key,
			});
			continue;
		}
		const lineCount = readFileSync(abs, "utf-8").split("\n").length;
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

	const pass = findings.length === 0;
	const data = {
		dimension: "structure",
		pass,
		score: pass ? 100 : 0,
		severity: pass ? "none" : "high",
		artifact: handleToString(latest.handle),
		findings,
		feedback: pass ? "" : findings.map((f) => f.detail).join(" "),
	};
	// Write the verdict to an fs artifact so slice-fix's fanin projection forwards
	// the findings, not just the rolling pass/fail. Basename-keyed off the slice map
	// ⇒ idempotent across reslice rounds.
	const rel = join(VERDICT_DIR, `slice-check__${basename(latest.handle.path, ".md")}.json`);
	mkdirSync(join(cwd, VERDICT_DIR), { recursive: true });
	writeFileSync(join(cwd, rel), JSON.stringify(data, null, 2), "utf-8");
	return {
		kind: "json",
		artifacts: [{ handle: { kind: "fs", path: rel } }],
		data,
	};
};

/** A design filename encodes its slice as `…slice-<N>…` — the design-fanout naming convention. */
const DESIGN_SLICE_RE = /slice-(\d+)/;

/**
 * Map slice number → its design artifact path, from the design fanout's published
 * outputs. An identity resolver: it maps an ARTIFACT to a slice NUMBER, and it
 * FAILS LOUD when it cannot resolve unambiguously rather than fall back to a
 * positional guess. Two unresolvable shapes throw (halting the run instead of
 * silently mis-routing — the guardrail that turns a channel anomaly, e.g. the
 * duplicated `designs` a re-dispatched fanout could leave, into a stop):
 *   • a design filename that carries no `slice-<N>` token — the naming contract
 *     the whole mapping rests on is broken, so a positional `idx + 1` guess would
 *     scramble the cluster→design wiring and drop slices;
 *   • two designs claiming the SAME slice number — a doubled channel, ambiguous
 *     by construction; keeping the first silently loses the second.
 */
const designPathsBySlice = (state: RunView): Map<number, string> => {
	const bySlice = new Map<number, string>();
	(state.named.designs ?? []).forEach((out) => {
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
			const n = Number(match[1]);
			const prior = bySlice.get(n);
			if (prior !== undefined) {
				throw haltPreflight(
					"designPathsBySlice",
					`designPathsBySlice: two designs claim slice ${n}`,
					`designPathsBySlice: slice ${n} is claimed by both ${prior} and ${handleToString(a.handle)} — a duplicated 'designs' channel is ambiguous; the mapping must not silently keep one and drop the other`,
				);
			}
			bySlice.set(n, handleToString(a.handle));
		}
	});
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
					prompt: `${designs.join(" ")}${researchFlag} --as-subplan`,
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

/**
 * A grade panel: one `grade` session per dimension over the latest artifact on
 * `channel`. Each unit's prompt is the `grade` skill's flags
 * (`--dimension <d> --artifact <path>`); the per-dimension verdicts fold via
 * `allDimensionsPass`. Shared by the slice gate (over `slices`) and the plan
 * gate (over `plans`).
 *
 * `architecture-fit` is the one dimension `grade` requires a `--context` for: it
 * grades the plan against the research the slices rest on. The carve flow always
 * front-loads a `research` stage, so we thread the latest `research` artifact in
 * as `--context` for that dimension only; likewise the latest `goal` artifact
 * threads in as `--goal` for the `GOAL_DIMENSIONS` only. Every other dimension
 * (and the slice gate's `design-readiness`, which never grades fit or
 * goal-completeness) gets the bare flags.
 */
const gradePanelFanout = (channel: string, dimensions: readonly string[]) =>
	fanout({
		source: channel,
		unit: { by: "dimension-list", pattern: "dimensions" },
		max: dimensions.length,
		units: ({ state }) => {
			const doc = latestFsArtifact(state, channel);
			if (doc?.handle.kind !== "fs") return [];
			const target = handleToString(doc.handle);
			const research = latestFsArtifact(state, "research");
			const contextFlag = research?.handle.kind === "fs" ? ` --context ${handleToString(research.handle)}` : "";
			const goal = latestFsArtifact(state, "goal");
			const goalFlag = goal?.handle.kind === "fs" ? ` --goal ${handleToString(goal.handle)}` : "";
			return dimensions.map((d) => ({
				prompt: `--dimension ${d} --artifact ${target}${d === "architecture-fit" ? contextFlag : ""}${GOAL_DIMENSIONS.has(d) ? goalFlag : ""}`,
				label: d,
				id: `${channel}-dim-${d}`,
			}));
		},
	});

const SLICE_DIMENSION_FANOUT = gradePanelFanout("slices", SLICE_DIMENSIONS);
const PLAN_DIMENSION_FANOUT = gradePanelFanout("plans", PLAN_DIMENSIONS);

/**
 * Fold the per-dimension verdicts into a gate decision: keep the latest verdict
 * per dimension (verdicts accumulate across fix loops), require all-pass.
 * Deterministic ⇒ resume-safe for a `readsData: false` route.
 *
 * Severity floor: a verdict whose worst finding is `low`/`none` never blocks the
 * gate, even when the grader set `pass: false` on a nit. `grade` decides `pass`
 * by a free judgment against a prose bar (independent of `severity`), so a
 * marginal dimension can flip pass↔fail across rounds on an unchanged artifact —
 * that flapping, ANDed over a 5-dimension panel, stalled the carve gate loops
 * until the backward-jump guard halted them. Flooring on severity reserves a hard
 * fail for `medium`+ findings (the deterministic `slice-check` check emits
 * `high` on a real structural break, so it still blocks). A verdict with no
 * `severity` (an older or replayed grade) falls back to the raw `pass` boolean.
 */
const allDimensionsPass = (entries: readonly Output[] = []): boolean => {
	const latest = new Map<string, boolean>();
	for (const o of entries) {
		const v = o.data as { dimension?: string; pass?: boolean; severity?: string } | undefined;
		if (typeof v?.dimension !== "string") continue;
		const lowOrNone = v.severity === "low" || v.severity === "none";
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
}

/** The `risk_rulings` a grade verdict emitted (empty when it ruled on none). */
const verdictRiskRulings = (o: Output): RiskRuling[] => {
	const raw = (o.data as { risk_rulings?: unknown } | undefined)?.risk_rulings;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((e) => {
		const r = (e ?? {}) as Record<string, unknown>;
		return typeof r.id === "string" ? [{ id: r.id, pass: r.pass === true }] : [];
	});
};

/**
 * Fold the grade panel's per-flag risk rulings into a gate decision: every
 * plan-authored risk flag the panel ruled on must be ruled PASS (latest ruling
 * per flag wins, mirroring `allDimensionsPass`). A flag ruled `fail` — the
 * grader confirmed the risk is real and unaddressed — blocks the gate, so a
 * self-flagged risk (e.g. the #103 override-vs-env validation bug) can no longer
 * ride a green conformance pass into commit. An empty panel (no flag engaged)
 * imposes no constraint; the plan simply declared no risks.
 */
const allRiskFlagsPass = (entries: readonly Output[] = []): boolean => {
	const latest = new Map<string, boolean>();
	for (const o of entries) for (const r of verdictRiskRulings(o)) latest.set(r.id, r.pass);
	return [...latest.values()].every(Boolean);
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
 * Carve's validate dispatch: the latest synthesized plan plus the goal flag.
 * Sourcing the plan from the NAMED channel (not the rolling primary) is
 * load-bearing: `code-grade` is a produces-fanout, so after the code gate the
 * rolling primary is the LAST VERDICT JSON (`placeFanoutOutput` advances it per
 * unit) and `implement` (acts) leaves it there — a plain `produces()` validate
 * would receive a verdict path as its "plan". A prompt stage owns its whole
 * message, so the `/skill:validate` prefix is explicit (polish precedent).
 */
const VALIDATE_GOAL_PROMPT: PromptFn = ({ state }) => {
	const parts = ["/skill:validate"];
	const plan = latestFsArtifact(state, "plans");
	if (plan?.handle.kind === "fs") parts.push(handleToString(plan.handle));
	const goal = latestFsArtifact(state, "goal");
	if (goal?.handle.kind === "fs") parts.push(`--goal ${handleToString(goal.handle)}`);
	return parts.join(" ");
};

const carveWorkflow = defineWorkflow({
	name: "build",
	description:
		"Ship, sliced: capture the verbatim brief as a goal artifact (the north star the quality gates' completeness/correctness dimensions and validate anchor against) → research the brief → decompose it into vertical slices → two-phase slice gate (a deterministic floor — dependency-cycle freedom + brief-coverage conservation so a slice-fix can't pass by dropping scope — then one LLM design-readiness judgment that each slice is chewable by a single design pass) with a slice-fix loop → design each slice in parallel → one consolidated developer checkpoint (accept or adjust the proposed interfaces/data types, adjustments applied surgically and cascaded to dependents) → synthesize hierarchically (per-cluster sub-plans → one merged plan) → quality-panel gate (completeness/correctness/actionability/pattern-following/architecture-fit) with a plan-fix loop → elaborate code per phase in parallel → splice it into the plan → re-grade the code-bearing plan → implement → validate → commit. Research-led; three automated gates plus one human design checkpoint, before design, before code, and after the splice.",
	start: "goal",
	stages: {
		// The user's brief, verbatim, on its own channel — the judgment seams
		// (plan/code gates' completeness+correctness, validate) anchor against
		// it. Deliberately NOT fed to the generative stages (slice, design-slice):
		// bounded per-slice context is carve's whole point, and an ambient goal
		// there invites re-litigating settled decompositions.
		goal: produces.script({ run: captureGoal }),
		// Front-loaded research grounds every slice's footing and feeds the plan
		// gate's architecture-fit dimension its --context. Prompt-dispatched so it
		// still receives the raw brief now that `goal` holds the start slot.
		research: produces({ prompt: RESEARCH_BRIEF_PROMPT }),
		slice: produces(),
		// Phase 1 of the gate: the DETERMINISTIC floor (cycle-freedom + coverage conservation), no LLM.
		"slice-check": produces.script({ reads: ["slices"], run: sliceStructureCheck }),
		// Phase 2 of the gate: ONE LLM design-readiness judgment; verdicts on their own channel.
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
		// The root merge reads `research` (threaded as `--research` so cross-slice
		// constraints reach the merge directly, not only via each subplan's
		// refraction) alongside the cluster sub-plans it fans in.
		plan: produces({ skill: "synthesize", reads: ["research", fanin("subplans")] }),
		// Quality gate over the plan; verdicts on their own channel.
		"plan-grade": produces({
			skill: "grade",
			loop: PLAN_DIMENSION_FANOUT,
			outcome: planVerdictOutcome,
			// `research` is read so the architecture-fit unit can thread it as
			// --context; `goal` so completeness/correctness anchor on the brief.
			reads: ["plans", "research", "goal"],
		}),
		"plan-fix": produces({
			skill: "amend",
			outcome: rpivBucketOutcome("plans"),
			reads: ["plans", fanin("plan-verdicts")],
		}),
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
		"code-grade": produces({
			skill: "grade",
			loop: PLAN_DIMENSION_FANOUT,
			outcome: codeVerdictOutcome,
			// `research` is read so the architecture-fit unit can thread it as
			// --context; `goal` so completeness/correctness anchor on the brief.
			reads: ["plans", "research", "goal"],
		}),
		// Repair arm for the code gate. Surgical `amend` over the SAME code-bearing
		// plan from the code verdicts — NOT a blind re-elaborate: `elaborate` never
		// sees the findings and can only rewrite a phase's code body, so it cannot fix
		// what the gate actually fails on (fabricated edit anchors, drifted line
		// citations, a cross-phase naming collision) and sometimes regressed a passing
		// dimension. `amend` reads the verdicts and edits the spliced plan in place
		// (its embedded code blocks included), then loops straight back to re-grade —
		// the mirror of the plan gate's `plan-fix` arm, on its own `code-verdicts`
		// channel so the two loops' verdicts never cross.
		"code-fix": produces({
			skill: "amend",
			outcome: rpivBucketOutcome("plans"),
			reads: ["plans", fanin("code-verdicts")],
		}),
		implement: acts({ loop: IMPLEMENT_PHASE_FANOUT, reads: ["plans"] }),
		validate: produces({ prompt: VALIDATE_GOAL_PROMPT }),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
		goal: "research",
		// Research's artifact is auto-fed to slice as its argument (the slice skill's
		// "Fresh" input is a research path) — mirrors arch's research → design edge.
		research: "slice",
		slice: "slice-check",
		"slice-check": "slice-grade",
		// Design-readiness gate BEFORE any design. Structure + design-readiness pass⇒ design; any fails ⇒
		// slice-fix and loop back. Bounded by the runner's maxBackwardJumps (default 2).
		"slice-grade": defineRoute(
			["slice-design", "slice-fix"],
			({ state }) =>
				allDimensionsPass(state.named["slice-check"]) && allDimensionsPass(state.named["slice-verdicts"])
					? "slice-design"
					: "slice-fix",
			{ readsData: false },
		),
		"slice-fix": "slice-check",
		// Design fanout → consolidated human checkpoint → hierarchical synthesis.
		"slice-design": "design-review",
		"design-review": "subplan",
		subplan: "plan",
		plan: "plan-grade",
		// Quality gate BEFORE any code. Pass ⇒ code; any fails ⇒ plan-fix and loop back.
		"plan-grade": defineRoute(
			["code", "plan-fix"],
			({ state }) =>
				allDimensionsPass(state.named["plan-verdicts"]) && allRiskFlagsPass(state.named["plan-verdicts"])
					? "code"
					: "plan-fix",
			{ readsData: false },
		),
		"plan-fix": "plan-grade",
		code: "code-splice",
		"code-splice": "code-grade",
		// Re-grade the code-bearing plan. Pass ⇒ implement; any fails ⇒ surgically
		// amend the spliced plan and re-grade. Routes to `code-fix`, NOT back to
		// `code`: the gate fails on plan-text defects (edit anchors, line
		// citations, naming) that a per-phase code rewrite cannot reach, so the
		// surgical arm is the one with authority over them. Bounded by the runner's
		// maxBackwardJumps.
		"code-grade": defineRoute(
			["implement", "code-fix"],
			({ state }) =>
				allDimensionsPass(state.named["code-verdicts"]) && allRiskFlagsPass(state.named["code-verdicts"])
					? "implement"
					: "code-fix",
			{ readsData: false },
		),
		"code-fix": "code-grade",
		implement: "validate",
		// Gate commit on validate's own verdict — an unconditional `validate → commit`
		// let a `verdict: fail` (incomplete goal coverage) commit anyway. `match` with
		// no fallback commits ONLY on an explicit `verdict: "pass"`; every other value
		// (a `fail`, or a missing verdict) routes to STOP — a failed validation halts
		// WITHOUT committing, leaving the report on disk for the user. Safe by
		// construction: the sole path to commit is an explicit pass, so un-anticipated
		// data can never route INTO commit. Sourced from validate's published verdict
		// channel (`from: "validation"` — the bucket its contract's `artifactKind`
		// derives) — a prompt stage owns its message and can't inherit its contract's
		// output schema, so route on the channel, not the raw (un-validated) stage output.
		validate: match("verdict", { commit: "pass" }, { from: "validation" }),
		commit: "stop",
	},
});

// ===========================================================================
// Exports
// ===========================================================================

export const builtInWorkflows: readonly Workflow[] = [vetWorkflow, polishWorkflow, carveWorkflow];
