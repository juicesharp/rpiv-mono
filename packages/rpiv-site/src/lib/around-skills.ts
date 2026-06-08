/**
 * The skills that surround a flow — standalone skills that are NOT stages of any
 * built-in workflow, grouped by their moment relative to a run. "The skills that
 * complement them," part two.
 */

export interface AroundSkill {
	name: string;
	/** One-line job. */
	role: string;
	/** Artifact / output label, or a side-effect description. */
	output: string;
	moment: "before" | "context" | "across" | "edges";
}

const AROUND_SKILLS: readonly AroundSkill[] = [
	// ── before the run: frame the work ──
	{
		name: "discover",
		role: "Interviews you one question at a time to capture intent.",
		output: ".rpiv/artifacts/discover/",
		moment: "before",
	},
	{
		name: "explore",
		role: "Weighs solution options with trade-offs and a recommendation.",
		output: ".rpiv/artifacts/solutions/",
		moment: "before",
	},
	// ── standing context: per-folder docs the agent reads as it works ──
	{
		name: "annotate-guidance",
		role: "Writes a parallel .rpiv/guidance/ tree, resolved per-depth at every tool call.",
		output: ".rpiv/guidance/<sub>/architecture.md",
		moment: "context",
	},
	{
		name: "migrate-to-guidance",
		role: "Converts an existing inline CLAUDE.md project into the guidance system.",
		output: ".rpiv/guidance/ shadow tree",
		moment: "context",
	},
	{
		name: "annotate-inline",
		role: "Writes CLAUDE.md files inline next to the code they describe.",
		output: "CLAUDE.md (inline)",
		moment: "context",
	},
	// ── across sessions: save state, pick it up later ──
	{
		name: "create-handoff",
		role: "Compacts the task, decisions, and open questions into a handoff doc.",
		output: "handoff document",
		moment: "across",
	},
	{
		name: "resume-handoff",
		role: "Reads a handoff, verifies repo state, and continues the work.",
		output: "resumes the run",
		moment: "across",
	},
	// ── around the edges: direction and release ──
	{
		name: "frontend-design",
		role: "Injects tailored visual direction before any frontend work.",
		output: "inline guidelines",
		moment: "edges",
	},
	{
		name: "changelog",
		role: "Regenerates the [Unreleased] section in Keep a Changelog style.",
		output: "CHANGELOG.md",
		moment: "edges",
	},
];

export async function getAroundSkills(): Promise<AroundSkill[]> {
	return [...AROUND_SKILLS];
}
