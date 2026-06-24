// Empirical validation of .rpiv/workflows/packs/ship-slice.ts.
// Replicates loadWorkflows' validation path: build skill contracts from
// rpiv-pi's bundled skills dir, jiti-load the pack, run validateWorkflow
// with the contract map, and surface every issue (code + severity + message).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });

// 1. Build skill contracts from rpiv-pi bundled skills (declared contracts).
const { buildSkillContractsFromFrontmatter } = await jiti.import(
	join(root, "packages/rpiv-pi/extensions/rpiv-core/skill-contracts-source.ts"),
);
const skillsDir = join(root, "packages/rpiv-pi/skills");
const entries = buildSkillContractsFromFrontmatter(skillsDir);
const skillContracts = new Map(entries);
console.log("Loaded skill contracts:", [...skillContracts.keys()].sort().join(", "));

// 2. jiti-load the ship-slice pack.
const packPath = join(root, ".rpiv/workflows/packs/ship-slice.ts");
const wf = await jiti.import(packPath, { default: true });

// A pack default export can be a single Workflow or Workflow[].
const workflows = Array.isArray(wf) ? wf : [wf];
console.log("Loaded workflow(s) from pack:", workflows.map((w) => w.name).join(", "));

// 3. Validate each with the contract map.
const { validateWorkflow } = await jiti.import(join(root, "packages/rpiv-workflow/validate-workflow.ts"));

for (const w of workflows) {
	const issues = validateWorkflow(w, { skillContracts });
	console.log(`\n===== validateWorkflow("${w.name}") → ${issues.length} issue(s) =====`);
	for (const i of issues) {
		console.log(`[${i.severity.toUpperCase()}] ${i.code} — ${i.message}`);
	}
	if (issues.length === 0) console.log("(no issues)");
}
