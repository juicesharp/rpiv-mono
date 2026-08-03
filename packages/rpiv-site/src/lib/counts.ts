import { getCollection } from "astro:content";
import { getAgentsByTier } from "./agents";
import { SIBLING_NAMES } from "./siblings";
import { getWorkflows } from "./workflows";

/**
 * Build-time surface counts for the landing variants. Each number is derived
 * from the same source its detail surface renders from, so a stat and the
 * section it links to can never disagree: skills from the cross-package
 * `skillSpecs` collection (docs reference), agents from the curated
 * `TIER_BY_NAME` roster (the same roster the agent docs pages render from —
 * it currently mirrors all 15 on-disk agent specs, and exists as a tier
 * assignment and curation seam, not as a hide-list), workflows from the
 * hand-maintained catalog mirror, siblings from the SiblingGrid roster.
 */
export interface SurfaceCounts {
	skills: number;
	agents: number;
	workflows: number;
	siblings: number;
}

export async function getSurfaceCounts(): Promise<SurfaceCounts> {
	const [skillSpecs, workflows, agentTiers] = await Promise.all([
		getCollection("skillSpecs"),
		getWorkflows(),
		getAgentsByTier(),
	]);
	return {
		skills: skillSpecs.length,
		// Count what actually renders: the allowlist ∩ on-disk specs, same
		// intersection pages/docs/reference/agents.astro and
		// pages/docs/reference/agents/[slug].astro draw from.
		agents: agentTiers.reduce((n, g) => n + g.agents.length, 0),
		workflows: workflows.length,
		siblings: SIBLING_NAMES.length,
	};
}
