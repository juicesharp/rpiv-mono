/**
 * The four built-in pipelines rpiv-pi registers into rpiv-workflow's
 * `built-in` layer (see packages/rpiv-pi/extensions/rpiv-core/built-in-workflows.ts)
 * — build/vet/polish/ship mirrored here. This is a
 * hand-maintained presentation mirror: the landing renders a curated stage
 * *spine* per pipeline, not the full edge graph.
 *
 * Keep in sync when built-in-workflows.ts changes. `stageCount` is the true
 * `Object.keys(stages).length`; `stages` is the spine drawn on the rail. vet,
 * polish, and ship are small enough to draw stage-for-stage; `build` folds its 32
 * runtime stages into seven acts:
 *
 *   capture → goal, research                                    (verbatim brief)
 *   slice   → slice, slice-check, slice-grade, slice-fix        (gate + fix loop)
 *   design  → slice-design ×N                                   (parallel fanout)
 *   review  → design-review                                     (the human gate)
 *   plan    → subplan ×clusters, subplan-check, plan,
 *             plan-cite-check, plan-grade ×2–5, plan-demote,
 *             plan-confirm, plan-snapshot, plan-fix
 *                                                  (tier-scaled gate + fix loop)
 *   code    → code ×phases, code-splice, code-cite-check,
 *             code-grade ×2–5, code-demote, code-confirm,
 *             code-snapshot, code-fix
 *                                                  (tier-scaled gate + fix loop)
 *   land    → implement, implement-scope-check, scope-quarantine,
 *             reconcile, validate, validate-fix, commit
 *
 * The runtime `default` (no config) cascades to the first registered workflow
 * (`build`); the landing also *showcases* `build` because it exercises
 * the most machinery — verbatim brief capture, parallel design, three quality
 * gates, and the one human design review.
 */

export interface WorkflowStage {
	name: string;
	/** Fans out into parallel fresh-context sessions — renders a stacked node. */
	fanout?: boolean;
	/** A quality gate the flow must pass (deterministic floor and/or grade panel). */
	gate?: boolean;
	/** The gate repairs and re-enters via a fix loop when a dimension fails. */
	fix?: boolean;
	/** The driver's moment — build's design review. Renders the hanko seal. */
	human?: boolean;
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
	 * you'd actually type. `build` takes a quoted brief; `vet` takes a review
	 * scope — a bare scope word or a commit range (`vet staged`, `vet main..HEAD`)
	 * — and `polish` a layer/module path (`polish src/payments/`).
	 * Curly quotes are baked in for the briefs so they keep their typographic
	 * form; scopes and paths render bare.
	 */
	arg: string;
	/** True stage count (`Object.keys(stages).length` in the workflow def). */
	stageCount: number;
	/** The spine drawn on the rail (acts for build, stages for vet/polish). */
	stages: WorkflowStage[];
	loop?: WorkflowLoop;
	/** The landing's initial selection — the richest demo, not the runtime default. */
	showcase?: boolean;
}

const WORKFLOWS: readonly WorkflowEntry[] = [
	{
		name: "build",
		when: "A feature from a brief. Sliced, designed in parallel, gated before any code.",
		arg: "“a Pi search extension backed by Ollama”",
		stageCount: 32,
		stages: [
			{ name: "capture" },
			{ name: "slice", gate: true, fix: true },
			{ name: "design", fanout: true },
			{ name: "review", human: true },
			{ name: "plan", gate: true, fix: true },
			{ name: "code", gate: true, fix: true },
			{ name: "land" },
		],
		showcase: true,
	},
	{
		name: "vet",
		when: "A diff already exists, yours or a teammate's. Review it, loop a fix cycle until zero blockers remain.",
		arg: "main..HEAD",
		stageCount: 9,
		stages: [
			{ name: "goal" },
			{ name: "code-review" },
			{ name: "blueprint" },
			{ name: "implement", fanout: true },
			{ name: "implement-scope-check" },
			{ name: "scope-quarantine" },
			{ name: "reconcile" },
			{ name: "validate" },
			{ name: "commit" },
		],
		// validate re-reviews; loops the fix cycle until approved.
		loop: { from: 7, to: 1, label: "↺ until approved" },
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
	},
	{
		name: "ship",
		when: "A small, well-understood task. One lightweight forward pass — research up front, a single plan, one grade, stop-on-fail at every gate.",
		arg: "“add a --json flag to the export command”",
		stageCount: 10,
		stages: [
			{ name: "goal" },
			{ name: "research" },
			{ name: "plan" },
			{ name: "plan-cite-check" },
			{ name: "grade" },
			{ name: "implement", fanout: true },
			{ name: "implement-scope-check" },
			{ name: "reconcile" },
			{ name: "validate" },
			{ name: "commit" },
		],
	},
];

/** All four built-in pipelines, the showcase entry selected via `.showcase`. */
export async function getWorkflows(): Promise<WorkflowEntry[]> {
	return [...WORKFLOWS];
}
