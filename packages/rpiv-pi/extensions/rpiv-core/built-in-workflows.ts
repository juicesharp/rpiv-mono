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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
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
// ship — blueprint → implement → validate → commit
// ===========================================================================

const shipWorkflow = defineWorkflow({
	name: "ship",
	description:
		"Fast path with no research or review. Best when the change is small and the approach is obvious. Chain: blueprint → implement → validate → commit.",
	start: "blueprint",
	stages: {
		blueprint: produces(),
		implement: acts({ loop: IMPLEMENT_PHASE_FANOUT, reads: ["plans"] }),
		validate: produces(),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
		blueprint: "implement",
		implement: "validate",
		validate: "commit",
		commit: "stop",
	},
});

// ===========================================================================
// arch — research → design → plan → implement → validate → code-review →
//        (design → loop) | commit
//        Loops the full design/plan/implement/validate/review chain until
//        code-review reports zero blockers, bounded by the runner's
//        maxBackwardJumps (default 2 → up to 3 review iterations).
// ===========================================================================

const archWorkflow = defineWorkflow({
	name: "arch",
	description:
		"Design-led pipeline for complex changes touching many files or layers. Best when the approach itself needs to be worked out before planning. Chain: research → design → plan → implement → validate → code-review → (design loop) → commit.",
	start: "research",
	stages: {
		research: produces(),
		design: produces(),
		plan: produces(),
		implement: acts({ loop: IMPLEMENT_PHASE_FANOUT, reads: ["plans"] }),
		validate: produces(),
		"code-review": produces(),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
		research: "design",
		design: "plan",
		plan: "implement",
		implement: "validate",
		validate: "code-review",
		// Backward edge: code-review → design re-enters the full
		// design/plan/implement/validate/review cycle. Bounded by the
		// runner's default maxBackwardJumps (2), permitting at most 3
		// review iterations before the guard halts.
		"code-review": gate("blockers_count", { design: gt(0), commit: eq(0) }, "commit"),
		commit: "stop",
	},
});

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
// build — goal (verbatim-brief capture) → research → slice → slice-check
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

/** Record the paths dirty before the run to `rel` (best-effort; empty on any git failure). */
const writeCommitBaseline = (cwd: string, rel: string): void => {
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
	mkdirSync(dirname(join(cwd, rel)), { recursive: true });
	writeFileSync(join(cwd, rel), JSON.stringify({ paths }, null, 2), "utf-8");
};

/** The run-start pre-existing-dirty snapshot riding the goal channel (role "baseline"). */
const goalBaselinePath = (state: RunView): string | undefined => {
	const a = state.named.goal?.at(-1)?.artifacts.find((x) => x.role === "baseline" && x.handle.kind === "fs");
	return a ? handleToString(a.handle) : undefined;
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
 *
 * A citation may START with a single dot (`.github/workflows/ci.yml:12`,
 * `.eslintrc.js:3`) — without it, dot-dirs and dotfiles were captured with the
 * dot stripped and guaranteed to fail the floor as a mangled path. The leading
 * dot is taken only when the preceding char is not a word char or another dot
 * (`(?<![\w.])`), and a dotless start only at a word boundary (`(?<!\w)`), so a
 * prose ellipsis (`...packages/x.ts:5`) still yields `packages/x.ts`, never
 * `...packages/x.ts`.
 */
const FILE_LINE_CITATION_RE = /((?:(?<![\w.])\.)?(?<!\w)[\w][\w./-]*\.[a-zA-Z][a-zA-Z0-9]{0,4}):(\d+)(?:-(\d+))?/g;

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
const buildBasenameIndex = (cwd: string): { index: Map<string, string[]>; truncated: boolean } => {
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

const verifyCitations = (body: string, cwd: string): { detail: string; where: string }[] => {
	const findings: { detail: string; where: string }[] = [];
	const seen = new Set<string>();
	// Built lazily and reused across citations — only the first direct-resolution
	// miss pays the tree walk, and only when at least one such citation exists.
	let basenameIndex: { index: Map<string, string[]>; truncated: boolean } | undefined;
	// Tree files whose REPO-RELATIVE path ends with the cited path on WHOLE
	// segments. A bare basename is the one-segment case; a multi-segment citation
	// narrows the basename's candidates at a `/` boundary, so `workflow/validate/x.ts`
	// can never match inside `rpiv-workflow/validate/x.ts`. Compared repo-relative
	// (never against the absolute path) so the checkout directory's own name can
	// never back a citation — `src/utils.ts` must not resolve to `<cwd>/utils.ts`
	// just because the repo happens to be cloned at `/tmp/src`.
	const suffixMatches = (path: string): string[] => {
		basenameIndex ??= buildBasenameIndex(cwd);
		if (basenameIndex.truncated) return []; // partial index ⇒ uniqueness untrustworthy ⇒ strict
		const candidates = basenameIndex.index.get(basename(path)) ?? [];
		if (!path.includes("/")) return candidates;
		const suffix = `/${path}`;
		return candidates.filter((abs) =>
			`/${abs
				.slice(cwd.length + 1)
				.split(sep)
				.join("/")}`.endsWith(suffix),
		);
	};
	for (const m of body.matchAll(FILE_LINE_CITATION_RE)) {
		const [, path, startStr, endStr] = m;
		if (!path || !startStr) continue;
		const key = `${path}:${startStr}${endStr ? `-${endStr}` : ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const direct = isAbsolute(path) ? path : join(cwd, path);
		let abs: string | undefined;
		if (existsSync(direct) && statSync(direct).isFile()) {
			abs = direct;
		} else {
			// Suffix fallback: back the citation iff exactly ONE tree file matches.
			const matches = suffixMatches(path);
			if (matches.length === 1) {
				abs = matches[0];
			} else if (matches.length > 1) {
				const shown = matches.slice(0, 3).map((a) => (a.startsWith(cwd + sep) ? a.slice(cwd.length + 1) : a));
				findings.push({
					detail: `Unbacked citation ${key} — ${path} matches ${matches.length} tree files (${shown.join(", ")}${matches.length > shown.length ? ", …" : ""}); a citation must name ONE file. Disambiguate with the repo-root-relative path.`,
					where: key,
				});
				continue;
			}
		}
		if (!abs) {
			findings.push({
				detail: `Unbacked citation ${key} — the cited file does not exist at this revision. A file:line citation must resolve, or the line numbers must be omitted. Fix the path (repo-root-relative) or drop the citation.`,
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

/**
 * Deterministic citation floor for a synthesized/spliced plan — the plan-scope
 * twin of `sliceStructureCheck`'s citation backing, extending finding 6 past the
 * slice map to the plan and the code-bearing plan (a fabricated `file:line` in
 * the plan misdirects `implement`, exactly the #103 class). Verifies every
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
		const rel = join(VERDICT_DIR, `${who}__${basename(latest.handle.path, ".md")}.json`);
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
 * that once left CONFLICTING designs on the channel is fixed at its source —
 * finding 7 — so there is no corruption left to fail loud on here.)
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
		const s = (o.data as { severity?: unknown } | undefined)?.severity;
		if (typeof s === "string") severities.add(s);
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
const dimensionsToRegrade = (dimensions: readonly string[], latest: ReadonlyMap<string, Output>): string[] => {
	return dimensions.filter((d) => {
		const o = latest.get(d);
		if (!o) return true; // never graded — must grade at least once
		const v = o.data as { pass?: boolean; severity?: string } | undefined;
		const dimPass = v?.pass === true || v?.severity === "low" || v?.severity === "none";
		if (!dimPass) return true;
		const raw = (o.data as { risk_rulings?: unknown } | undefined)?.risk_rulings;
		return Array.isArray(raw) && raw.some((e) => (e as { pass?: unknown })?.pass !== true);
	});
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
	{ confirm = false }: { confirm?: boolean } = {},
) =>
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
			const roster = gateRoster(gateTier(state, verdictChannel), dimensions);
			const latest = latestVerdictPerDimension(freshVerdicts(state.named[verdictChannel], target));
			const pending = dimensionsToRegrade(roster, latest);
			const priorFlag = (d: string): string => {
				if (!confirm || !pending.includes(d)) return "";
				const handle = latest.get(d)?.artifacts.find((a) => a.handle.kind === "fs")?.handle;
				return handle ? ` --prior ${handleToString(handle)}` : "";
			};
			// Never emit zero units (empty ⇒ single dimensionless grade fall-through).
			const toGrade = pending.length > 0 ? pending : roster;
			return toGrade.map((d) => ({
				prompt: `--dimension ${d} --artifact ${target}${d === "architecture-fit" ? contextFlag : ""}${GOAL_DIMENSIONS.has(d) ? goalFlag : ""}${priorFlag(d)}`,
				label: d,
				id: `${channel}-dim-${d}`,
			}));
		},
	});

const SLICE_DIMENSION_FANOUT = gradePanelFanout("slices", SLICE_DIMENSIONS, "slice-verdicts");
const PLAN_DIMENSION_FANOUT = gradePanelFanout("plans", PLAN_DIMENSIONS, "plan-verdicts");
// The post-splice code gate re-grades the SAME `plans` artifact on its own
// `code-verdicts` channel, so its carry-forward reads the code gate's verdicts,
// never the pre-elaborate plan gate's.
const CODE_DIMENSION_FANOUT = gradePanelFanout("plans", PLAN_DIMENSIONS, "code-verdicts");
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
		const v = o.data as { dimension?: string; pass?: boolean; severity?: string } | undefined;
		if (typeof v?.dimension !== "string") continue;
		if (member && !member.has(v.dimension)) continue;
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
const sliceGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["slice-verdicts"], latestArtifactPath(state, "slices"));
	const roster = gateRoster(gateTier(state, "slice-verdicts"), SLICE_DIMENSIONS);
	return allDimensionsPass(state.named["slice-check"]) && allDimensionsPass(fresh, roster);
};
const planGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["plan-verdicts"], latestArtifactPath(state, "plans"));
	const roster = gateRoster(gateTier(state, "plan-verdicts"), PLAN_DIMENSIONS);
	return (
		allDimensionsPass(state.named["plan-cite-check"]) && allDimensionsPass(fresh, roster) && allRiskFlagsPass(fresh)
	);
};
const codeGatePasses = (state: RunView): boolean => {
	const fresh = freshVerdicts(state.named["code-verdicts"], latestArtifactPath(state, "plans"));
	const roster = gateRoster(gateTier(state, "code-verdicts"), PLAN_DIMENSIONS);
	return (
		allDimensionsPass(state.named["code-cite-check"]) && allDimensionsPass(fresh, roster) && allRiskFlagsPass(fresh)
	);
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
	const byDim = new Map<string, { blocking: boolean; count: number }>();
	for (const o of fresh) {
		const v = o.data as { dimension?: string; pass?: boolean; severity?: string } | undefined;
		if (typeof v?.dimension !== "string" || !roster.has(v.dimension)) continue;
		const floored = v.pass === true || v.severity === "low" || v.severity === "none";
		const riskFail = verdictRiskRulings(o).some((r) => !r.pass);
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

const buildWorkflow = defineWorkflow({
	name: "build",
	description:
		"Ship, sliced: capture the verbatim brief as a goal artifact (the north star the quality gates' completeness/correctness dimensions and validate anchor against) → research the brief → decompose it into vertical slices → two-phase slice gate (a deterministic floor — dependency-cycle freedom + brief-coverage conservation so a slice-fix can't pass by dropping scope — then one LLM design-readiness judgment that each slice is chewable by a single design pass) with a slice-fix loop → design each slice in parallel → one consolidated developer checkpoint (accept or adjust the proposed interfaces/data types, adjustments applied surgically and cascaded to dependents) → synthesize hierarchically (per-cluster sub-plans → one merged plan) → tier-scaled quality-panel gate (a one-slice, <=2-phase run grades correctness+completeness only; larger or previously-failing runs grade the full completeness/correctness/actionability/pattern-following/architecture-fit roster) where a dimension's first blocking verdict gets one confirming second judgment before it buys a plan-fix round → elaborate code per phase in parallel → splice it into the plan → re-grade the code-bearing plan (same tier + confirm contract) → implement → validate → commit. Research-led; three automated gates plus one human design checkpoint, before design, before code, and after the splice.",
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
			reads: ["plans", fanin("plan-verdicts"), fanin("plan-cite-check")],
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
			reads: ["plans", fanin("code-verdicts"), fanin("code-cite-check")],
		}),
		implement: acts({ loop: IMPLEMENT_PHASE_FANOUT, reads: ["plans"] }),
		validate: produces({ prompt: VALIDATE_GOAL_PROMPT }),
		commit: acts({ prompt: COMMIT_BASELINE_PROMPT, outcome: gitCommitOutcome }),
	},
	edges: {
		goal: "research",
		// Research's artifact is auto-fed to slice as its argument (the slice skill's
		// "Fresh" input is a research path) — mirrors arch's research → design edge.
		research: "slice",
		slice: "slice-check",
		// Skip the design-readiness re-grade when the gate is already satisfied — after
		// a `slice-fix` that only cleared the deterministic structure floor (the common
		// case: a bare-basename citation), the accumulated design-readiness verdict
		// already passes, so re-grading would only re-roll a flappy judgment. First
		// pass (no verdict yet) ⇒ not satisfied ⇒ into `slice-grade`.
		"slice-check": defineRoute(
			["slice-design", "slice-grade"],
			({ state }) => (sliceGatePasses(state) ? "slice-design" : "slice-grade"),
			{ readsData: false },
		),
		// Design-readiness gate BEFORE any design. Structure + design-readiness pass⇒ design; any fails ⇒
		// slice-fix and loop back. Bounded by the runner's maxBackwardJumps (default 2).
		"slice-grade": defineRoute(
			["slice-design", "slice-fix"],
			({ state }) => (sliceGatePasses(state) ? "slice-design" : "slice-fix"),
			{ readsData: false },
		),
		"slice-fix": "slice-check",
		// Design fanout → consolidated human checkpoint → hierarchical synthesis.
		"slice-design": "design-review",
		"design-review": "subplan",
		subplan: "plan",
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
		// Quality gate BEFORE any code. Pass ⇒ code. A dimension's FIRST blocking
		// verdict ⇒ plan-confirm (one independent second judgment — see
		// `confirmDue`); a confirmed blocker, or a failure with no dimension
		// blocking (the citation floor alone is red) ⇒ plan-fix, looping back
		// THROUGH the citation floor so the amended plan re-verifies (else a stale
		// failing cite verdict would loop forever).
		"plan-grade": defineRoute(
			["code", "plan-confirm", "plan-fix"],
			({ state }) =>
				planGatePasses(state)
					? "code"
					: confirmDue(state, "plans", "plan-verdicts", PLAN_DIMENSIONS)
						? "plan-confirm"
						: "plan-fix",
			{ readsData: false },
		),
		// After the second judgment the gate re-folds on the latest verdicts: a
		// confirming pass overwrote the flap and clears the gate; a confirming
		// fail routes to the fix with two agreeing judgments behind it.
		"plan-confirm": defineRoute(["code", "plan-fix"], ({ state }) => (planGatePasses(state) ? "code" : "plan-fix"), {
			readsData: false,
		}),
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
		// Re-grade the code-bearing plan. Pass ⇒ implement. A first blocking
		// verdict ⇒ code-confirm (the plan gate's confirm contract, on the
		// code-verdicts channel); a confirmed blocker or cite-floor-only failure ⇒
		// code-fix. Routes to `code-fix`, NOT back to `code`: the gate fails on
		// plan-text defects (edit anchors, line citations, naming) that a
		// per-phase code rewrite cannot reach, so the surgical arm is the one with
		// authority over them. Bounded by the runner's maxBackwardJumps.
		"code-grade": defineRoute(
			["implement", "code-confirm", "code-fix"],
			({ state }) =>
				codeGatePasses(state)
					? "implement"
					: confirmDue(state, "plans", "code-verdicts", PLAN_DIMENSIONS)
						? "code-confirm"
						: "code-fix",
			{ readsData: false },
		),
		"code-confirm": defineRoute(
			["implement", "code-fix"],
			({ state }) => (codeGatePasses(state) ? "implement" : "code-fix"),
			{ readsData: false },
		),
		"code-fix": "code-cite-check",
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

export const builtInWorkflows: readonly Workflow[] = [
	shipWorkflow,
	archWorkflow,
	vetWorkflow,
	polishWorkflow,
	buildWorkflow,
];
