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
import { readFileSync } from "node:fs";
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
	const headingCount = [...content.matchAll(PLAN_PHASE_RE)].length;
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
// build — research → blueprint → implement → validate → code-review →
//         (revise → implement → loop) | commit
//         Loops until code-review reports zero blockers, bounded by the
//         runner's maxBackwardJumps (default 2 → up to 3 review iterations).
// ===========================================================================

const buildWorkflow = defineWorkflow({
	name: "build",
	description:
		"Research-backed feature work with a review loop. Best for medium changes where you want a second pass before committing. Chain: research → blueprint → implement → validate → code-review → (revise loop) → commit.",
	start: "research",
	stages: {
		research: produces(),
		blueprint: produces(),
		implement: acts({ loop: IMPLEMENT_PHASE_FANOUT, reads: ["plans"] }),
		validate: produces(),
		"code-review": produces(),
		revise: produces({ reads: ["plans", "reviews"] }),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
		research: "blueprint",
		blueprint: "implement",
		implement: "validate",
		validate: "code-review",
		"code-review": gate("blockers_count", { revise: gt(0), commit: eq(0) }, "commit"),
		// Backward edge: revise → implement re-enters the implement/validate/
		// code-review cycle. Bounded by the runner's default maxBackwardJumps
		// (2), permitting at most 3 review iterations before the guard halts.
		revise: "implement",
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
			const headingCount = [...content.matchAll(REVIEW_PHASE_RE)].length;
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
// pr-triage — pr-triage → security-gate → stop
//   Read-only front door for an incoming GitHub PR. The `pr-triage` skill
//   fetches the PR thread, assesses the diff against whatever standard the repo
//   actually carries, writes a triage artifact, and recommends a triage
//   disposition (Review / Request changes / Hold / Decline) as a plain next
//   action. The `security-gate` script stage reads the skill's
//   `security_flag` and HALTS the run on a BLOCK (≥ 2) via `haltPreflight` — the
//   "security gate first, before any checkout" posture — while SAFE/REVIEW (< 2)
//   fall through to `stop` carrying the verdict.
//
//   It terminates rather than dispatching a follow-up workflow: triage gates entry
//   to review, it does not merge. The disposition is a plain action; `vet` (the
//   review stage) is offered as optional sugar under Review. Only the security gate
//   is enforced by the graph. A linear guard stage (not a `gate(...)`
//   edge) keeps the halt off the data-routing path — the throw lives inside the
//   script, read from the prior stage's output.
// ===========================================================================

/** BLOCK tier the pr-triage `security_flag` contract field emits (0 SAFE · 1 REVIEW · 2 BLOCK). */
const PR_TRIAGE_BLOCK = 2;

const prTriageWorkflow = defineWorkflow({
	name: "pr-triage",
	description:
		"Read-only triage of a GitHub PR before any review effort. Fetches the PR thread, assesses the diff against the repo's own standards, writes a triage artifact, and recommends a triage disposition (Review / Request changes / Hold / Decline). A security BLOCK halts the run before any checkout. Best as the entry point for an incoming PR. Chain: pr-triage → security-gate → stop.",
	start: "pr-triage",
	stages: {
		"pr-triage": produces(),
		// Skillless guard: read the triage skill's `security_flag` from the prior
		// stage's output and halt on BLOCK. A script stage (not a skill) — no LLM,
		// no session — so the gate is free. On SAFE/REVIEW it is a no-op side effect
		// and the chain advances to `stop`.
		"security-gate": acts.script({
			run: ({ input }) => {
				const flag = Number((input?.data as { security_flag?: unknown } | undefined)?.security_flag);
				if (Number.isNaN(flag) || flag >= PR_TRIAGE_BLOCK) {
					throw haltPreflight(
						"pr-triage",
						"pr-triage: security BLOCK — do not proceed",
						`pr-triage: security_flag=${flag} (BLOCK) — the PR diff carries a high-confidence security risk. Resolve it before any checkout or review; see the triage artifact for the traced finding.`,
					);
				}
			},
		}),
	},
	edges: {
		"pr-triage": "security-gate",
		"security-gate": "stop",
	},
});

// ===========================================================================
// carve — research → slice → slice-check (deterministic floor) → slice-grade
//         (design-readiness, slice-fix loop) → slice-design (fanout) →
//         subplan (cluster fanout) → plan → plan-grade (plan-fix loop) →
//         code (fanout) → code-splice → code-grade (code-fix loop) →
//         implement → validate → commit
//   The sliced, panel-gated heavy path: research the brief first (so every slice
//   rests on a real, cited footing and the plan gate can grade architecture-fit),
//   decompose it into independent
//   vertical slices, gate that breakdown BEFORE any design so each slice is
//   chewable by one design-slice pass. The gate is two-phase: a DETERMINISTIC
//   floor (`slice-check`) enforces dependency-cycle freedom and brief-coverage
//   conservation (a slice-fix may redistribute the brief, never drop scope to pass),
//   then ONE LLM `design-readiness` judgment reconciles the formerly-opposing
//   split/merge forces. Then design every slice in parallel, merge hierarchically
//   (per-cluster sub-plans → one plan) so no pass holds every design, gate the
//   plan on quality dimensions BEFORE any code, elaborate code per phase and
//   stitch it in, re-grade the code-bearing plan, then implement/validate/commit.
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
	const headingCount = [...content.matchAll(SLICE_HEADING_RE)].length;
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
 * Deterministic Phase-1 slice-check — the un-gameable floor beneath the LLM
 * `design-readiness` panel. It enforces the two invariants a prose grader cannot
 * reliably hold because it grades the slicer's own self-description:
 *   • acyclicity — the `deps` DAG must be cycle-free.
 *   • coverage conservation — every coverage unit FROZEN at the first cut
 *     (`state.named.slices[0]`) must still be claimed by ≥1 slice's `covers`,
 *     so a reslice can only redistribute the brief, never simplify by dropping
 *     scope. Anchored to the FIRST cut (not the latest map) so a reslice cannot
 *     disable the check by deleting the `coverage:` array — the frozen set is
 *     read from round 0.
 * Emits one combined `{ dimension: "structure" }` verdict onto the
 * `slice-check` channel; the gate route folds it with the LLM verdicts.
 * Deterministic ⇒ idempotent across reslice rounds (no flicker, resume-safe).
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
	const records = sliceRecords(readArtifactFile(latest.handle.path, cwd), "slice-check", latest.handle.path);
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

	const pass = findings.length === 0;
	return {
		kind: "json",
		artifacts: [],
		data: {
			dimension: "structure",
			pass,
			score: pass ? 100 : 0,
			severity: pass ? "none" : "high",
			artifact: handleToString(latest.handle),
			findings,
			feedback: pass ? "" : findings.map((f) => f.detail).join(" "),
		},
	};
};

/** A design filename encodes its slice as `…slice-<N>…` — the design-fanout naming convention. */
const DESIGN_SLICE_RE = /slice-(\d+)/;

/** Map slice number → its design artifact path, from the design fanout's published outputs. */
const designPathsBySlice = (state: RunView): Map<number, string> => {
	const bySlice = new Map<number, string>();
	(state.named.designs ?? []).forEach((out, idx) => {
		for (const a of out.artifacts) {
			if (a.handle.kind !== "fs") continue;
			const match = DESIGN_SLICE_RE.exec(basename(a.handle.path));
			const n = match ? Number(match[1]) : idx + 1; // fallback: positional (design i ↔ slice i+1)
			if (!bySlice.has(n)) bySlice.set(n, handleToString(a.handle));
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
		return clusterSliceDag(records)
			.map((cluster, i) => {
				const designs = cluster
					.map((n) => designBySlice.get(n))
					.filter((p): p is string => p !== undefined)
					.map((p) => `--designs ${p}`);
				if (!designs.length) return undefined;
				return {
					prompt: `${designs.join(" ")} --as-subplan`,
					label: `cluster ${i + 1} (slices ${cluster.join(",")})`,
					id: `cluster-${i + 1}`,
				};
			})
			.filter((u): u is { prompt: string; label: string; id: string } => u !== undefined);
	},
});

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
 * as `--context` for that dimension only; every other dimension (and the slice
 * gate's `design-readiness`, which never grades fit) gets the bare flags.
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
			return dimensions.map((d) => ({
				prompt: `--dimension ${d} --artifact ${target}${d === "architecture-fit" ? contextFlag : ""}`,
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
// The post-stitch gate re-grades the now code-bearing plan on its own channel,
// so its verdicts never mix with the pre-elaborate plan gate's.
const stitchVerdictOutcome = verdictOutcome("stitch-verdicts");

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

const carveWorkflow = defineWorkflow({
	name: "carve",
	description:
		"Ship, sliced: research the brief → decompose it into vertical slices → two-phase slice gate (a deterministic floor — dependency-cycle freedom + brief-coverage conservation so a slice-fix can't pass by dropping scope — then one LLM design-readiness judgment that each slice is chewable by a single design pass) with a slice-fix loop → design each slice in parallel → synthesize hierarchically (per-cluster sub-plans → one merged plan) → quality-panel gate (completeness/correctness/actionability/pattern-following/architecture-fit) with a plan-fix loop → elaborate code per phase in parallel → stitch → re-grade the code-bearing plan → implement → validate → commit. Research-led; three gates, before design, before code, and after stitch.",
	start: "research",
	stages: {
		// Front-loaded research grounds every slice's footing and feeds the plan
		// gate's architecture-fit dimension its --context.
		research: produces(),
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
		// Hierarchical fan-in: merge each slice-DAG cluster into a sub-plan in
		// parallel (bounded context), then merge the sub-plans into one plan.
		subplan: produces({
			skill: "synthesize",
			loop: SYNTH_CLUSTER_FANOUT,
			outcome: rpivBucketOutcome("subplans"),
		}),
		plan: produces({ skill: "synthesize", reads: [fanin("subplans")] }),
		// Quality gate over the plan; verdicts on their own channel.
		"plan-grade": produces({
			skill: "grade",
			loop: PLAN_DIMENSION_FANOUT,
			outcome: planVerdictOutcome,
			// `research` is read so the architecture-fit unit can thread it as --context.
			reads: ["plans", "research"],
		}),
		"plan-fix": produces({
			skill: "amend",
			outcome: rpivBucketOutcome("plans"),
			reads: ["plans", fanin("plan-verdicts")],
		}),
		// Elaborate implement-ready code into each phase in parallel (fanout),
		// deterministically splice it back into the plan (stitch), then re-grade
		// the now code-bearing plan — guarding the blind-splice risk.
		code: produces({ skill: "elaborate", loop: FRONTMATTER_PHASE_FANOUT, reads: ["plans"] }),
		"code-splice": acts.script({
			reads: ["plans"],
			run: ({ state, cwd }) => {
				const plan = latestFsArtifact(state, "plans");
				if (plan?.handle.kind !== "fs") {
					throw haltPreflight(
						"code-splice",
						"code-splice: no plan to stitch",
						"code-splice: no fs plan artifact on the 'plans' channel — synthesize must run before elaborate/stitch",
					);
				}
				const planPath = isAbsolute(plan.handle.path) ? plan.handle.path : join(cwd, plan.handle.path);
				execFileSync("node", [STITCH_SCRIPT, planPath], { cwd });
			},
		}),
		"code-grade": produces({
			skill: "grade",
			loop: PLAN_DIMENSION_FANOUT,
			outcome: stitchVerdictOutcome,
			// `research` is read so the architecture-fit unit can thread it as --context.
			reads: ["plans", "research"],
		}),
		// Repair arm for the stitch gate. Surgical `amend` over the SAME code-bearing
		// plan from the stitch verdicts — NOT a blind re-elaborate: `elaborate` never
		// sees the findings and can only rewrite a phase's code body, so it cannot fix
		// what the gate actually fails on (fabricated edit anchors, drifted line
		// citations, a cross-phase naming collision) and sometimes regressed a passing
		// dimension. `amend` reads the verdicts and edits the stitched plan in place
		// (its embedded code blocks included), then loops straight back to re-grade —
		// the mirror of the plan gate's `refine` arm, on its own `stitch-verdicts`
		// channel so the two loops' verdicts never cross.
		"code-fix": produces({
			skill: "amend",
			outcome: rpivBucketOutcome("plans"),
			reads: ["plans", fanin("stitch-verdicts")],
		}),
		implement: acts({ loop: IMPLEMENT_PHASE_FANOUT, reads: ["plans"] }),
		validate: produces(),
		commit: acts({ outcome: gitCommitOutcome }),
	},
	edges: {
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
		"slice-design": "subplan",
		subplan: "plan",
		plan: "plan-grade",
		// Quality gate BEFORE any code. Pass ⇒ code; any fails ⇒ plan-fix and loop back.
		"plan-grade": defineRoute(
			["code", "plan-fix"],
			({ state }) => (allDimensionsPass(state.named["plan-verdicts"]) ? "code" : "plan-fix"),
			{ readsData: false },
		),
		"plan-fix": "plan-grade",
		code: "code-splice",
		"code-splice": "code-grade",
		// Re-grade the code-bearing plan. Pass ⇒ implement; any fails ⇒ surgically
		// refine the stitched plan and re-grade. Routes to `code-fix`, NOT back to
		// `code`: the gate fails on plan-text defects (edit anchors, line
		// citations, naming) that a per-phase code rewrite cannot reach, so the
		// surgical arm is the one with authority over them. Bounded by the runner's
		// maxBackwardJumps.
		"code-grade": defineRoute(
			["implement", "code-fix"],
			({ state }) => (allDimensionsPass(state.named["stitch-verdicts"]) ? "implement" : "code-fix"),
			{ readsData: false },
		),
		"code-fix": "code-grade",
		implement: "validate",
		validate: "commit",
		commit: "stop",
	},
});

// ===========================================================================
// Exports
// ===========================================================================

export const builtInWorkflows: readonly Workflow[] = [
	shipWorkflow,
	buildWorkflow,
	archWorkflow,
	vetWorkflow,
	polishWorkflow,
	prTriageWorkflow,
	carveWorkflow,
];
