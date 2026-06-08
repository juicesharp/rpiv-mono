/**
 * The stage skills a workflow chains — the "parts catalog" behind the five
 * built-in flows. Each declares a contract (`reads` → `writes`) so the runner
 * can pass one stage's output into the next and reject a mismatch before the
 * run starts.
 *
 * `in` is the set of built-in workflows whose TRUE stage list (see
 * built-in-workflows.ts) names this skill — not the Hero spine, which folds
 * revise into a loop label. Keep both in sync with the built-ins.
 */

export interface StageSkill {
	name: string;
	/** One-line job. */
	role: string;
	/** Input artifact kind it consumes. */
	reads: string;
	/** Output artifact kind it produces. */
	writes: string;
	/** `.rpiv/artifacts/<bucket>/` path, or null for a working-tree side effect. */
	artifact: string | null;
	/** Built-in workflows that name this skill. */
	in: string[];
	/** Catalog grouping. */
	group: "plan" | "make" | "close";
}

const STAGE_SKILLS: readonly StageSkill[] = [
	// ── plan the work ──
	{
		name: "research",
		role: "Answers structured questions about the codebase in parallel.",
		reads: "a brief",
		writes: "research",
		artifact: ".rpiv/artifacts/research/",
		in: ["build", "arch"],
		group: "plan",
	},
	{
		name: "design",
		role: "Decomposes a feature into independent vertical slices.",
		reads: "research",
		writes: "design",
		artifact: ".rpiv/artifacts/designs/",
		in: ["arch"],
		group: "plan",
	},
	{
		name: "plan",
		role: "Turns a design into phased, atomic steps with success criteria.",
		reads: "design",
		writes: "plan",
		artifact: ".rpiv/artifacts/plans/",
		in: ["arch"],
		group: "plan",
	},
	{
		name: "blueprint",
		role: "Folds design and plan into a single pass.",
		reads: "research or a brief",
		writes: "plan",
		artifact: ".rpiv/artifacts/plans/",
		in: ["ship", "build", "vet", "polish"],
		group: "plan",
	},
	{
		name: "architecture-review",
		role: "Layer-by-layer review of a whole module, phased for repair.",
		reads: "a module",
		writes: "architecture review",
		artifact: ".rpiv/artifacts/architecture-reviews/",
		in: ["polish"],
		group: "plan",
	},
	// ── make the change ──
	{
		name: "implement",
		role: "Executes the plan phase by phase, gating each on its criteria.",
		reads: "plan",
		writes: "working-tree changes",
		artifact: null,
		in: ["ship", "build", "arch", "vet", "polish"],
		group: "make",
	},
	{
		name: "validate",
		role: "Re-checks each phase against its criteria, independently.",
		reads: "plan + tree",
		writes: "validation",
		artifact: ".rpiv/artifacts/validation/",
		in: ["ship", "build", "arch", "vet", "polish"],
		group: "make",
	},
	// ── close the loop ──
	{
		name: "code-review",
		role: "Audits the diff across quality, security, and dependencies.",
		reads: "a diff",
		writes: "review + blockers_count",
		artifact: ".rpiv/artifacts/reviews/",
		in: ["build", "arch", "vet", "polish"],
		group: "close",
	},
	{
		name: "revise",
		role: "Surgically updates a plan from review feedback.",
		reads: "plan + review",
		writes: "plan",
		artifact: ".rpiv/artifacts/plans/",
		in: ["build"],
		group: "close",
	},
	{
		name: "commit",
		role: "Groups the working tree into clear, structured commits.",
		reads: "working tree",
		writes: "git commit",
		artifact: null,
		in: ["ship", "build", "arch", "vet", "polish"],
		group: "close",
	},
];

export async function getStageSkills(): Promise<StageSkill[]> {
	return [...STAGE_SKILLS];
}
