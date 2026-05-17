import { type CollectionEntry, getCollection } from "astro:content";

type SpecEntry = CollectionEntry<"skillSpecs">;
type CopyEntry = CollectionEntry<"skills">;

export type SkillEntry = {
	slug: string;
	tagline: string;
	body: string | undefined;
	/** Frontmatter from the SKILL.md spec (argument-hint, allowed-tools, etc.). */
	data: SpecEntry["data"];
	/** Frontmatter from the site-side copy (`src/content/skills/<slug>.md`). Holds the
	 *  human-facing doc structure: purpose, when_to_use, inputs, outputs, key_steps, related. */
	copy: CopyEntry["data"] | undefined;
};

const PIPELINE = ["discover", "research", "design", "plan", "implement", "validate"] as const;
export type PipelineStep = (typeof PIPELINE)[number];
const SECONDARY = ["blueprint", "explore", "migrate-to-guidance"] as const;
const CODE_REVIEW_FLOW = ["commit", "code-review", "changelog", "validate"] as const;
/** Every skill name the site indexes by. Extend when adding a new skill so the
 * `satisfies` checks on ARTIFACT_WRITE_SITES (and any future per-skill table)
 * fail tsc rather than silently returning undefined at runtime. */
type KnownSkill =
	| PipelineStep
	| (typeof SECONDARY)[number]
	| (typeof CODE_REVIEW_FLOW)[number]
	| "annotate-guidance"
	| "revise";

export async function getPipelineSkills(): Promise<SkillEntry[]> {
	return resolve(PIPELINE);
}

export async function getSecondaryFlowSkills(): Promise<SkillEntry[]> {
	return resolve(SECONDARY);
}

export async function getCodeReviewSkills(): Promise<SkillEntry[]> {
	return resolve(CODE_REVIEW_FLOW);
}

export async function getSkill(name: string): Promise<SkillEntry> {
	const [specs, copies] = await Promise.all([getCollection("skillSpecs"), getCollection("skills")]);
	const spec = specs.find((s) => s.data.name === name);
	if (!spec) throw new Error(`skill spec not found: ${name}`);
	return merge(spec, copies);
}

async function resolve(names: readonly string[]): Promise<SkillEntry[]> {
	const [specs, copies] = await Promise.all([getCollection("skillSpecs"), getCollection("skills")]);
	return names.map((n) => {
		const spec = specs.find((s) => s.data.name === n);
		if (!spec) throw new Error(`skill spec not found: ${n}`);
		return merge(spec, copies);
	});
}

function merge(spec: SpecEntry, copies: CollectionEntry<"skills">[]): SkillEntry {
	const copy = copies.find((c) => c.data.slug === spec.data.name);
	return {
		slug: spec.data.name,
		tagline: copy?.data.tagline ?? spec.data.description,
		body: copy?.body,
		data: spec.data,
		copy: copy?.data,
	};
}

/** Artifact write site for §1 / §2 / §3 detail rows. `null` = no artifact.
 * `satisfies Record<KnownSkill, …>` enforces that every skill the site can name
 * has an entry — adding a skill without one will fail tsc instead of falling
 * through `undefined` at the call site. */
export const ARTIFACT_WRITE_SITES = {
	discover: ".rpiv/artifacts/discover/",
	research: ".rpiv/artifacts/research/",
	design: ".rpiv/artifacts/designs/",
	plan: ".rpiv/artifacts/plans/",
	implement: null,
	validate: null,
	blueprint: ".rpiv/artifacts/plans/",
	explore: ".rpiv/artifacts/solutions/",
	"annotate-guidance": ".rpiv/guidance/<sub>/architecture.md",
	"migrate-to-guidance": ".rpiv/guidance/ shadow tree",
	"code-review": ".rpiv/artifacts/reviews/",
	commit: null,
	changelog: null,
	revise: null,
} satisfies Record<KnownSkill, string | null>;

/** Pipeline-step presentation copy for the home-page emaki — kept here (not in
 * skill specs) so the narrative is editable without re-deriving specs.
 * `satisfies Record<PipelineStep, …>` enforces parity with the PIPELINE array
 * at compile time: adding a step without a matching meta entry will fail tsc. */
export type PipelineMeta = { collects: string[]; why: string };
export const PIPELINE_META = {
	discover: {
		collects: ["Goals", "Non-Goals", "Functional Requirements", "Acceptance Criteria", "Decisions"],
		why: "One question at a time captures intent before any code is read. Stops research from chasing the wrong target.",
	},
	research: {
		collects: ["Open questions", "Codebase facts", "Cross-file traces", "Cited line refs"],
		why: "Parallel analysis agents answer structured questions and synthesize one cited document. Design reads this, not the codebase.",
	},
	design: {
		collects: ["Architectural decisions", "Vertical slices", "File map", "Ordering", "Risk notes"],
		why: "Decomposes the feature into the smallest set of vertical slices that can land independently.",
	},
	plan: {
		collects: ["Atomic phases", "Parallelization graph", "Success criteria", "Rollback notes"],
		why: "Turns the design into phases sized for one verification loop each, with the criteria that prove a phase is done.",
	},
	implement: {
		collects: ["Code edits", "Phase verification logs", "Failure-recovery notes"],
		why: "Executes phases one at a time, runs the success criteria, refuses to advance until they pass.",
	},
	validate: {
		collects: ["Pass/fail per criterion", "Drift notes", "Follow-up tickets"],
		why: "Independent re-check of the plan against the working tree. Catches half-finished phases the implement loop missed.",
	},
} satisfies Record<PipelineStep, PipelineMeta>;

/** All skills merged with visitor copy, sorted alphabetically by slug.
 * Used by the Skills reference index page. */
export async function getAllSkills(): Promise<SkillEntry[]> {
	const [specs, copies] = await Promise.all([getCollection("skillSpecs"), getCollection("skills")]);
	return specs.map((spec) => merge(spec, copies)).sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Raw spec entry for rendering the SKILL.md body via render().
 * Returns the CollectionEntry so Astro's render() can produce { Content, headings }. */
export async function getSkillSpec(name: string): Promise<SpecEntry> {
	const specs = await getCollection("skillSpecs");
	const spec = specs.find((s) => s.data.name === name);
	if (!spec) throw new Error(`skill spec not found: ${name}`);
	return spec;
}
