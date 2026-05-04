import { type CollectionEntry, getCollection } from "astro:content";

type SpecEntry = CollectionEntry<"skillSpecs">;

export type SkillEntry = {
	slug: string;
	tagline: string;
	body: string | undefined;
	data: SpecEntry["data"];
};

const PIPELINE = ["discover", "research", "design", "plan", "implement", "validate"] as const;
const SECONDARY = ["blueprint", "explore", "migrate-to-guidance"] as const;
const CODE_REVIEW_FLOW = ["commit", "code-review"] as const;

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
	};
}

/** Artifact write site for §1 / §2 / §3 detail rows. `null` = no thoughts/ artifact. */
export const ARTIFACT_WRITE_SITES: Record<string, string | null> = {
	discover: "thoughts/shared/questions/",
	research: "thoughts/shared/research/",
	design: "thoughts/shared/designs/",
	plan: "thoughts/shared/plans/",
	implement: null,
	validate: null,
	blueprint: "thoughts/shared/plans/",
	explore: "thoughts/shared/solutions/",
	"annotate-guidance": ".rpiv/guidance/<sub>/architecture.md",
	"migrate-to-guidance": ".rpiv/guidance/ shadow tree",
	"code-review": "thoughts/shared/reviews/",
	commit: null,
	revise: null,
};
