/**
 * Contract-derived outcome resolver for rpiv-pi's built-in workflows.
 *
 * Maps `produces.meta.artifactKind` from the skill contract registry to a
 * bucket name via `BUCKET_BY_KIND`, then auto-wires `rpivBucketOutcome(bucket)`
 * onto `produces` stages that lack an explicit `outcome`. Eliminates the 19
 * manual `rpivBucketOutcome(...)` restatements in `built-in-workflows.ts`.
 *
 * Registered via `registerOutcomeDeriver` (from `@juicesharp/rpiv-workflow/startup`)
 * so the loader invokes it after `buildEffectiveContracts` and before the
 * validation loop — see `load/index.ts`.
 */

import type { OutcomeDeriverFn } from "@juicesharp/rpiv-workflow/registration";
import { rpivBucketOutcome } from "./artifact-collector.js";
import { isModuleNotFound } from "./utils.js";

/**
 * Canonical mapping from a skill's `produces.meta.artifactKind` to the bucket
 * name used in `state.named[bucket]` / `reads: [bucket]`. One entry per
 * `produces`-kind skill. Unknown kinds trigger a `LoadIssue` error via the
 * `onIssue` callback — a silent miss would become a runtime throw in
 * `resolveOutcome` once explicit calls are deleted.
 *
 * Convergence invariant: same artifactKind → same bucket. Four skills share
 * `"plans"` (blueprint, plan, revise, create-handoff).
 */
export const BUCKET_BY_KIND: Readonly<Record<string, string>> = {
	plan: "plans",
	research: "research",
	slices: "slices",
	design: "designs",
	elaboration: "elaborations",
	solutions: "solutions",
	review: "reviews",
	validation: "validation",
	"architecture-review": "architecture-reviews",
	frd: "discover",
	handoff: "handoffs",
	triage: "triage",
};

/**
 * Derive `rpivBucketOutcome(bucket)` for every `produces` stage that lacks an
 * explicit `outcome`, using the skill contract's `produces.meta.artifactKind`
 * and the `BUCKET_BY_KIND` normalization table.
 *
 * Follows `effectiveOutputSchema`'s fallback chain:
 *   1. Explicit `stage.outcome` → skip (already wired)
 *   2. Contract `produces.kind !== "produces"` → skip (side-effect skill)
 *   3. Contract `produces.meta.artifactKind` → look up in `BUCKET_BY_KIND`
 *   4. Found → wire `rpivBucketOutcome(bucket)`
 *   5. Not found → `onIssue(...)` error (unknown kind)
 *   6. No contract / no `produces` / no `meta` → skip (validation catches downstream)
 *
 * Mutates `stage.outcome` in place on qualifying stages.
 */
export const deriveOutcomes: OutcomeDeriverFn = (workflows, skillContracts, onIssue, bucketKindMappings) => {
	// One shadow warning per artifactKind per derivation pass — N stages
	// sharing a kind would otherwise repeat it N times in one load.
	const shadowWarned = new Set<string>();
	for (const w of workflows) {
		for (const [stageName, stage] of Object.entries(w.stages)) {
			// Rung 1: explicit outcome wins — skip
			if (stage.outcome) continue;
			// Only `produces` stages need an outcome — `side-effect` / `acts` are fine without
			if (stage.kind !== "produces") continue;
			// SCRIPT stages can never carry an outcome (the run function IS the
			// envelope — `script-with-outcome` is a load ERROR), so deriving one
			// would break the workflow. PROMPT stages DO derive: a produces prompt
			// stage under a contracted record key collects the same artifact kind
			// the skill would (polish's `validate` relies on this — see the
			// equivalence test in outcome-derivation.test.ts).
			if (stage.run != null) continue;

			const skillName = stage.skill ?? stageName;
			const contract = skillContracts.get(skillName);

			// No contract or contract doesn't declare `produces` — skip;
			// validate-workflow.ts:242 will catch produces-without-outcome
			if (!contract?.produces) continue;

			// Side-effect skill registered as `produces` in a stage — skip
			if (contract.produces.kind !== "produces") continue;

			const artifactKind = (contract.produces.meta as { artifactKind?: unknown } | undefined)?.artifactKind;
			if (typeof artifactKind !== "string") {
				// Contract has no artifactKind — the stage will fail validation.
				// This is not an error we can fix here; skip silently.
				continue;
			}

			const registered = bucketKindMappings.get(artifactKind);
			const hardcoded = BUCKET_BY_KIND[artifactKind];
			// A registered mapping that redirects a built-in kind silently
			// reroutes where every stage of that kind publishes — consumers
			// reading the canonical bucket (`reads: ["<hardcoded>"]`) would
			// halt at runtime with a missing named read, far from the cause.
			// Surface the redirect at load time, where it is actionable.
			if (
				registered !== undefined &&
				hardcoded !== undefined &&
				registered !== hardcoded &&
				!shadowWarned.has(artifactKind)
			) {
				shadowWarned.add(artifactKind);
				onIssue(
					`outcome derivation: registered bucket mapping "${artifactKind}" → "${registered}" overrides the ` +
						`built-in bucket "${hardcoded}" — workflows reading "${hardcoded}" will not see artifacts ` +
						`published under this kind`,
					"warning",
				);
			}
			const bucket = registered ?? hardcoded;
			if (!bucket) {
				onIssue(
					`outcome derivation: skill "${skillName}" declares artifactKind "${artifactKind}" ` +
						`but no bucket mapping exists for it — register one via registerBucketKindMapping or add to BUCKET_BY_KIND`,
					"error",
				);
				continue;
			}

			// Wire the full Outcome (name + collector + parser)
			stage.outcome = rpivBucketOutcome(bucket);
		}
	}
};

/**
 * Register the outcome deriver with rpiv-workflow's loader. Called from
 * `registerSkillContractsSource()` so the deriver is available before the
 * first `/wf load`. Dynamic-imports rpiv-workflow (sibling may be absent).
 */
export async function registerOutcomeDerivation(): Promise<void> {
	try {
		const { registerOutcomeDeriver } = await import("@juicesharp/rpiv-workflow/startup");
		registerOutcomeDeriver(deriveOutcomes);
	} catch (err) {
		if (isModuleNotFound(err)) return; // sibling absent — /rpiv-setup prompts the user
		throw err;
	}
}
