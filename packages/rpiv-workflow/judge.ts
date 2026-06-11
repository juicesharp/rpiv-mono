/**
 * Judge — the first-class model-judge concept. A `Judge` names a dispatchable
 * grading session: a **skill** (`/skill:<judge.skill> <producerHandle>`, the
 * latest producer artifact auto-injected as the input handle) or a raw
 * **prompt** (the author embeds the handle/output themselves). Exactly one of
 * `skill` / `prompt` is the dispatch discriminator — enforced at CONSTRUCTION
 * by `judge()` (the `defineRoute` pattern: invalid shapes are unrepresentable
 * past the factory).
 *
 * A judge session runs as a `produces`-kind session so its verdict is
 * VALIDATED by `outcome` and published into its own dedicated
 * `state.named[outcome.name]` channel. What the verdict DECIDES lives on the
 * consuming site, not here: the `assess()` constructor adds `done(verdict)`;
 * the per-stage `verify` field adds `pass(verdict)`; `panel()` will compose
 * N judges with a vote fold. Keeping the termination predicate off `Judge`
 * is what makes the concept reusable across all three.
 *
 * Leaf module — type-only imports; safe on the runner-free `registration`
 * surface (siblings register built-ins without dragging the runner in).
 */

import type { Artifact } from "./handle.js";
import type { Output, OutputSpec } from "./output.js";
import type { RunState } from "./types.js";

/** Context handed to a dynamic `Judge.prompt`. */
export interface JudgeContext {
	cwd: string;
	/** Latest producer output (also the session's input handle). */
	output: Output;
	/** Frozen stage-entry primary, referenceable; the author embeds it if wanted. */
	entryArtifact: Artifact | undefined;
	state: Readonly<RunState>;
	/** 0-based round index. */
	round: number;
}

/**
 * The reusable judge shape. Authored via the `judge()` factory (which
 * validates at construction); a hand-rolled object literal is re-checked
 * defensively at load time by `validateWorkflow` through the same
 * `judgeShapeIssues` rule source.
 */
export interface Judge {
	/** Present → `/skill:<skill>` dispatch (producer handle auto-injected). Absent → raw-prompt dispatch. */
	skill?: string;
	/**
	 * Judge prompt. REQUIRED for a prompt judge (no skill) — a dispatched
	 * session delivers only the prompt text, so the author embeds the producer
	 * handle/output themselves. Must be ABSENT for a skill judge (skill XOR
	 * prompt — both is ambiguous; neither has nothing to dispatch).
	 */
	prompt?: string | ((ctx: JudgeContext) => string | Promise<string>);
	/**
	 * REQUIRED — validates the verdict and names its dedicated `state.named`
	 * channel (its `.name` must differ from the producer outcome's; that
	 * collision needs the producer's identity, so it stays a workflow-level
	 * check in `validateWorkflow`).
	 *
	 * ≥1-ARTIFACT CONSTRAINT: the collector MUST materialize at least one
	 * artifact (e.g. a JSON verdict file whose parser yields `{ done, feedback }`).
	 * A judge session whose collector returns zero artifacts is a **fatal halt**
	 * via `enforceCompletionContract` — no retry, no soft-stop.
	 */
	outcome: OutputSpec;
}

/**
 * Single rule source for the judge shape. Returns human-readable violations
 * (empty array = valid). `judge()` throws on the first; `validateWorkflow`
 * maps each to a load issue for hand-rolled literals that bypassed the
 * factory (jiti-loaded configs erase TS types).
 */
export function judgeShapeIssues(j: Judge | undefined): string[] {
	if (!j || typeof j !== "object") return ["a judge object is required"];
	const issues: string[] = [];
	if (!j.outcome?.name) {
		issues.push("judge.outcome must carry a `name` so the verdict publishes to its own named channel");
	}
	const hasSkill = j.skill !== undefined;
	const hasPrompt = j.prompt !== undefined;
	if (hasSkill && hasPrompt) {
		issues.push("judge sets both `skill` and `prompt` — choose one dispatch (skill XOR prompt)");
	}
	if (!hasSkill && !hasPrompt) {
		issues.push("judge sets neither `skill` nor `prompt` — one is required to dispatch the judge");
	}
	return issues;
}

/**
 * Promote a judge literal to a validated `Judge` — identity passthrough that
 * throws on an invalid shape, so a `judge(...)`-authored value is correct by
 * construction (cf. `defineRoute`). Composes into `assess({ judge: judge({...}) })`
 * today and `panel(judge({...}), judge({...}))` in the follow-up.
 */
export function judge(spec: Judge): Judge {
	const issues = judgeShapeIssues(spec);
	if (issues.length > 0) throw new Error(`judge(): ${issues[0]}`);
	return spec;
}

/**
 * Resolve a static or dynamic `Judge.prompt`. A dynamic prompt may be async.
 * (Moved from loop.ts — the ONE resolver for every Judge dispatch site.)
 */
export async function resolveJudgePrompt(
	prompt: string | ((ctx: JudgeContext) => string | Promise<string>),
	ctx: JudgeContext,
): Promise<string> {
	if (typeof prompt === "string") return prompt;
	return prompt(ctx);
}
