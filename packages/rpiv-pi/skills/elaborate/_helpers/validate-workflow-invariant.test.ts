// validate-workflow-invariant.test.ts — smoke test for the elaborate self-check
// helper. Case (1) spawns the .mjs (mirrors skills/_shared/stitch-elaborations.
// test.ts: execFileSync("node", [HELPER_MJS])) and asserts exit 0 on the clean
// tree — the live proof that the helper's five jiti.import resolutions (bare
// @juicesharp/rpiv-workflow + four absolute rpiv-core .ts paths — risk c2r3)
// hold at runtime. Case (2) exercises the SAME harness+gate the .mjs mirrors
// against a deliberately-broken workflow and asserts route-reads-unvalidated-
// data surfaces — proving the gate logic the .mjs wraps catches the defect.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acts, defineRoute, defineWorkflow, validateWorkflow, type Workflow } from "@juicesharp/rpiv-workflow";
import { describe, expect, it } from "vitest";
import { deriveOutcomes } from "../../../extensions/rpiv-core/outcome-derivation.js";
import { BUNDLED_SKILLS_DIR } from "../../../extensions/rpiv-core/paths.js";
import { buildSkillContractsFromFrontmatter } from "../../../extensions/rpiv-core/skill-contracts-source.js";

const HELPER_MJS = fileURLToPath(new URL("./validate-workflow-invariant.mjs", import.meta.url));

// execFileSync throws on non-zero exit; surface status + stdout + stderr so a
// regression surfaces both streams for diagnosis.
const runHelper = (): { status: number; stdout: string; stderr: string } => {
	try {
		const stdout = execFileSync("node", [HELPER_MJS], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, stdout, stderr: "" };
	} catch (err) {
		const e = err as { status?: number; stdout?: string; stderr?: string };
		return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
	}
};

// The harness the .mjs mirrors verbatim (built-in-workflows.test.ts:61/:72):
// declared contracts from the bundled skills dir + contract-derived outcomes
// threaded before validateWorkflow, or the contract-backed routing lint
// (checkPredicateSchemas) fires false positives on dispatching stages.
const DECLARED_CONTRACTS = new Map(buildSkillContractsFromFrontmatter(BUNDLED_SKILLS_DIR));
const withDerivedOutcomes = (wf: Workflow): Workflow => {
	const mutable: Workflow = { ...wf, stages: { ...wf.stages } };
	for (const [name, stage] of Object.entries(wf.stages))
		(mutable.stages as Record<string, typeof stage>)[name] = { ...stage };
	deriveOutcomes([mutable], DECLARED_CONTRACTS, () => {}, new Map());
	return mutable;
};

describe("validate-workflow-invariant helper", () => {
	it("exits 0 on the clean tree (every jiti resolution holds, every built-in validates)", () => {
		// A non-zero status means a jiti resolution failed (c2r3) OR a built-in
		// regressed; the helper prints one `<workflow>: [<code>] <message>` line
		// per error/warning on exit 1 — both streams stay empty on green.
		expect(runHelper()).toEqual({ status: 0, stdout: "", stderr: "" });
	}, 30_000);

	it("surfaces route-reads-unvalidated-data when a built-in is broken (the gate logic the .mjs wraps)", () => {
		// Minimal broken workflow: an `acts` (prompt) stage has no outputSchema
		// and no dispatching skill contract, but its edge is a defineRoute that
		// reads output.data → checkPredicateSchemas (contract-compat.ts:50) fires
		// route-reads-unvalidated-data. This is the defect class the helper
		// exists to catch; verified it is a WARNING (issue.ts:244), which is why
		// the helper gates on error OR warning (see Notes / Deferred).
		const broken = defineWorkflow({
			name: "broken-test",
			start: "probe",
			stages: { probe: acts({ run: () => {} }) },
			edges: { probe: defineRoute(["stop"], ({ output }) => (output?.data ? "stop" : "stop")) },
		});
		const issues = validateWorkflow(withDerivedOutcomes(broken), {
			skillContracts: DECLARED_CONTRACTS,
		});
		const defect = issues.find((i) => i.code === "route-reads-unvalidated-data");
		expect(defect, "route-reads-unvalidated-data must surface on the broken workflow").toBeTruthy();
		expect(defect?.severity).toBe("warning");
		expect(defect?.stage).toBe("probe");
	});
});
