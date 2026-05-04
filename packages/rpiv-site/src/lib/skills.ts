import { type CollectionEntry, getCollection } from "astro:content";

export type SkillEntry = CollectionEntry<"skills">;

const PIPELINE = ["discover", "research", "design", "plan", "implement", "validate"] as const;
const SECONDARY = ["blueprint", "explore", "annotate-guidance", "migrate-to-guidance"] as const;
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
	const all = await getCollection("skills");
	const hit = all.find((s) => s.data.name === name);
	if (!hit) throw new Error(`skill not found: ${name}`);
	return hit;
}

async function resolve(names: readonly string[]): Promise<SkillEntry[]> {
	const all = await getCollection("skills");
	return names.map((n) => {
		const hit = all.find((s) => s.data.name === n);
		if (!hit) throw new Error(`skill not found: ${n}`);
		return hit;
	});
}

/** Artifact write site for §4 / §5 / §6 detail rows. `null` = no thoughts/ artifact. */
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
