/**
 * workflow-test-harness.ts — the shared quartet every built-in workflow test
 * suite imports: the declared skill contracts, the derive-then-validate
 * wrapper, the mutable-copy deriver, and the findWorkflow lookup. Extracted
 * from built-in-workflows.test.ts when its per-module describes moved to
 * co-located twins under built-ins/ — the quartet is the graph-attached seam
 * those twins reach the workflows through.
 *
 * skills/elaborate/_helpers/validate-workflow-invariant.mjs is the plain-JS
 * sync twin of this quartet (same derive-then-validate contract, jiti-loaded)
 * — keep the two in step when the derivation contract changes.
 */

import { validateWorkflow, type Workflow } from "@juicesharp/rpiv-workflow";
import { builtInWorkflows } from "./built-in-workflows.ts";
import { deriveOutcomes } from "./outcome-derivation.ts";
import { BUNDLED_SKILLS_DIR } from "./paths.ts";
import { buildSkillContractsFromFrontmatter } from "./skill-contracts-source.ts";

// Built-ins are validated in production with the declared skill contracts
// threaded in (load/index.ts: buildEffectiveContracts → validateWorkflow). The
// code-review stages carry no inline outputSchema — `blockers_count` is sourced
// from the contract — so the same contracts must be supplied here, or the
// contract-backed routing lint (checkPredicateSchemas) fires a false warning.
export const DECLARED_CONTRACTS = new Map(buildSkillContractsFromFrontmatter(BUNDLED_SKILLS_DIR));

/**
 * Prepare a workflow for validation by deriving contract-sourced outcomes onto
 * a mutable copy. The built-in workflows no longer carry explicit outcomes —
 * they are contract-derived. The deriver must run before validateWorkflow
 * checks the `produces-without-outcome` guard.
 */
export const deriveAndValidate = (
	wf: Workflow,
	opts?: { skillContracts?: Map<string, import("@juicesharp/rpiv-workflow/registration").SkillContract> },
) => {
	return validateWorkflow(withDerivedOutcomes(wf, opts?.skillContracts), opts);
};

/**
 * Create a mutable copy of a workflow with contract-derived outcomes. Used by
 * tests that bypass the loader (passing workflows directly to `runWorkflow`).
 */
export const withDerivedOutcomes = (
	wf: Workflow,
	skillContracts?: Map<string, import("@juicesharp/rpiv-workflow/registration").SkillContract>,
): Workflow => {
	const mutable: Workflow = { ...wf, stages: { ...wf.stages } };
	for (const [name, stage] of Object.entries(wf.stages)) {
		(mutable.stages as Record<string, typeof stage>)[name] = { ...stage };
	}
	deriveOutcomes([mutable], skillContracts ?? DECLARED_CONTRACTS, () => {}, new Map());
	return mutable;
};

export const findWorkflow = (name: string): Workflow => {
	const w = builtInWorkflows.find((x) => x.name === name);
	if (!w) throw new Error(`built-in workflow "${name}" not found`);
	return w;
};
