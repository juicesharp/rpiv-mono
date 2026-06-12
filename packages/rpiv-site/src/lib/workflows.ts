/**
 * The six workflows rpiv-pi registers into rpiv-workflow's `built-in` layer
 * (see packages/rpiv-pi/extensions/rpiv-core/built-in-workflows.ts). This is a
 * hand-maintained presentation mirror: the Hero renders a curated stage *spine*
 * per workflow, not the full edge graph (that's the §anatomy section's job).
 *
 * Keep in sync when built-in-workflows.ts changes. `stageCount` is the true
 * `Object.keys(stages).length`; `stages` is the spine drawn on the rail, which
 * may fold a loop-only stage (build's `revise`) into the `loop.label` rather
 * than place it on the happy path to `commit`.
 *
 * The runtime `default` (no config) cascades to the first registered workflow
 * (`ship`); the Hero independently *showcases* `build` because it exercises the
 * most machinery — research, fanout, and a review loop.
 */

export interface WorkflowStage {
	name: string;
	/** implement fans out over the plan's `phases:` array — renders a stacked node. */
	fanout?: boolean;
}

export interface WorkflowLoop {
	/** Stage index the backward edge departs (the review/validate node). */
	from: number;
	/** Stage index it returns to. */
	to: number;
	/** Mono caption above the arc, e.g. "↺ until clean". */
	label: string;
}

export interface WorkflowEntry {
	name: string;
	/** One-line "best when…" cue, condensed from the built-in `description`. */
	when: string;
	/**
	 * The realistic argument shown after the name in the Hero command line — what
	 * you'd actually type. "fresh" flows take a quoted brief; "diff" flows take a
	 * flag/range (`vet --staged`) or a layer/module path (`polish src/payments/`).
	 * Curly quotes are baked in for the briefs so they keep their typographic
	 * form; flags and paths render bare.
	 */
	arg: string;
	/** True stage count (`Object.keys(stages).length` in the workflow def). */
	stageCount: number;
	/** The spine drawn on the Hero rail. */
	stages: WorkflowStage[];
	loop?: WorkflowLoop;
	/**
	 * Entry condition — the axis the §catalog groups by. "fresh" workflows start
	 * from a brief; "diff" workflows start from an existing diff (their first
	 * stage is a review).
	 */
	group: "fresh" | "diff";
	/** The Hero's initial selection — the richest demo, not the runtime default. */
	showcase?: boolean;
}

const WORKFLOWS: readonly WorkflowEntry[] = [
	{
		name: "ship",
		when: "Small change, obvious approach. No research, no review.",
		arg: "“add a --json flag to status”",
		stageCount: 4,
		stages: [{ name: "blueprint" }, { name: "implement", fanout: true }, { name: "validate" }, { name: "commit" }],
		group: "fresh",
	},
	{
		name: "build",
		when: "Medium change you want reviewed before it lands.",
		arg: "“a Pi search extension backed by Ollama”",
		stageCount: 7,
		stages: [
			{ name: "research" },
			{ name: "blueprint" },
			{ name: "implement", fanout: true },
			{ name: "validate" },
			{ name: "code-review" },
			{ name: "commit" },
		],
		// code-review routes to revise on blockers; revise re-enters implement.
		loop: { from: 4, to: 2, label: "↺ revise until clean" },
		group: "fresh",
		showcase: true,
	},
	{
		name: "arch",
		when: "Complex change across many files or layers.",
		arg: "“the multi-agent orchestration subsystem”",
		stageCount: 7,
		stages: [
			{ name: "research" },
			{ name: "design" },
			{ name: "plan" },
			{ name: "implement", fanout: true },
			{ name: "validate" },
			{ name: "code-review" },
			{ name: "commit" },
		],
		// code-review loops the whole design chain on blockers.
		loop: { from: 5, to: 1, label: "↺ until clean" },
		group: "fresh",
	},
	{
		name: "vet",
		when: "A diff already exists. Review it, optionally repair.",
		arg: "main..HEAD",
		stageCount: 5,
		stages: [
			{ name: "code-review" },
			{ name: "blueprint" },
			{ name: "implement", fanout: true },
			{ name: "validate" },
			{ name: "commit" },
		],
		// validate re-reviews; loops the fix cycle until approved.
		loop: { from: 3, to: 0, label: "↺ until approved" },
		group: "diff",
	},
	{
		name: "polish",
		when: "A large architecture review, planned phase by phase.",
		arg: "packages/agent-core/",
		stageCount: 6,
		stages: [
			{ name: "architecture-review" },
			{ name: "blueprint" },
			{ name: "implement", fanout: true },
			{ name: "validate" },
			{ name: "code-review" },
			{ name: "commit" },
		],
		loop: { from: 4, to: 1, label: "↺ until clean" },
		group: "diff",
	},
	{
		name: "pr-triage",
		when: "An incoming PR. Decide if it earns a review: read-only, halts on a security BLOCK.",
		arg: "#482",
		stageCount: 2,
		// security-gate is a free script stage (no LLM): it reads the triage
		// skill's security_flag and halts the run before any checkout on BLOCK.
		stages: [{ name: "pr-triage" }, { name: "security-gate" }],
		group: "diff",
	},
];

/** All six built-in workflows, showcase entry first-class via `.showcase`. */
export async function getWorkflows(): Promise<WorkflowEntry[]> {
	return [...WORKFLOWS];
}
