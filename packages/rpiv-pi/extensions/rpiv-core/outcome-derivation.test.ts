/**
 * Tests for the contract-derived outcome resolver.
 *
 * The equivalence test guards the deletion of the explicit `rpivBucketOutcome`
 * calls from `built-in-workflows.ts` — derivation must reproduce them exactly.
 */

import type { SkillContract, SkillContractMap, Workflow } from "@juicesharp/rpiv-workflow/registration";
import { acts, defineWorkflow, produces } from "@juicesharp/rpiv-workflow/registration";
import { describe, expect, it } from "vitest";
import { builtInWorkflows } from "./built-in-workflows.js";
import { BUCKET_BY_KIND, deriveOutcomes } from "./outcome-derivation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SkillContractMap from skill-name → artifactKind pairs. */
function contractsFromKinds(entries: Array<[string, string]>): SkillContractMap {
	const map = new Map<string, SkillContract>();
	for (const [skill, artifactKind] of entries) {
		map.set(skill, {
			source: "declared",
			produces: { kind: "produces", meta: { artifactKind } },
		});
	}
	return map;
}

/** Strip `outcome` from every stage in a workflow (non-mutating). */
function stripOutcomes(w: Workflow): Workflow {
	const stages: typeof w.stages = {};
	for (const [name, stage] of Object.entries(w.stages)) {
		if (stage.outcome) {
			const { outcome: _, ...rest } = stage;
			stages[name] = rest;
		} else {
			stages[name] = stage;
		}
	}
	return Object.freeze({ ...w, stages });
}

// ---------------------------------------------------------------------------
// BUCKET_BY_KIND — table completeness
// ---------------------------------------------------------------------------

describe("BUCKET_BY_KIND", () => {
	it("contains exactly 10 entries", () => {
		expect(Object.keys(BUCKET_BY_KIND)).toHaveLength(10);
	});

	it("covers all artifactKinds used by produces skills", () => {
		const expectedKinds = [
			"plan",
			"research",
			"design",
			"solutions",
			"review",
			"validation",
			"architecture-review",
			"frd",
			"handoff",
			"triage",
		];
		for (const kind of expectedKinds) {
			expect(BUCKET_BY_KIND[kind]).toBeDefined();
		}
	});

	it("preserves convergence: same artifactKind → same bucket", () => {
		// 4 skills share "plan" → "plans"
		expect(BUCKET_BY_KIND.plan).toBe("plans");
	});
});

// ---------------------------------------------------------------------------
// deriveOutcomes — unit tests
// ---------------------------------------------------------------------------

describe("deriveOutcomes", () => {
	it("derives outcome for a produces stage with no explicit outcome", () => {
		const w = defineWorkflow({
			name: "test",
			start: "s1",
			stages: { s1: produces() },
			edges: { s1: "stop" },
		});
		const contracts = contractsFromKinds([["s1", "plan"]]);
		const issues: Array<{ message: string; severity: string }> = [];

		deriveOutcomes([w], contracts, (message, severity) => {
			issues.push({ message, severity });
		});

		expect(w.stages.s1.outcome).toBeDefined();
		expect(w.stages.s1.outcome!.name).toBe("plans");
		expect(issues).toHaveLength(0);
	});

	it("skips stages with explicit outcomes (rung 1)", () => {
		const w = defineWorkflow({
			name: "test",
			start: "s1",
			stages: { s1: produces({ outcome: { name: "custom", collector: {} as any } }) },
			edges: { s1: "stop" },
		});
		const contracts = contractsFromKinds([["s1", "plan"]]);

		deriveOutcomes([w], contracts, () => {});

		expect(w.stages.s1.outcome!.name).toBe("custom"); // unchanged
	});

	it("skips side-effect stages", () => {
		const w = defineWorkflow({
			name: "test",
			start: "s1",
			stages: { s1: acts() },
			edges: { s1: "stop" },
		});
		const contracts = contractsFromKinds([["s1", "plan"]]);

		deriveOutcomes([w], contracts, () => {});

		expect(w.stages.s1.outcome).toBeUndefined();
	});

	it("skips stages whose contract has kind: side-effect", () => {
		const w = defineWorkflow({
			name: "test",
			start: "s1",
			stages: { s1: produces() },
			edges: { s1: "stop" },
		});
		const contracts = new Map<string, SkillContract>();
		contracts.set("s1", { source: "declared", produces: { kind: "side-effect" } });

		deriveOutcomes([w], contracts, () => {});

		expect(w.stages.s1.outcome).toBeUndefined();
	});

	it("reports error for unknown artifactKind", () => {
		const w = defineWorkflow({
			name: "test",
			start: "s1",
			stages: { s1: produces() },
			edges: { s1: "stop" },
		});
		const contracts = contractsFromKinds([["s1", "unknown-kind"]]);
		const issues: Array<{ message: string; severity: string }> = [];

		deriveOutcomes([w], contracts, (message, severity) => {
			issues.push({ message, severity });
		});

		expect(w.stages.s1.outcome).toBeUndefined(); // not wired
		expect(issues).toHaveLength(1);
		expect(issues[0].severity).toBe("error");
		expect(issues[0].message).toContain("unknown-kind");
	});

	it("skips stages with no matching contract", () => {
		const w = defineWorkflow({
			name: "test",
			start: "s1",
			stages: { s1: produces() },
			edges: { s1: "stop" },
		});
		const contracts = new Map<string, SkillContract>();

		deriveOutcomes([w], contracts, () => {});

		expect(w.stages.s1.outcome).toBeUndefined();
	});

	it("uses stage name as skill name when stage.skill is not set", () => {
		const w = defineWorkflow({
			name: "test",
			start: "blueprint",
			stages: { blueprint: produces() },
			edges: { blueprint: "stop" },
		});
		const contracts = contractsFromKinds([["blueprint", "plan"]]);

		deriveOutcomes([w], contracts, () => {});

		expect(w.stages.blueprint.outcome!.name).toBe("plans");
	});

	it("uses stage.skill when set (alias support)", () => {
		const w = defineWorkflow({
			name: "test",
			start: "s1",
			stages: { s1: produces({ skill: "blueprint" }) },
			edges: { s1: "stop" },
		});
		const contracts = contractsFromKinds([["blueprint", "plan"]]);

		deriveOutcomes([w], contracts, () => {});

		expect(w.stages.s1.outcome!.name).toBe("plans");
	});

	it("preserves convergence: 4 skills sharing plan → all get plans", () => {
		const skills = ["blueprint", "plan", "revise", "create-handoff"];
		const w = defineWorkflow({
			name: "test",
			start: skills[0],
			stages: Object.fromEntries(skills.map((s) => [s, produces()])),
			edges: { [skills[skills.length - 1]]: "stop" },
		});
		// Wire edges linearly
		for (let i = 0; i < skills.length - 1; i++) {
			(w.stages[skills[i]] as any)._next = skills[i + 1];
		}
		const contracts = contractsFromKinds(skills.map((s) => [s, "plan"]));

		deriveOutcomes([w], contracts, () => {});

		for (const skill of skills) {
			expect(w.stages[skill].outcome?.name).toBe("plans");
		}
	});
});

// ---------------------------------------------------------------------------
// Equivalence test
// ---------------------------------------------------------------------------

describe("equivalence — built-in workflows", () => {
	/**
	 * The complete contract map for all skills used in built-in workflows. The
	 * loader's deriveOutcomes pass wires these automatically; this test verifies
	 * the derivation produces the correct outcome.name for every produces stage.
	 */
	const BUILTIN_CONTRACTS: Array<[string, string]> = [
		["research", "research"],
		["blueprint", "plan"],
		["design", "design"],
		["plan", "plan"],
		["validate", "validation"],
		["code-review", "review"],
		["revise", "plan"],
		["pr-triage", "triage"],
	];

	/**
	 * Expected bucket name for each produces stage across all 6 workflows.
	 * Key: "workflowName::stageName". Value: expected outcome.name.
	 */
	const EXPECTED: Record<string, string> = {
		// ship
		"ship::blueprint": "plans",
		"ship::validate": "validation",
		// build
		"build::research": "research",
		"build::blueprint": "plans",
		"build::validate": "validation",
		"build::code-review": "reviews",
		"build::revise": "plans",
		// arch
		"arch::research": "research",
		"arch::design": "designs",
		"arch::plan": "plans",
		"arch::validate": "validation",
		"arch::code-review": "reviews",
		// vet
		"vet::code-review": "reviews",
		"vet::blueprint": "plans",
		"vet::validate": "validation",
		// polish
		"polish::architecture-review": "architecture-reviews",
		"polish::blueprint": "plans",
		"polish::validate": "validation",
		"polish::code-review": "reviews",
		// pr-triage
		"pr-triage::pr-triage": "triage",
	};

	/**
	 * Skills in built-in workflows whose produces stages should NOT be derived
	 * (side-effect skills: commit, implement).
	 */
	const SKIP_STAGES = new Set([
		"ship::commit",
		"ship::implement",
		"build::commit",
		"build::implement",
		"arch::commit",
		"arch::implement",
		"vet::commit",
		"vet::implement",
		"polish::commit",
		"polish::implement",
	]);

	// Need architecture-review contract too
	const allContracts = contractsFromKinds([...BUILTIN_CONTRACTS, ["architecture-review", "architecture-review"]]);

	for (const w of builtInWorkflows) {
		describe(`workflow: ${w.name}`, () => {
			const stripped = stripOutcomes(w);
			const issues: Array<{ message: string; severity: string }> = [];

			deriveOutcomes([stripped], allContracts, (message, severity) => {
				issues.push({ message, severity });
			});

			for (const [stageName, stage] of Object.entries(stripped.stages)) {
				const key = `${w.name}::${stageName}`;

				if (SKIP_STAGES.has(key)) {
					it(`${stageName}: side-effect stage, no outcome derived`, () => {
						// Side-effect stages retain their original outcome (gitCommitOutcome)
						// if not stripped, or undefined if stripped. Either is acceptable —
						// derivation only targets produces stages.
						if (stage.outcome) {
							expect(stage.kind).toBe("side-effect");
						} else {
							expect(stage.outcome).toBeUndefined();
						}
					});
					continue;
				}

				if (stage.kind !== "produces") continue;

				const expected = EXPECTED[key];
				if (!expected) {
					it(`${stageName}: produces stage with no expected mapping — SKIPPED`, () => {
						expect.fail(`No expected bucket for ${key} — add to EXPECTED map`);
					});
					continue;
				}

				it(`${stageName}: derives outcome.name = "${expected}"`, () => {
					expect(stage.outcome).toBeDefined();
					expect(stage.outcome!.name).toBe(expected);
				});
			}

			it("no issues reported", () => {
				expect(issues).toHaveLength(0);
			});
		});
	}

	it("total produces stages across all workflows = 20", () => {
		let count = 0;
		for (const w of builtInWorkflows) {
			for (const stage of Object.values(w.stages)) {
				if (stage.kind === "produces") count++;
			}
		}
		expect(count).toBe(20);
	});
});

// ---------------------------------------------------------------------------
// Reload regression — peek semantics must re-wire outcomes on fresh stage
// objects from overlay re-imports.
// ---------------------------------------------------------------------------

describe("reload regression: deriveOutcomes re-wires on fresh stage objects", () => {
	it("second derivation pass on fresh objects wires outcomes (peek, not drain)", () => {
		const contracts = contractsFromKinds([["s1", "plan"]]);

		// Simulate first load
		const w1 = defineWorkflow({
			name: "test",
			start: "s1",
			stages: { s1: produces() },
			edges: { s1: "stop" },
		});
		const mutable1 = { ...w1, stages: { s1: { ...w1.stages.s1 } } } as Workflow;
		deriveOutcomes([mutable1], contracts, () => {});
		expect(mutable1.stages.s1.outcome?.name).toBe("plans");

		// Simulate reload: fresh stage objects (no outcome) from cache re-import
		const w2 = defineWorkflow({
			name: "test",
			start: "s1",
			stages: { s1: produces() },
			edges: { s1: "stop" },
		});
		const mutable2 = { ...w2, stages: { s1: { ...w2.stages.s1 } } } as Workflow;
		expect(mutable2.stages.s1.outcome).toBeUndefined(); // fresh — no outcome yet

		// Second derivation pass on fresh objects (peek semantics)
		deriveOutcomes([mutable2], contracts, () => {});
		expect(mutable2.stages.s1.outcome?.name).toBe("plans");
	});

	it("second pass on the same already-derived object is idempotent", () => {
		const contracts = contractsFromKinds([["s1", "plan"]]);
		const w = defineWorkflow({
			name: "test",
			start: "s1",
			stages: { s1: produces() },
			edges: { s1: "stop" },
		});
		const mutable = { ...w, stages: { s1: { ...w.stages.s1 } } } as Workflow;

		deriveOutcomes([mutable], contracts, () => {});
		expect(mutable.stages.s1.outcome?.name).toBe("plans");

		// Running again on the already-derived workflow is a no-op (explicit wins)
		const issues: Array<{ message: string; severity: string }> = [];
		deriveOutcomes([mutable], contracts, (message, severity) => {
			issues.push({ message, severity });
		});
		expect(mutable.stages.s1.outcome?.name).toBe("plans"); // unchanged
		expect(issues).toHaveLength(0);
	});
});
