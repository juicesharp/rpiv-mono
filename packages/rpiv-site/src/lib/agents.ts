import { type CollectionEntry, getCollection } from "astro:content";

type SpecEntry = CollectionEntry<"agentSpecs">;
type CopyEntry = CollectionEntry<"agents">;

export type AgentEntry = {
	slug: string;
	tagline: string;
	body: string | undefined;
	/** Frontmatter from the upstream agent spec (`tools`, `isolated`, etc.). */
	data: SpecEntry["data"];
	/** Frontmatter from the site-side visitor copy (`src/content/agents/<slug>.md`).
	 *  Holds the human-facing doc structure: purpose, when_to_use, dispatched_by. */
	copy: CopyEntry["data"] | undefined;
};

export type CapabilityTier = "locator" | "analyzer" | "external" | "specialist";

/** The 13 named agents that ship as built docs pages. Exported so
 *  `getStaticPaths` (agents/[slug].astro) can filter `agentSpecs` against it,
 *  keeping `artifact-code-reviewer` / `artifact-coverage-reviewer` / `slice-verifier` invisible per FRD Non-Goals. */
export const TIER_BY_NAME: Record<string, CapabilityTier> = {
	"codebase-locator": "locator",
	"artifacts-locator": "locator",
	"test-case-locator": "locator",
	"integration-scanner": "locator",
	"codebase-analyzer": "analyzer",
	"codebase-pattern-finder": "analyzer",
	"artifacts-analyzer": "analyzer",
	"precedent-locator": "analyzer",
	"scope-tracer": "analyzer",
	"web-search-researcher": "external",
	"claim-verifier": "specialist",
	"diff-auditor": "specialist",
	"peer-comparator": "specialist",
};

/** Specialists + already-single-sentence locators get the full description. Others trim to first sentence. */
const FULL_DESCRIPTION_AGENTS = new Set([
	"claim-verifier",
	"diff-auditor",
	"peer-comparator",
	"precedent-locator",
	"codebase-locator",
	"integration-scanner",
	"test-case-locator",
]);

/** Fallback derivation when no visitor tagline is authored yet. Trim jokey multi-sentence to first sentence. */
function fallbackTagline(spec: SpecEntry): string {
	const { name } = spec.data;
	const desc = spec.data.description;
	if (FULL_DESCRIPTION_AGENTS.has(name)) return desc;
	return desc.split(/(?<=[.!?])\s+/, 2)[0]!;
}

/** Visitor-facing copy. Returns the authored tagline if present, otherwise a derived fallback from the spec. */
export function siteDescription(agent: AgentEntry): string {
	return agent.tagline;
}

export function tier(agent: AgentEntry): CapabilityTier {
	return TIER_BY_NAME[agent.slug] ?? "analyzer";
}

const TIER_ORDER: CapabilityTier[] = ["locator", "analyzer", "specialist", "external"];

function merge(spec: SpecEntry, copies: CopyEntry[]): AgentEntry {
	const copy = copies.find((c) => c.data.slug === spec.data.name);
	return {
		slug: spec.data.name,
		tagline: copy?.data.tagline ?? fallbackTagline(spec),
		body: copy?.body,
		data: spec.data,
		copy: copy?.data,
	};
}

/** Direct lookup by agent slug. Mirrors `getSkill(name)` at `lib/skills.ts:42-48`.
 *  Throws if the slug isn't in `TIER_BY_NAME` — defensive net for future drift
 *  between `agentSpecs` and `TIER_BY_NAME` even though `getStaticPaths` filters
 *  to the same allowlist. */
export async function getAgent(name: string): Promise<AgentEntry> {
	if (!(name in TIER_BY_NAME)) throw new Error(`agent not in TIER_BY_NAME: ${name}`);
	const [specs, copies] = await Promise.all([getCollection("agentSpecs"), getCollection("agents")]);
	const spec = specs.find((s) => s.data.name === name);
	if (!spec) throw new Error(`agent spec not found: ${name}`);
	return merge(spec, copies);
}

export async function getAgentsByTier(): Promise<Array<{ tier: CapabilityTier; agents: AgentEntry[] }>> {
	const [specs, copies] = await Promise.all([getCollection("agentSpecs"), getCollection("agents")]);
	const all: AgentEntry[] = specs.filter((spec) => spec.data.name in TIER_BY_NAME).map((spec) => merge(spec, copies));
	const groups = new Map<CapabilityTier, AgentEntry[]>(TIER_ORDER.map((t) => [t, []]));
	for (const a of all) groups.get(tier(a))!.push(a);
	for (const list of groups.values()) {
		list.sort((x, y) => x.slug.localeCompare(y.slug));
	}
	return TIER_ORDER.map((t) => ({ tier: t, agents: groups.get(t)! }));
}

/** Raw spec entry for rendering the agent spec body via render().
 * Returns the CollectionEntry so Astro's render() can produce { Content, headings }. */
export async function getAgentSpec(name: string): Promise<SpecEntry> {
	const specs = await getCollection("agentSpecs");
	const spec = specs.find((s) => s.data.name === name);
	if (!spec) throw new Error(`agent spec not found: ${name}`);
	return spec;
}
