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
 * the per-stage `verify` field reuses `done(verdict)` as its pass gate; `panel()` will compose
 * N judges with a vote fold. Keeping the termination predicate off `Judge`
 * is what makes the concept reusable across all three.
 *
 * Leaf module — value imports are limited to `internal-utils.ts` (the
 * `readSymbol`/`markSymbol` leaf, which is itself runner-free); otherwise
 * type-only. Safe on the runner-free `registration`
 * surface (siblings register built-ins without dragging the runner in).
 */

import type { Artifact } from "./handle.js";
import { markSymbol, readSymbol } from "./internal-utils.js";
import type { Output, RunView } from "./output.js";
import type { Outcome } from "./output-spec.js";

/** Context handed to a dynamic `Judge.prompt`. */
export interface JudgeContext {
	cwd: string;
	/** Latest producer output (also the session's input handle). */
	output: Output;
	/** Frozen stage-entry primary, referenceable; the author embeds it if wanted. */
	entryArtifact: Artifact | undefined;
	state: RunView;
	/** 0-based round index. */
	round: number;
}

/** A judge's dynamic prompt — receives the producer output + round context. */
export type JudgePromptFn = (ctx: JudgeContext) => string | Promise<string>;

/**
 * An `Outcome` whose `name` is REQUIRED — a judge's verdict must publish
 * to its own dedicated `state.named` channel, so the optional-`name` outcome
 * shape isn't enough here.
 */
export interface NamedOutcome extends Outcome {
	name: string;
}

/**
 * Fields shared by both judge dispatch arms.
 *
 * `outcome` validates the verdict and names its dedicated `state.named`
 * channel (its `.name` must differ from the producer outcome's; that
 * collision needs the producer's identity, so it stays a workflow-level
 * check in `validateWorkflow`).
 *
 * ≥1-ARTIFACT CONSTRAINT: the collector MUST materialize at least one
 * artifact (e.g. a JSON verdict file whose parser yields `{ done, feedback }`).
 * A judge session whose collector returns zero artifacts is a **fatal halt**
 * via `enforceCompletionContract` — no retry, no soft-stop.
 */
interface JudgeBase {
	outcome: NamedOutcome;
}

/** Skill dispatch: `/skill:<skill> <producerHandle>` (handle auto-injected). */
export interface SkillJudge extends JudgeBase {
	skill: string;
	/** Structurally absent — skill XOR prompt (both is ambiguous). */
	prompt?: never;
}

/**
 * Raw-prompt dispatch: the session receives only the prompt text, so the
 * author embeds the producer handle/output themselves (via `JudgeContext`
 * for the dynamic form).
 */
export interface PromptJudge extends JudgeBase {
	prompt: string | JudgePromptFn;
	/** Structurally absent — skill XOR prompt (both is ambiguous). */
	skill?: never;
}

/**
 * The reusable judge shape — a union over the two dispatch arms, so
 * skill-XOR-prompt and the named verdict outcome are violations the type
 * system rejects on typed call sites, not just runtime checks. Authored via
 * the `judge()` factory; a hand-rolled object literal (jiti-loaded configs
 * erase TS types) is re-checked defensively at load time by
 * `validateWorkflow` through the same `judgeShapeIssues` rule source —
 * which is why the runtime checks stay.
 */
export type Judge = SkillJudge | PromptJudge;

/**
 * A fold reduces the N member verdicts of a `PanelJudge` to the panel's
 * decision DATA — `unknown` here because the *shape* is path-dependent
 * (canonical `PANEL_VERDICT` vs. a custom author schema), validated downstream
 * by the panel's `outcome`. The fold is pure (the replay contract leans on
 * this: live + resume both recompute it from the durable member rows).
 */
export type FoldFn = (verdicts: readonly Output[]) => unknown;

/**
 * N independent judges plus a vote `fold` — the adversarial-verification
 * generalization of a single `Judge` (Cohere PoLL: a jury beats a self-agreeing
 * judge). `kind: "panel"` is the discriminator; a single `Judge` carries no
 * `kind`, so `isPanel` distinguishes them structurally.
 *
 * `members` is `Judge[]` — each a full `SkillJudge | PromptJudge`, so the whole
 * judge surface (skill XOR prompt, named verdict outcome, dispatch) is reused
 * per member with zero new vocabulary. Nesting is rejected at construction
 * (`members` is NOT `AnyJudge[]`).
 *
 * `outcome` is the canonical-vs-custom switch: ABSENT ⇒ the built-in
 * `PANEL_VERDICT` shape on the `<stage>-panel` channel (sugar fold); PRESENT ⇒
 * the author's schema + channel (raw fold). The two are kept disjoint by a hard
 * XOR enforced by the `panel()` factory — never both.
 */
export interface PanelJudge {
	kind: "panel";
	members: readonly Judge[];
	fold: FoldFn;
	outcome?: NamedOutcome;
}

/**
 * The slot type every judge SITE (`assess`, `verify`, any future judge phase)
 * accepts — a plain `Judge` OR a `PanelJudge`. A single judge is the panel of
 * one: sites reference the judge opaquely and let `panelMembers` expand it, so
 * widening this slot is the ONLY signature change panel support imposes.
 */
export type AnyJudge = Judge | PanelJudge;

/** Discriminate a `PanelJudge` from a single `Judge` (singles carry no `kind`). */
export const isPanel = (j: AnyJudge): j is PanelJudge => (j as PanelJudge).kind === "panel";

/**
 * THE expander — the single place a judge value becomes its member list. A
 * panel yields its `members`; a single judge yields `[judge]` (the panel of
 * one). Every member-walking site (preflight skill registration, introspection,
 * the judge-phase dispatch) routes through this, so single-judge behavior is
 * the degenerate case of the general path by construction.
 */
export const panelMembers = (j: AnyJudge): readonly Judge[] => (isPanel(j) ? j.members : [j]);

/** The sugar-fold constructors — the canonical folds (`majority`/`all`/`any`). */
export type CanonicalFoldName = "majority" | "all" | "any";

/**
 * Brand carrying the SUGAR-fold name (`majority`/`all`/`any`) so consumers can
 * (a) tell a canonical fold from a raw author closure — the structural signal
 * behind the §4 XOR (sugar ⊕ `outcome`) — and (b) report WHICH fold it is in
 * the introspection summary (`panelSpecOf`). `Symbol.for` so it survives
 * `import` boundaries cleanly, matching the `READS_DATA` / `ROUTE_NOTE`
 * precedent.
 *
 * Framework plumbing, not authoring surface — the sugar constructors brand;
 * `panelShapeIssues` / `validateWorkflow` / `panelSpecOf` read. NOT re-exported
 * from `registration.ts`, like `ROUTE_NOTE`.
 */
export const CANONICAL_FOLD: unique symbol = Symbol.for("rpiv.workflow.canonicalFold");

/** True iff `fold` was produced by a sugar constructor (carries the `CANONICAL_FOLD` brand). */
export function marksCanonicalFold(fold: FoldFn): boolean {
	return canonicalFoldName(fold) !== undefined;
}

/** The sugar constructor that produced `fold` (`majority`/`all`/`any`), or `undefined` for a raw author closure. */
export function canonicalFoldName(fold: FoldFn): CanonicalFoldName | undefined {
	return readSymbol<CanonicalFoldName>(fold, CANONICAL_FOLD);
}

/** Attach the `CANONICAL_FOLD` brand (the sugar name) and return the fold — the ONE write site (sugar constructors). */
export function brandCanonicalFold(name: CanonicalFoldName, fold: FoldFn): FoldFn {
	markSymbol(fold, CANONICAL_FOLD, name);
	return fold;
}

/**
 * Single rule source for the judge shape. Returns human-readable violations
 * (empty array = valid). `judge()` throws on the first; `validateWorkflow`
 * maps each to a load issue for hand-rolled literals that bypassed the
 * factory. Takes `unknown` ON PURPOSE: the type system already rejects these
 * shapes on typed call sites (the `Judge` union), so everything reaching this
 * checker is an untyped jiti-loaded literal.
 */
export function judgeShapeIssues(candidate: unknown): string[] {
	if (!candidate || typeof candidate !== "object") return ["a judge object is required"];
	const j = candidate as { skill?: unknown; prompt?: unknown; outcome?: { name?: unknown } };
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
 * THE collect-then-throw-first idiom — one named operation for the
 * `*ShapeIssues(candidate)` → throw-on-first policy the judge/assess/verify/
 * panel factories share. Throws `new Error(`${ctor}(): ${issues[0]}`)` iff the
 * rule source found any violation; the remaining issues are deliberately
 * discarded (one actionable error at the authoring site). The load gate
 * (`validate/stage-rules.ts`) consumes the SAME rule sources via collect-and-
 * report (it does NOT route through here — assertShape owns only the
 * throw-first shape).
 */
export function assertShape(ctor: string, issues: string[]): void {
	if (issues.length > 0) throw new Error(`${ctor}(): ${issues[0]}`);
}

/**
 * Promote a judge literal to a validated `Judge` — identity passthrough that
 * throws on an invalid shape, so a `judge(...)`-authored value is correct by
 * construction (cf. `defineRoute`). Composes into `assess({ judge: judge({...}) })`
 * and `panel(judge({...}), judge({...}))` today.
 */
export function judge(spec: Judge): Judge {
	assertShape("judge", judgeShapeIssues(spec));
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
