#!/usr/bin/env node
// validate-workflow-invariant.mjs — self-check helper for the elaborate skill.
//
// Invoked by the elaborate Self-check step ONLY when a phase's write-set
// includes packages/rpiv-pi/extensions/rpiv-core/built-in-workflows.ts. It
// re-derives the effective skill contracts + contract-sourced outcomes onto
// the LIVE built-in workflows and runs validateWorkflow over each, exiting 1
// with one `<workflow>: [<code>] <message>` line per error OR warning issue
// (e.g. the route-reads-unvalidated-data rule from checkPredicateSchemas at
// packages/rpiv-workflow/validate/contract-compat.ts:50). Clean tree → exit 0.
//
// Reads only — writes nothing to the tree. The harness mirrors the
// withDerivedOutcomes / deriveAndValidate helpers in
// packages/rpiv-pi/extensions/rpiv-core/built-in-workflows.test.ts, so the
// contract-derived outcomes are threaded before validateWorkflow runs (the
// built-ins carry no inline outputSchema/outcomes — they are contract-sourced,
// via buildSkillContractsFromFrontmatter(BUNDLED_SKILLS_DIR)).
//
// All sources are .ts (this monorepo is noEmit); loaded via jiti (a direct dep
// of both @juicesharp/rpiv-pi and @juicesharp/rpiv-workflow). jiti is created
// from this file so its resolver walks node_modules upward from
// _helpers/ → .../packages/rpiv-pi/skills/elaborate/_helpers and finds the
// root-workspace @juicesharp/rpiv-workflow symlink. Module cache ON (default):
// the bare-specifier import and the transitive import built-in-workflows.ts
// makes resolve to one shared module instance.

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url);

// rpiv-core extension sources, resolved relative to this helper
// (_helpers/ → elaborate/ → skills/ → rpiv-pi/ → extensions/rpiv-core/).
const CORE = fileURLToPath(new URL("../../../extensions/rpiv-core/", import.meta.url));

// Five jiti.imports — bare specifier (rpiv-workflow → validateWorkflow) plus
// four absolute .ts paths. The returned namespace exposes the named exports
// directly (no { default: true }); verified at runtime against jiti 2.7.0.
let builtInWorkflows;
let validateWorkflow;
let buildSkillContractsFromFrontmatter;
let deriveOutcomes;
let BUNDLED_SKILLS_DIR;
try {
	({ builtInWorkflows } = await jiti.import(`${CORE}built-in-workflows.ts`));
	({ validateWorkflow } = await jiti.import("@juicesharp/rpiv-workflow"));
	({ buildSkillContractsFromFrontmatter } = await jiti.import(`${CORE}skill-contracts-source.ts`));
	({ deriveOutcomes } = await jiti.import(`${CORE}outcome-derivation.ts`));
	({ BUNDLED_SKILLS_DIR } = await jiti.import(`${CORE}paths.ts`));
} catch (err) {
	process.stderr.write(`validate-workflow-invariant: failed to load modules: ${err?.stack ?? err}\n`);
	process.exit(1);
}

// Declared skill contracts threaded from the bundled skills dir — mirrors
// built-in-workflows.test.ts DECLARED_CONTRACTS. Without these, the
// contract-backed routing lint (checkPredicateSchemas) fires false warnings on
// dispatching stages whose produces.data schema is sourced from the contract,
// not declared inline as outputSchema.
const DECLARED_CONTRACTS = new Map(buildSkillContractsFromFrontmatter(BUNDLED_SKILLS_DIR));

// Derive contract-sourced outcomes onto a mutable copy of a workflow, mirroring
// built-in-workflows.test.ts withDerivedOutcomes. Deriving on a (shallow) copy
// keeps the shared builtInWorkflows constant untouched across the loop.
const withDerivedOutcomes = (wf) => {
	const mutable = { ...wf, stages: { ...wf.stages } };
	for (const [name, stage] of Object.entries(wf.stages)) mutable.stages[name] = { ...stage };
	deriveOutcomes([mutable], DECLARED_CONTRACTS, () => {}, new Map());
	return mutable;
};

let failed = 0;
for (const wf of builtInWorkflows) {
	const issues = validateWorkflow(withDerivedOutcomes(wf), { skillContracts: DECLARED_CONTRACTS });
	for (const issue of issues) {
		// Errors AND warnings. route-reads-unvalidated-data — this helper's
		// flagship defect — is itself a warning (issue.ts:244), and the
		// mirrored deriveAndValidate harness asserts 0 errors AND 0 warnings
		// on clean built-ins (built-in-workflows.test.ts:508). Gating on
		// error-only would let the named defect slip through green.
		if (issue.severity !== "error" && issue.severity !== "warning") continue;
		failed += 1;
		const where = issue.stage ? ` (${issue.stage})` : "";
		process.stdout.write(`${issue.workflow}${where}: [${issue.code}] ${issue.message}\n`);
	}
}

process.exit(failed === 0 ? 0 : 1);
