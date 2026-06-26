/**
 * Tests for `validateWorkflow` — load-time graph checks.
 *
 * Each test builds a small `Workflow` by hand and asserts the issues it
 * produces. The built-in workflows get a smoke pass (zero errors expected).
 */

import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ActsScriptFn,
	acts,
	defineRoute,
	defineWorkflow,
	type EdgeFn,
	fanin,
	gate,
	type LoopDef,
	match,
	type ProducesScriptFn,
	produces as producesRaw,
	type ScriptContext,
	type StageDef,
	terminal,
	type VerifySpec,
	type Workflow,
} from "./api.js";
import { judge } from "./judge.js";
import { assess, fanout, iterate, majority, panel, verify } from "./loop-constructors.js";
import { noopCollector } from "./outcomes/index.js";
import { eq, gt } from "./predicates.js";
import type { CompositionComparator, SkillContractMap } from "./skill-contract.js";
import { __resetSkillContracts, registerCompositionComparator } from "./skill-contracts/index.js";
import { typeboxSchema } from "./typebox-adapter.js";
import { validateWorkflow } from "./validate-workflow.js";

// `produces` stages require an outcome (validated at load time). These
// tests focus on graph-shape validation, so we wire a noop collector into
// every `produces()` so the outcome-presence check passes and the test
// fixture exercises the rule it actually cares about.
const STUB_ARTIFACT_OUTCOME = { collector: noopCollector };
const produces = (overrides: Partial<StageDef> = {}): StageDef =>
	producesRaw({ outcome: STUB_ARTIFACT_OUTCOME, ...overrides } as Partial<StageDef>);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const errors = (w: Workflow) => validateWorkflow(w).filter((i) => i.severity === "error");
const warnings = (w: Workflow) => validateWorkflow(w).filter((i) => i.severity === "warning");

// ---------------------------------------------------------------------------
// Happy path — clean small workflow
// ---------------------------------------------------------------------------

describe("validateWorkflow — happy path", () => {
	it("returns zero errors for a clean linear workflow", () => {
		const w = defineWorkflow({
			name: "tiny",
			start: "a",
			stages: { a: produces(), b: acts() },
			edges: { a: "b", b: "stop" },
		});
		expect(errors(w)).toEqual([]);
	});

	// "Validate the bundled workflows" tests live in @juicesharp/rpiv-pi's
	// built-in-workflows.test.ts — rpiv-workflow ships no built-ins.
});

// ---------------------------------------------------------------------------
// start stage checks
// ---------------------------------------------------------------------------

describe("validateWorkflow — start", () => {
	it("errors when start is not in stages", () => {
		const w: Workflow = {
			name: "bad-start",
			start: "ghost",
			stages: { a: produces() },
			edges: { a: "stop" },
		};
		const e = errors(w);
		expect(e).toHaveLength(1);
		expect(e[0]!.code).toBe("start-stage-missing");
		expect(e[0]!.params).toEqual({ start: "ghost" });
	});
});

// ---------------------------------------------------------------------------
// edge-key checks
// ---------------------------------------------------------------------------

describe("validateWorkflow — edge keys", () => {
	it("errors when an edges key isn't a declared stage", () => {
		const w: Workflow = {
			name: "stray-edge",
			start: "a",
			stages: { a: produces() },
			edges: { a: "stop", phantom: "a" },
		};
		const e = errors(w);
		expect(e.some((i) => i.code === "edge-key-unknown" && i.stage === "phantom")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// edge-target checks
// ---------------------------------------------------------------------------

describe("validateWorkflow — edge targets", () => {
	it("errors when a string target isn't a declared stage", () => {
		const w: Workflow = {
			name: "bad-target",
			start: "a",
			stages: { a: produces(), b: produces() },
			edges: { a: "missing", b: "stop" },
		};
		const e = errors(w);
		expect(e.some((i) => i.stage === "a" && i.code === "edge-target-unknown" && i.params.target === "missing")).toBe(
			true,
		);
	});

	it('accepts "stop" as a terminal target', () => {
		const w: Workflow = {
			name: "leaf",
			start: "a",
			stages: { a: produces() },
			edges: { a: "stop" },
		};
		expect(errors(w)).toEqual([]);
	});

	it("checks every branch of an EdgeFn via .targets metadata", () => {
		const w: Workflow = {
			name: "predicate",
			start: "a",
			stages: { a: produces(), good: produces() },
			// gate writes .targets = ["good", "bad"] — "bad" isn't a declared stage.
			edges: { a: gate("count", { good: gt(0), bad: eq(0) }, "bad"), good: "stop" },
		};
		const e = errors(w);
		expect(e.some((i) => i.code === "edge-target-unknown" && i.params.target === "bad")).toBe(true);
	});

	it("errors on an EdgeFn without .targets metadata (no probe fallback)", () => {
		// A hand-rolled EdgeFn that skips `defineRoute` / `gate` carries
		// no `.targets` annotation. validate-workflow.ts refuses to probe — the missing
		// metadata makes reachability + status-line totals structurally unsound.
		const handCrafted: EdgeFn = () => "ghost";
		const w: Workflow = {
			name: "naked",
			start: "a",
			stages: { a: produces() },
			edges: { a: handCrafted },
		};
		const e = errors(w);
		expect(e.some((i) => i.code === "edge-fn-no-targets")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// missing-edge warnings
// ---------------------------------------------------------------------------

describe("validateWorkflow — implicit terminals", () => {
	it('warns on stages with no edge entry (suggest `: "stop"`)', () => {
		const w: Workflow = {
			name: "implicit",
			start: "a",
			stages: { a: produces(), b: produces() },
			edges: { a: "b" }, // b has no edge — implicit terminal
		};
		const w2 = warnings(w);
		expect(w2.some((i) => i.stage === "b" && i.code === "edge-missing")).toBe(true);
	});

	it('does not warn when terminal is declared with "stop"', () => {
		const w: Workflow = {
			name: "explicit",
			start: "a",
			stages: { a: produces(), b: produces() },
			edges: { a: "b", b: "stop" },
		};
		expect(warnings(w)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

describe("validateWorkflow — reachability", () => {
	it("warns on orphan stages unreachable from start", () => {
		const w: Workflow = {
			name: "orphan",
			start: "a",
			stages: { a: produces(), b: produces(), orphan: produces() },
			edges: { a: "b", b: "stop", orphan: "stop" },
		};
		const w2 = warnings(w);
		expect(w2.some((i) => i.stage === "orphan" && i.code === "stage-unreachable" && i.params.start === "a")).toBe(
			true,
		);
	});

	it("treats EdgeFn branches as reachable via .targets metadata", () => {
		const w: Workflow = {
			name: "branching",
			start: "a",
			stages: { a: produces(), x: produces(), y: produces() },
			// Both x and y are reachable through the gate.
			edges: { a: gate("count", { x: gt(0), y: eq(0) }, "y"), x: "stop", y: "stop" },
		};
		const w2 = warnings(w);
		expect(w2.find((i) => i.code === "stage-unreachable")).toBeUndefined();
	});

	it("treats `match` branches (incl. fallback) as reachable via .targets metadata", () => {
		const w: Workflow = {
			name: "panel-route",
			start: "screen",
			stages: { screen: produces(), escalate: produces(), keep: produces() },
			// match on the published panel verdict: `tie` → escalate, otherwise → keep.
			// Both branch + fallback targets must enumerate so neither orphans.
			edges: {
				screen: match("tie", { escalate: true }, { fallback: "keep", from: "screen-panel" }),
				escalate: "stop",
				keep: "stop",
			},
		};
		const issues = validateWorkflow(w);
		expect(issues.filter((i) => i.code === "stage-unreachable")).toEqual([]);
		expect(issues.filter((i) => i.severity === "error")).toEqual([]);
	});

	it("flags a `match` target that is not a declared stage (static edge-target check)", () => {
		const w: Workflow = {
			name: "panel-route-bad",
			start: "screen",
			stages: { screen: produces(), keep: produces() },
			// `escalate` is undeclared — the static edge-target check sees it via .targets.
			edges: {
				screen: match("tie", { escalate: true }, { fallback: "keep", from: "screen-panel" }),
				keep: "stop",
			},
		};
		expect(errors(w).some((i) => i.code === "edge-target-unknown" && i.params.target === "escalate")).toBe(true);
	});

	it("treats a back-edge cycle as reachable (e.g. revise loop)", () => {
		const w: Workflow = {
			name: "loop",
			start: "implement",
			stages: {
				implement: acts(),
				validate: produces(),
				revise: produces(),
				commit: acts(),
			},
			edges: {
				implement: "validate",
				validate: gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
				revise: "implement", // back-edge
				commit: "stop",
			},
		};
		const issues = validateWorkflow(w);
		expect(issues.filter((i) => i.severity === "error")).toEqual([]);
		expect(issues.filter((i) => i.code === "stage-unreachable")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Semantic checks — restored from the old validateDag
// ---------------------------------------------------------------------------

describe("validateWorkflow — semantic stage constraints", () => {
	const baseWithStage = (overrides: Partial<import("./api.js").StageDef>): Workflow => ({
		name: "semantic",
		start: "a",
		stages: { a: { ...produces(), ...overrides } as StageDef },
		edges: { a: "stop" },
	});

	it("errors on maxRetries below the floor", () => {
		const issues = validateWorkflow(baseWithStage({ maxRetries: 0 }));
		expect(issues.some((i) => i.code === "max-retries-out-of-range" && i.params.value === 0)).toBe(true);
	});

	it("errors on maxRetries above the ceiling", () => {
		const issues = validateWorkflow(baseWithStage({ maxRetries: 100 }));
		expect(issues.some((i) => i.code === "max-retries-out-of-range" && i.params.value === 100)).toBe(true);
	});

	it("errors on validateTimeoutMs out of range", () => {
		const issues = validateWorkflow(baseWithStage({ validateTimeoutMs: 0 }));
		expect(issues.some((i) => i.code === "validate-timeout-out-of-range" && i.params.value === 0)).toBe(true);
	});

	it("errors on unknown onInvalid value", () => {
		const issues = validateWorkflow(baseWithStage({ onInvalid: "burn-it-down" as unknown as "retry" | "halt" }));
		expect(issues.some((i) => i.code === "on-invalid-unknown" && i.params.value === "burn-it-down")).toBe(true);
	});

	it("accepts the documented onInvalid values", () => {
		expect(validateWorkflow(baseWithStage({ onInvalid: "retry" })).filter((i) => i.severity === "error")).toEqual([]);
		expect(validateWorkflow(baseWithStage({ onInvalid: "halt" })).filter((i) => i.severity === "error")).toEqual([]);
	});

	it("errors on unknown kind", () => {
		const issues = validateWorkflow(baseWithStage({ kind: "burn-it" as unknown as "produces" }));
		expect(issues.some((i) => i.code === "stage-kind-unknown" && i.params.value === "burn-it")).toBe(true);
	});

	it("errors on unknown sessionPolicy", () => {
		const issues = validateWorkflow(baseWithStage({ sessionPolicy: "lingering" as unknown as "fresh" }));
		expect(issues.some((i) => i.code === "session-policy-unknown" && i.params.value === "lingering")).toBe(true);
	});

	it("warns when inheritsArtifacts: false is set on a produces stage", () => {
		// The flag is the `terminal()` factory's mechanism — meaningful only
		// for side-effect stages. Setting it on `produces` does nothing.
		const issues = validateWorkflow(baseWithStage({ inheritsArtifacts: false }));
		expect(issues.some((i) => i.code === "inherits-artifacts-on-produces")).toBe(true);
	});

	it("does NOT warn when inheritsArtifacts: false is set on a side-effect stage", () => {
		const w: Workflow = {
			name: "term",
			start: "a",
			stages: { a: acts({ inheritsArtifacts: false }) },
			edges: { a: "stop" },
		};
		expect(warnings(w).filter((i) => i.code === "inherits-artifacts-on-produces")).toEqual([]);
	});
});

describe("validateWorkflow — route-edge schema check", () => {
	it("warns when a route edge reads from a stage without outputSchema", () => {
		const w: Workflow = {
			name: "naked",
			start: "code-review",
			stages: { "code-review": produces(), revise: produces(), commit: acts() },
			edges: {
				"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
				revise: "commit",
				commit: "stop",
			},
		};
		const issues = validateWorkflow(w);
		expect(issues.some((i) => i.code === "route-reads-unvalidated-data" && i.stage === "code-review")).toBe(true);
	});

	it("does NOT warn when defineRoute is called with readsData: false", () => {
		// `{ readsData: false }` skips the READS_DATA marker — the schema
		// warning is exclusively for routes that consult `output.data[field]`.
		// A state-derived route is exempt.
		const w: Workflow = {
			name: "state-derived",
			start: "code-review",
			stages: { "code-review": produces(), a: produces(), b: produces() },
			edges: {
				"code-review": defineRoute(["a", "b"], ({ state }) => (state.named["code-review"] ? "a" : "b"), {
					readsData: false,
				}),
				a: "stop",
				b: "stop",
			},
		};
		const issues = validateWorkflow(w);
		expect(issues.filter((i) => i.code === "route-reads-unvalidated-data")).toEqual([]);
	});

	it("DOES warn when a hand-rolled defineRoute reads output.data with no upstream outputSchema", () => {
		// defineRoute defaults to readsData: true, so any hand-rolled route
		// that reads output.data on a stage without outputSchema trips the
		// lint — closing the gap where the marker was opt-in.
		const w: Workflow = {
			name: "data-read",
			start: "code-review",
			stages: { "code-review": produces(), a: produces(), b: produces() },
			edges: {
				"code-review": defineRoute(["a", "b"], ({ output }) =>
					(output?.data as Record<string, unknown> | undefined)?.status === "ok" ? "a" : "b",
				),
				a: "stop",
				b: "stop",
			},
		};
		const issues = validateWorkflow(w);
		expect(issues.some((i) => i.code === "route-reads-unvalidated-data" && i.stage === "code-review")).toBe(true);
	});

	it("does not warn when the route source carries an outputSchema", () => {
		const w: Workflow = {
			name: "clothed",
			start: "code-review",
			stages: {
				"code-review": produces({
					outputSchema: typeboxSchema(Type.Object({ severeIssueCount: Type.Integer({ minimum: 0 }) })),
				}),
				revise: produces(),
				commit: acts(),
			},
			edges: {
				"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
				revise: "commit",
				commit: "stop",
			},
		};
		const issues = validateWorkflow(w);
		expect(issues.filter((i) => i.code === "route-reads-unvalidated-data")).toEqual([]);
	});

	it("does not warn when the route source is backed only by a contract produces.data", () => {
		// No stage outputSchema — the field is sourced from the skill's contract
		// produces.data at runtime (effectiveOutputSchema), so the route still
		// fires on validated data. Must NOT warn.
		const contracts: SkillContractMap = new Map([
			[
				"code-review",
				{
					source: "declared",
					produces: {
						kind: "produces",
						data: { type: "object", properties: { severeIssueCount: { type: "integer" } } },
					},
				},
			],
		]);
		const w: Workflow = {
			name: "contract-backed",
			start: "code-review",
			stages: { "code-review": produces(), revise: produces(), commit: acts() },
			edges: {
				"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
				revise: "commit",
				commit: "stop",
			},
		};
		const issues = validateWorkflow(w, { skillContracts: contracts });
		expect(issues.filter((i) => i.code === "route-reads-unvalidated-data")).toEqual([]);
	});

	it("still warns when neither outputSchema nor a contract covers the route source", () => {
		// A contract exists for a DIFFERENT skill — the routed stage's own skill
		// has no produces.data, so the warning must still fire.
		const contracts: SkillContractMap = new Map([
			["unrelated", { source: "declared", produces: { kind: "produces", data: { type: "object" } } }],
		]);
		const w: Workflow = {
			name: "uncovered",
			start: "code-review",
			stages: { "code-review": produces(), revise: produces(), commit: acts() },
			edges: {
				"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
				revise: "commit",
				commit: "stop",
			},
		};
		const issues = validateWorkflow(w, { skillContracts: contracts });
		expect(issues.some((i) => i.code === "route-reads-unvalidated-data" && i.stage === "code-review")).toBe(true);
	});

	it("a SCRIPT stage is not exempted by a contract under its record key (C2)", () => {
		// "code-review" carries a covering contract — but the stage runs a script
		// and never dispatches the skill, so the contract must not exempt it.
		const contracts: SkillContractMap = new Map([
			[
				"code-review",
				{
					source: "declared",
					produces: {
						kind: "produces",
						data: { type: "object", properties: { severeIssueCount: { type: "integer" } } },
					},
				},
			],
		]);
		const scriptReview: ProducesScriptFn = async () => ({ kind: "artifacts", artifacts: [], data: {} });
		const w: Workflow = {
			name: "script-routed",
			start: "code-review",
			stages: {
				"code-review": { kind: "produces", sessionPolicy: "fresh", run: scriptReview },
				revise: produces(),
				commit: acts(),
			},
			edges: {
				"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
				revise: "commit",
				commit: "stop",
			},
		};
		const issues = validateWorkflow(w, { skillContracts: contracts });
		expect(issues.some((i) => i.code === "route-reads-unvalidated-data" && i.stage === "code-review")).toBe(true);
	});
});

describe("validateWorkflow — reads-channel (meta) compatibility", () => {
	afterEach(() => __resetSkillContracts());

	const kindComparator: CompositionComparator = (produces, consumes, ch) => {
		const want = (consumes.reads?.[ch]?.meta as { artifactKind?: string } | undefined)?.artifactKind;
		const got = (produces.meta as { artifactKind?: string } | undefined)?.artifactKind;
		return !want || !got || want === got ? { ok: true } : { ok: false, reason: "artifactKind mismatch" };
	};

	const wf: Workflow = {
		name: "reads-compat",
		start: "blueprint",
		stages: {
			blueprint: produces({ outcome: { collector: noopCollector, name: "plans" } }),
			implement: acts({ reads: ["plans"] }),
		},
		edges: { blueprint: "implement", implement: "stop" },
	};
	const contractsWith = (producerKind: string, consumerKind: string): SkillContractMap =>
		new Map([
			["blueprint", { source: "declared", produces: { kind: "produces", meta: { artifactKind: producerKind } } }],
			[
				"implement",
				{ source: "declared", consumes: { reads: { plans: { meta: { artifactKind: consumerKind } } } } },
			],
		]);

	it("ERRORS when a publisher's artifactKind is disjoint from the channel's required kind", () => {
		registerCompositionComparator("plans", kindComparator);
		const issues = validateWorkflow(wf, { skillContracts: contractsWith("design", "plan") });
		expect(
			issues.some(
				(i) =>
					i.code === "reads-channel-incompatible" &&
					i.params.channel === "plans" &&
					i.params.producer === "blueprint",
			),
		).toBe(true);
	});

	it("does NOT error when kinds match", () => {
		registerCompositionComparator("plans", kindComparator);
		const issues = validateWorkflow(wf, { skillContracts: contractsWith("plan", "plan") });
		expect(
			issues.filter((i) => i.code === "reads-channel-incompatible" || i.code === "reads-comparator-threw"),
		).toEqual([]);
	});

	it("degrades (no error) when no comparator is registered for the channel", () => {
		const issues = validateWorkflow(wf, { skillContracts: contractsWith("design", "plan") });
		expect(
			issues.filter((i) => i.code === "reads-channel-incompatible" || i.code === "reads-comparator-threw"),
		).toEqual([]);
	});

	it("degrades (no error) when the publisher is unsigned", () => {
		registerCompositionComparator("plans", kindComparator);
		// consumer signed + requires plan; producer (blueprint) absent from registry → degrade
		const issues = validateWorkflow(wf, {
			skillContracts: new Map([
				["implement", { source: "declared", consumes: { reads: { plans: { meta: { artifactKind: "plan" } } } } }],
			]),
		});
		expect(
			issues.filter((i) => i.code === "reads-channel-incompatible" || i.code === "reads-comparator-threw"),
		).toEqual([]);
	});

	it("surfaces a comparator throw as a WARNING instead of silently disabling the gate (C13)", () => {
		registerCompositionComparator("plans", () => {
			throw new Error("comparator bug");
		});
		const issues = validateWorkflow(wf, { skillContracts: contractsWith("design", "plan") });
		const warn = issues.find((i) => i.code === "reads-comparator-threw" && i.params.channel === "plans");
		expect(warn).toBeDefined();
		expect(warn?.params.error).toContain("comparator bug");
		// The throw degrades — never a false reads-compat error.
		expect(issues.filter((i) => i.code === "reads-channel-incompatible")).toEqual([]);
	});

	it("a SCRIPT consumer named after a signed skill does not inherit its contract (C2)", () => {
		registerCompositionComparator("plans", kindComparator);
		const scriptConsumer: Workflow = {
			name: "script-consumer",
			start: "blueprint",
			stages: {
				blueprint: produces({ outcome: { collector: noopCollector, name: "plans" } }),
				// Record key "implement" matches the signed (and DISJOINT) consumer
				// contract — but this stage runs a script, it never dispatches the skill.
				implement: { kind: "side-effect", sessionPolicy: "fresh", run: async () => {}, reads: ["plans"] },
			},
			edges: { blueprint: "implement", implement: "stop" },
		};
		const issues = validateWorkflow(scriptConsumer, { skillContracts: contractsWith("design", "plan") });
		expect(
			issues.filter((i) => i.code === "reads-channel-incompatible" || i.code === "reads-comparator-threw"),
		).toEqual([]);
		expect(issues.filter((i) => i.severity === "error")).toEqual([]);
	});

	it("a PROMPT publisher named after a signed skill is not a phantom signed publisher (C2)", () => {
		registerCompositionComparator("plans", kindComparator);
		const promptPublisher: Workflow = {
			name: "prompt-publisher",
			start: "blueprint",
			stages: {
				// Record key "blueprint" matches a signed contract whose artifactKind
				// is DISJOINT from the consumer's requirement — but the stage
				// dispatches raw prompt text, not /skill:blueprint.
				blueprint: {
					kind: "produces",
					sessionPolicy: "fresh",
					prompt: "draft the plan",
					outcome: { collector: noopCollector, name: "plans" },
				},
				implement: acts({ reads: ["plans"] }),
			},
			edges: { blueprint: "implement", implement: "stop" },
		};
		const issues = validateWorkflow(promptPublisher, { skillContracts: contractsWith("design", "plan") });
		expect(issues.filter((i) => i.code === "reads-channel-incompatible")).toEqual([]);
	});

	it("errors on a NON-ADJACENT publisher the edge-local walk would miss (all-publishers)", () => {
		registerCompositionComparator("plans", kindComparator);
		// blueprint (adjacent, compatible) AND revise (loop-back, disjoint) both publish "plans".
		const loopback: Workflow = {
			name: "loopback",
			start: "blueprint",
			stages: {
				blueprint: produces({ outcome: { collector: noopCollector, name: "plans" } }),
				implement: acts({ reads: ["plans"] }),
				revise: produces({ outcome: { collector: noopCollector, name: "plans" } }),
			},
			edges: { blueprint: "implement", implement: "revise", revise: "implement" },
		};
		const contracts: SkillContractMap = new Map([
			["blueprint", { source: "declared", produces: { kind: "produces", meta: { artifactKind: "plan" } } }],
			["revise", { source: "declared", produces: { kind: "produces", meta: { artifactKind: "design" } } }],
			["implement", { source: "declared", consumes: { reads: { plans: { meta: { artifactKind: "plan" } } } } }],
		]);
		const issues = validateWorkflow(loopback, { skillContracts: contracts });
		expect(issues.some((i) => i.code === "reads-channel-incompatible" && i.params.producer === "revise")).toBe(true);
	});
});

describe("validateWorkflow — workflow name", () => {
	it("errors when name is the empty string", () => {
		const w: Workflow = {
			name: "",
			start: "a",
			stages: { a: produces() },
			edges: { a: "stop" },
		};
		const issues = validateWorkflow(w);
		expect(issues.some((i) => i.code === "workflow-name-invalid")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Script-stage invariants (presence of `stage.run`)
// ---------------------------------------------------------------------------

describe("validateWorkflow — script stage invariants", () => {
	const noopProducesScript: ProducesScriptFn = (_ctx: ScriptContext) => ({
		kind: "noop",
		artifacts: [],
		data: {},
	});
	const noopActsScript: ActsScriptFn = (_ctx: ScriptContext) => {};

	const wf = (stage: StageDef): Workflow => ({
		name: "scripted",
		start: "s",
		stages: { s: stage },
		edges: { s: "stop" },
	});

	it("rejects `skill` alongside `run`", () => {
		const e = errors(
			wf({ kind: "produces", sessionPolicy: "fresh", run: noopProducesScript, skill: "x" } as unknown as StageDef),
		);
		expect(e.some((i) => i.code === "script-with-skill")).toBe(true);
	});

	it("rejects `outcome` alongside `run`", () => {
		const e = errors(
			wf({
				kind: "produces",
				sessionPolicy: "fresh",
				run: noopProducesScript,
				outcome: { collector: noopCollector },
			} as unknown as StageDef),
		);
		expect(e.some((i) => i.code === "script-with-outcome")).toBe(true);
	});

	it("rejects a `loop` alongside `run`", () => {
		const e = errors(
			wf({
				kind: "side-effect",
				sessionPolicy: "fresh",
				run: noopActsScript,
				loop: fanout({ units: () => [] }),
			} as unknown as StageDef),
		);
		expect(e.some((i) => i.code === "script-with-loop")).toBe(true);
	});

	it('rejects sessionPolicy: "continue" alongside `run`', () => {
		const e = errors(wf({ kind: "produces", sessionPolicy: "continue", run: noopProducesScript }));
		expect(e.some((i) => i.code === "script-continue-session")).toBe(true);
	});

	it("warns when a side-effect script stage carries an outputSchema (no data to validate)", () => {
		const w = wf({
			kind: "side-effect",
			sessionPolicy: "fresh",
			run: noopActsScript,
			outputSchema: typeboxSchema(Type.Object({ ok: Type.Boolean() })),
		});
		const ws = warnings(w);
		expect(ws.some((i) => i.code === "script-side-effect-output-schema")).toBe(true);
		expect(errors(w)).toEqual([]);
	});

	it("reuses the existing produces-with-no-inherit warning for script stages", () => {
		const w = wf({
			kind: "produces",
			sessionPolicy: "fresh",
			run: noopProducesScript,
			inheritsArtifacts: false,
		});
		const ws = warnings(w);
		expect(ws.some((i) => i.code === "inherits-artifacts-on-produces")).toBe(true);
	});

	it("does NOT require `outcome` on a produces script stage (the run function returns the envelope)", () => {
		// Without the carve-out, the old "produces requires outcome" rule would
		// fire — confirm the rule now skips when `stage.run` is set.
		const w = wf({
			kind: "produces",
			sessionPolicy: "fresh",
			run: noopProducesScript,
			outputSchema: typeboxSchema(Type.Object({ count: Type.Integer() })),
		});
		expect(errors(w)).toEqual([]);
	});

	it("a fully-specified produces script stage with input + output schemas validates clean", () => {
		const w = defineWorkflow({
			name: "scripted-positive",
			start: "compute",
			stages: {
				compute: {
					kind: "produces",
					sessionPolicy: "fresh",
					run: noopProducesScript,
					inputSchema: typeboxSchema(Type.Object({ in: Type.String() })),
					outputSchema: typeboxSchema(Type.Object({ count: Type.Integer({ minimum: 0 }) })),
				},
			},
			edges: { compute: "stop" },
		});
		expect(validateWorkflow(w)).toEqual([]);
	});

	it("an acts.script + terminal.script chain validates clean", () => {
		const w = defineWorkflow({
			name: "scripted-acts-chain",
			start: "do",
			stages: {
				do: { kind: "side-effect", sessionPolicy: "fresh", run: noopActsScript },
				cleanup: terminal({ run: noopActsScript }),
			},
			edges: { do: "cleanup", cleanup: "stop" },
		});
		expect(validateWorkflow(w)).toEqual([]);
	});
});

describe("validateWorkflow — iterate loop invariants", () => {
	const iter = iterate({ next: () => null });
	const namedOutcome = { name: "plans", collector: noopCollector };

	const wf = (stage: StageDef): Workflow => ({
		name: "iterating",
		start: "s",
		stages: { s: stage },
		edges: { s: "stop" },
	});

	it("accepts a well-formed iterate stage (produces + named outcome + fresh)", () => {
		const w = wf({ kind: "produces", sessionPolicy: "fresh", outcome: namedOutcome, loop: iter });
		expect(errors(w)).toEqual([]);
	});

	it('rejects an iterate loop with sessionPolicy: "continue"', () => {
		const e = errors(wf({ kind: "produces", sessionPolicy: "continue", outcome: namedOutcome, loop: iter }));
		expect(e.some((i) => i.code === "loop-continue-session")).toBe(true);
	});

	it('rejects iterate on a non-produces stage (kind: "side-effect")', () => {
		const e = errors(wf({ kind: "side-effect", sessionPolicy: "fresh", outcome: namedOutcome, loop: iter }));
		expect(e.some((i) => i.code === "loop-requires-produces" && i.params.kind === "iterate")).toBe(true);
	});

	it("rejects iterate when the outcome has no name (collecting loop needs a stable slot)", () => {
		const e = errors(
			wf({ kind: "produces", sessionPolicy: "fresh", outcome: { collector: noopCollector }, loop: iter }),
		);
		expect(e.some((i) => i.code === "loop-outcome-name-required")).toBe(true);
	});
});

describe("validateWorkflow — assess loop invariants", () => {
	const producerOutcome = { name: "tasks", collector: noopCollector };
	const verdictOutcome = { name: "verdict", collector: noopCollector };

	const wf = (stage: StageDef): Workflow => ({
		name: "assessing",
		start: "s",
		stages: { s: stage },
		edges: { s: "stop" },
	});

	const skillJudge = () => judge({ skill: "grade", outcome: verdictOutcome });
	const wellFormed = () => assess({ judge: skillJudge(), done: () => true, feedForward: () => "decompose further" });

	const base = (overrides: Partial<StageDef> = {}): StageDef =>
		({
			kind: "produces",
			sessionPolicy: "fresh",
			outcome: producerOutcome,
			loop: wellFormed(),
			...overrides,
		}) as StageDef;

	// Hand-rolled loop literal — bypasses the constructor's construction-time
	// throws so the defensive LOAD gate can be exercised (jiti erases TS types,
	// so a programmatic embedder can ship a malformed loop the runner must reject).
	const rawAssessLoop = (over: Record<string, unknown> = {}, judgeOver: Record<string, unknown> = {}): LoopDef =>
		({
			kind: "assess",
			judge: { skill: "grade", outcome: verdictOutcome, ...judgeOver },
			done: () => true,
			feedForward: () => "decompose further",
			max: 8,
			onCap: "advance",
			result: "last",
			...over,
		}) as unknown as LoopDef;

	it("accepts a well-formed assess stage (produces + skill judge + fresh)", () => {
		expect(errors(wf(base()))).toEqual([]);
	});

	it("accepts a well-formed assess stage with a prompt judge", () => {
		const stage = base({
			loop: assess({
				judge: judge({ prompt: "Are all tasks atomic?", outcome: verdictOutcome }),
				done: () => true,
				feedForward: () => "decompose further",
			}),
		});
		expect(errors(wf(stage))).toEqual([]);
	});

	it("no longer rejects assess alongside reads (v1 restriction lifted — entryArgs is fold-frozen)", () => {
		const w: Workflow = {
			name: "assessing",
			start: "up",
			stages: {
				up: { kind: "produces", sessionPolicy: "fresh", outcome: { name: "specs", collector: noopCollector } },
				s: base({ reads: ["specs"] }),
			},
			edges: { up: "s", s: "stop" },
		};
		expect(errors(w)).toEqual([]);
	});

	it('rejects assess on a non-produces stage (kind: "side-effect")', () => {
		const e = errors(wf(base({ kind: "side-effect" })));
		expect(e.some((i) => i.code === "loop-requires-produces" && i.params.kind === "assess")).toBe(true);
	});

	it('rejects an assess loop with sessionPolicy: "continue"', () => {
		const e = errors(wf(base({ sessionPolicy: "continue" })));
		expect(e.some((i) => i.code === "loop-continue-session")).toBe(true);
	});

	it("requires a producer outcome.name (collecting loop needs a stable slot)", () => {
		const e = errors(wf(base({ outcome: { collector: noopCollector } })));
		expect(e.some((i) => i.code === "loop-outcome-name-required")).toBe(true);
	});

	it("rejects a judge whose outcome has no name (defensive load gate)", () => {
		const e = errors(wf(base({ loop: rawAssessLoop({}, { outcome: { collector: noopCollector } }) })));
		expect(e.some((i) => i.code === "assess-judge-shape" && String(i.params.issue).includes("judge.outcome"))).toBe(
			true,
		);
	});

	it("rejects a judge that sets both skill and prompt (defensive load gate)", () => {
		const e = errors(wf(base({ loop: rawAssessLoop({}, { prompt: "grade it" }) })));
		expect(
			e.some((i) => i.code === "assess-judge-shape" && String(i.params.issue).includes("both `skill` and `prompt`")),
		).toBe(true);
	});

	it("rejects a judge that sets neither skill nor prompt (defensive load gate)", () => {
		const e = errors(wf(base({ loop: rawAssessLoop({}, { skill: undefined }) })));
		expect(
			e.some(
				(i) => i.code === "assess-judge-shape" && String(i.params.issue).includes("neither `skill` nor `prompt`"),
			),
		).toBe(true);
	});

	it("rejects a non-function done (defensive load gate)", () => {
		const e = errors(wf(base({ loop: rawAssessLoop({ done: undefined }) })));
		expect(e.some((i) => i.code === "assess-done-not-function")).toBe(true);
	});

	it("rejects a non-function feedForward (defensive load gate)", () => {
		const e = errors(wf(base({ loop: rawAssessLoop({ feedForward: undefined }) })));
		expect(e.some((i) => i.code === "assess-feed-forward-not-function")).toBe(true);
	});

	it("rejects a judge outcome name that collides with the producer's publish name", () => {
		const stage = base({
			loop: assess({
				judge: judge({ skill: "grade", outcome: { name: "tasks", collector: noopCollector } }),
				done: () => true,
				feedForward: () => "decompose further",
			}),
		});
		const e = errors(wf(stage));
		expect(e.some((i) => i.code === "assess-verdict-channel-collision" && i.params.channel === "tasks")).toBe(true);
	});

	it.each([0, -1, 1.5])("rejects loop.max: %s (must be an integer >= 1)", (max) => {
		const e = errors(wf(base({ loop: rawAssessLoop({ max }) })));
		expect(e.some((i) => i.code === "loop-max-invalid" && i.params.max === max)).toBe(true);
	});

	it.each([0, -1, 1.5])("rejects fanout concurrency: %s (must be an integer >= 1)", (concurrency) => {
		const e = errors(
			wf({
				kind: "produces",
				sessionPolicy: "fresh",
				outcome: { name: "x", collector: noopCollector },
				loop: { ...fanout({ units: () => [] }), concurrency },
			} as StageDef),
		);
		expect(e.some((i) => i.code === "loop-concurrency-invalid" && i.params.concurrency === concurrency)).toBe(true);
	});

	it("accepts fanout concurrency: 1", () => {
		const e = errors(
			wf({
				kind: "produces",
				sessionPolicy: "fresh",
				outcome: { name: "x", collector: noopCollector },
				loop: { ...fanout({ units: () => [] }), concurrency: 1 },
			} as StageDef),
		);
		expect(e.some((i) => i.code === "loop-concurrency-invalid")).toBe(false);
	});

	it.each(["", "   "])("rejects an empty/blank fanout depArtifactFlag: %j", (depArtifactFlag) => {
		const e = errors(
			wf({
				kind: "produces",
				sessionPolicy: "fresh",
				outcome: { name: "x", collector: noopCollector },
				loop: { ...fanout({ units: () => [] }), depArtifactFlag },
			} as StageDef),
		);
		expect(e.some((i) => i.code === "loop-dep-flag-invalid" && i.params.depArtifactFlag === depArtifactFlag)).toBe(
			true,
		);
	});

	it("accepts a non-empty fanout depArtifactFlag", () => {
		const e = errors(
			wf({
				kind: "produces",
				sessionPolicy: "fresh",
				outcome: { name: "x", collector: noopCollector },
				loop: { ...fanout({ units: () => [] }), depArtifactFlag: "--upstream" },
			} as StageDef),
		);
		expect(e.some((i) => i.code === "loop-dep-flag-invalid")).toBe(false);
	});

	it("accepts loop.max: 1 and an omitted max", () => {
		const withMax = base({
			loop: assess({ judge: skillJudge(), done: () => true, feedForward: () => "x", max: 1 }),
		});
		expect(errors(wf(withMax))).toEqual([]);
		expect(errors(wf(base()))).toEqual([]);
	});
});

describe("validateWorkflow — verify invariants", () => {
	const producerOutcome = { name: "impl", collector: noopCollector };
	const verdictOutcome = { name: "verdict", collector: noopCollector };

	const wf = (stage: StageDef): Workflow => ({
		name: "gated",
		start: "s",
		stages: { s: stage },
		edges: { s: "stop" },
	});

	const skillJudge = () => judge({ skill: "grade", outcome: verdictOutcome });
	const wellFormed = () => verify({ judge: skillJudge(), done: () => true });

	const base = (overrides: Partial<StageDef> = {}): StageDef =>
		({
			kind: "produces",
			sessionPolicy: "fresh",
			outcome: producerOutcome,
			verify: wellFormed(),
			...overrides,
		}) as StageDef;

	// Hand-rolled verify literal — bypasses the constructor's construction-time
	// throws so the defensive LOAD gate can be exercised (jiti erases TS types).
	const rawVerify = (over: Record<string, unknown> = {}, judgeOver: Record<string, unknown> = {}): VerifySpec =>
		({
			judge: { skill: "grade", outcome: verdictOutcome, ...judgeOver },
			done: () => true,
			...over,
		}) as unknown as VerifySpec;

	it("accepts a well-formed gate-only verify stage (produces + skill judge + fresh)", () => {
		expect(errors(wf(base()))).toEqual([]);
	});

	it("accepts verify alongside reads (composes — unlike the retired assess restriction)", () => {
		const w: Workflow = {
			name: "gated",
			start: "up",
			stages: {
				up: { kind: "produces", sessionPolicy: "fresh", outcome: { name: "design", collector: noopCollector } },
				s: base({ reads: ["design"] }),
			},
			edges: { up: "s", s: "stop" },
		};
		expect(errors(w)).toEqual([]);
	});

	it('rejects verify on a non-produces stage (kind: "side-effect")', () => {
		const e = errors(wf(base({ kind: "side-effect", outcome: undefined })));
		expect(e.some((i) => i.code === "verify-requires-produces")).toBe(true);
	});

	it("rejects verify alongside loop (v1)", () => {
		const e = errors(wf(base({ loop: iterate({ next: () => null }) })));
		expect(e.some((i) => i.code === "verify-with-loop")).toBe(true);
	});

	it("rejects verify alongside run (script stages have no session to grade)", () => {
		const e = errors(wf(base({ run: () => ({ kind: "x", artifacts: [], data: {} }) })));
		expect(e.some((i) => i.code === "verify-with-run")).toBe(true);
	});

	it("accepts verify alongside prompt (composes — attempt 0 sends the resolved prompt raw)", () => {
		expect(errors(wf(base({ prompt: "do it" })))).toEqual([]);
	});

	it('rejects verify with sessionPolicy "continue"', () => {
		const e = errors(wf(base({ sessionPolicy: "continue" })));
		expect(e.some((i) => i.code === "verify-continue-session")).toBe(true);
	});

	it("rejects a producer outcome without a name (attempts need a stable named slot)", () => {
		const e = errors(wf(base({ outcome: { collector: noopCollector } })));
		expect(e.some((i) => i.code === "verify-outcome-name-required")).toBe(true);
	});

	it("rejects a verdict channel that collides with the producer's publish name", () => {
		const e = errors(
			wf(base({ verify: verify({ judge: judge({ skill: "grade", outcome: producerOutcome }), done: () => true }) })),
		);
		expect(e.some((i) => i.code === "verify-verdict-channel-collision" && i.params.channel === "impl")).toBe(true);
	});

	it("rejects a hand-rolled judge whose outcome has no name (defensive load gate)", () => {
		const e = errors(wf(base({ verify: rawVerify({}, { outcome: { collector: noopCollector } }) })));
		expect(e.some((i) => i.code === "verify-shape" && String(i.params.issue).includes("judge.outcome"))).toBe(true);
	});

	it("rejects a hand-rolled non-function done", () => {
		const e = errors(wf(base({ verify: rawVerify({ done: true }) })));
		expect(
			e.some((i) => i.code === "verify-shape" && String(i.params.issue).includes("`done` to be a function")),
		).toBe(true);
	});

	it.each([0, -1, 1.5])("rejects verify.max: %s (must be an integer >= 1)", (max) => {
		const e = errors(wf(base({ verify: rawVerify({ max, feedForward: () => "x" }) })));
		expect(
			e.some((i) => i.code === "verify-shape" && String(i.params.issue).includes("must be an integer >= 1")),
		).toBe(true);
	});

	it("rejects max > 1 without feedForward (hand-rolled literal)", () => {
		const e = errors(wf(base({ verify: rawVerify({ max: 2 }) })));
		expect(
			e.some((i) => i.code === "verify-shape" && String(i.params.issue).includes("max > 1 requires `feedForward`")),
		).toBe(true);
	});
});

describe("validateWorkflow — panel invariants", () => {
	const producerOutcome = { name: "tasks", collector: noopCollector };
	const memberA = () => judge({ skill: "grade-a", outcome: { name: "verdict-a", collector: noopCollector } });
	const memberB = () => judge({ skill: "grade-b", outcome: { name: "verdict-b", collector: noopCollector } });
	const memberC = () => judge({ prompt: "grade it", outcome: { name: "verdict-c", collector: noopCollector } });
	// Sugar fold reading each member's own `{ pass }` verdict.
	const maj = () => majority((v) => Boolean((v.data as { pass?: boolean }).pass));

	const wf = (stage: StageDef): Workflow => ({
		name: "paneled",
		start: "s",
		stages: { s: stage },
		edges: { s: "stop" },
	});

	const base = (overrides: Partial<StageDef> = {}): StageDef =>
		({
			kind: "produces",
			sessionPolicy: "fresh",
			outcome: producerOutcome,
			...overrides,
		}) as StageDef;

	// Hand-rolled panel literal — bypasses the panel()/assess()/verify()
	// construction throws so the defensive LOAD gate can be exercised (jiti
	// erases TS types, so a programmatic embedder can ship a malformed panel).
	const rawPanel = (over: Record<string, unknown> = {}): unknown => ({
		kind: "panel",
		members: [memberA(), memberB()],
		fold: maj(),
		...over,
	});

	// Wrap a (possibly malformed) judge slot in a hand-rolled assess loop literal.
	const assessOf = (slot: unknown): StageDef =>
		base({
			loop: {
				kind: "assess",
				judge: slot,
				done: () => true,
				feedForward: () => "again",
				max: 8,
				onCap: "advance",
				result: "last",
			} as unknown as LoopDef,
		});

	it("accepts a canonical 3-member panel in assess (sugar fold, no outcome)", () => {
		const stage = base({
			loop: assess({
				judge: panel({ members: [memberA(), memberB(), memberC()], fold: maj() }),
				done: () => true,
				feedForward: () => "again",
			}),
		});
		expect(errors(wf(stage))).toEqual([]);
	});

	it("accepts a custom panel (raw fold + outcome) in verify", () => {
		const stage = base({
			verify: verify({
				judge: panel({
					members: [memberA(), memberB()],
					fold: (vs) => ({ mean: vs.length }),
					outcome: { name: "panel-score", collector: noopCollector },
				}),
				done: () => true,
			}),
		});
		expect(errors(wf(stage))).toEqual([]);
	});

	it("routes a hand-rolled panel shape violation through panelShapeIssues (nested member)", () => {
		const e = errors(wf(assessOf(rawPanel({ members: [memberA(), rawPanel()] }))));
		expect(e.some((i) => i.code === "assess-judge-shape" && String(i.params.issue).includes("may not nest"))).toBe(
			true,
		);
	});

	it("routes a panel XOR violation (sugar fold + outcome) through verify-shape", () => {
		const v = {
			judge: rawPanel({ outcome: { name: "extra", collector: noopCollector } }),
			done: () => true,
		} as unknown as VerifySpec;
		const e = errors(wf(base({ verify: v })));
		expect(e.some((i) => i.code === "verify-shape" && String(i.params.issue).includes("drop `outcome`"))).toBe(true);
	});

	it("rejects duplicate member verdict channels", () => {
		const dupB = judge({ skill: "grade-b", outcome: { name: "verdict-a", collector: noopCollector } });
		const stage = base({
			loop: assess({
				judge: panel({ members: [memberA(), dupB], fold: maj() }),
				done: () => true,
				feedForward: () => "x",
			}),
		});
		const e = errors(wf(stage));
		expect(e.some((i) => i.code === "panel-member-channel-collision" && i.params.channel === "verdict-a")).toBe(true);
	});

	it("rejects a member verdict channel that collides with the producer's publish name", () => {
		const collide = judge({ skill: "grade-b", outcome: { name: "tasks", collector: noopCollector } });
		const stage = base({
			loop: assess({
				judge: panel({ members: [memberA(), collide], fold: maj() }),
				done: () => true,
				feedForward: () => "x",
			}),
		});
		const e = errors(wf(stage));
		expect(e.some((i) => i.code === "panel-member-channel-collision" && i.params.channel === "tasks")).toBe(true);
	});

	it("rejects a custom fold channel that collides with the producer's publish name", () => {
		const stage = base({
			loop: assess({
				judge: panel({
					members: [memberA(), memberB()],
					fold: (vs) => ({ n: vs.length }),
					outcome: { name: "tasks", collector: noopCollector },
				}),
				done: () => true,
				feedForward: () => "x",
			}),
		});
		const e = errors(wf(stage));
		expect(e.some((i) => i.code === "panel-verdict-channel-collision" && i.params.channel === "tasks")).toBe(true);
	});

	it("publishes member + folded-verdict channels so downstream reads resolve", () => {
		const up = base({
			loop: assess({
				judge: panel({ members: [memberA(), memberB()], fold: maj() }),
				done: () => true,
				feedForward: () => "again",
			}),
		});
		const w: Workflow = {
			name: "paneled",
			start: "s",
			stages: {
				s: up,
				down: {
					kind: "produces",
					sessionPolicy: "fresh",
					outcome: { name: "summary", collector: noopCollector },
					// member verdict channel + the canonical `<stage>-panel` fold channel
					reads: ["verdict-a", "s-panel"],
				} as StageDef,
			},
			edges: { s: "down", down: "stop" },
		};
		expect(errors(w).filter((i) => i.code === "reads-unpublished")).toEqual([]);
	});
});

describe("validateWorkflow — judge verdict channels are published names", () => {
	const noop = noopCollector;
	const baseStage = (over: Partial<StageDef> = {}): StageDef =>
		({
			kind: "produces",
			sessionPolicy: "fresh",
			outcome: { name: "impl", collector: noop },
			...over,
		}) as StageDef;

	it("reads of a verify verdict channel passes at load (was a false error for judge channels)", () => {
		const w: Workflow = {
			name: "gated",
			start: "s",
			stages: {
				s: baseStage({
					verify: verify({
						judge: judge({ skill: "grade", outcome: { name: "verdict", collector: noop } }),
						done: () => true,
					}),
				}),
				next: { kind: "side-effect", sessionPolicy: "fresh", reads: ["verdict"] },
			},
			edges: { s: "next", next: "stop" },
		};
		expect(errors(w)).toEqual([]);
	});

	it("reads of an assess verdict channel no longer false-errors (gap repaired for assess too)", () => {
		const w: Workflow = {
			name: "assessing",
			start: "s",
			stages: {
				s: baseStage({
					loop: assess({
						judge: judge({ skill: "grade", outcome: { name: "verdict", collector: noop } }),
						done: () => true,
						feedForward: () => "x",
					}),
				}),
				next: { kind: "side-effect", sessionPolicy: "fresh", reads: ["verdict"] },
			},
			edges: { s: "next", next: "stop" },
		};
		expect(errors(w)).toEqual([]);
	});

	it("reads of an unknown name still errors", () => {
		const w: Workflow = {
			name: "gated",
			start: "s",
			stages: {
				s: baseStage(),
				next: { kind: "side-effect", sessionPolicy: "fresh", reads: ["nope"] },
			},
			edges: { s: "next", next: "stop" },
		};
		expect(errors(w).some((i) => i.code === "reads-unpublished" && i.params.channel === "nope")).toBe(true);
	});
});

describe("validateWorkflow — prompt invariants", () => {
	const noopActsScript: ActsScriptFn = (_ctx: ScriptContext) => {};
	const wf = (stage: StageDef, start = "s"): Workflow => ({
		name: "prompting",
		start,
		stages: { s: stage },
		edges: { s: "stop" },
	});

	it("accepts a side-effect prompt stage", () => {
		expect(errors(wf({ kind: "side-effect", sessionPolicy: "fresh", prompt: "do the thing" }))).toEqual([]);
	});

	it("accepts a produces prompt stage with an outcome", () => {
		const e = errors(
			wf({ kind: "produces", sessionPolicy: "fresh", prompt: "write it", outcome: { collector: noopCollector } }),
		);
		expect(e).toEqual([]);
	});

	it("rejects a prompt stage that also sets an explicit skill", () => {
		const e = errors(
			wf({ kind: "side-effect", sessionPolicy: "fresh", prompt: "x", skill: "implement" } as unknown as StageDef),
		);
		expect(e.some((i) => i.code === "prompt-with-skill")).toBe(true);
	});

	it("rejects prompt + iterate (units own their prompts)", () => {
		const e = errors(
			wf({
				kind: "produces",
				sessionPolicy: "fresh",
				prompt: "x",
				outcome: { name: "p", collector: noopCollector },
				loop: iterate({ next: () => null }),
			} as unknown as StageDef),
		);
		expect(e.some((i) => i.code === "prompt-with-loop" && i.params.kind === "iterate")).toBe(true);
	});

	it("rejects prompt + fanout (units own their prompts)", () => {
		const e = errors(
			wf({
				kind: "side-effect",
				sessionPolicy: "fresh",
				prompt: "x",
				loop: fanout({ units: () => [] }),
			} as unknown as StageDef),
		);
		expect(e.some((i) => i.code === "prompt-with-loop" && i.params.kind === "fanout")).toBe(true);
	});

	it("accepts prompt + assess (the prompt is round 0's message; feedForward builds retries)", () => {
		const e = errors(
			wf({
				kind: "produces",
				sessionPolicy: "fresh",
				prompt: "draft it",
				outcome: { name: "p", collector: noopCollector },
				loop: assess({
					judge: judge({ skill: "grade", outcome: { name: "p-verdict", collector: noopCollector } }),
					done: () => true,
					feedForward: () => "again",
				}),
			}),
		);
		expect(e).toEqual([]);
	});

	it("rejects prompt + reads", () => {
		const e = errors(
			wf({ kind: "side-effect", sessionPolicy: "fresh", prompt: "x", reads: ["plans"] } as unknown as StageDef),
		);
		expect(e.some((i) => i.code === "prompt-with-reads")).toBe(true);
	});

	it("rejects prompt + run (a script stage cannot set a raw prompt)", () => {
		const e = errors(
			wf({ kind: "side-effect", sessionPolicy: "fresh", prompt: "x", run: noopActsScript } as unknown as StageDef),
		);
		expect(e.some((i) => i.code === "script-with-prompt")).toBe(true);
	});

	it("rejects an empty-string prompt", () => {
		const e = errors(wf({ kind: "side-effect", sessionPolicy: "fresh", prompt: "   " }));
		expect(e.some((i) => i.code === "prompt-empty")).toBe(true);
	});

	it("requires an outcome on a produces prompt stage (no run carve-out)", () => {
		const e = errors(wf({ kind: "produces", sessionPolicy: "fresh", prompt: "write it" }));
		expect(e.some((i) => i.code === "produces-without-outcome")).toBe(true);
	});

	it("warns when a continue prompt stage is the workflow start", () => {
		const w = wf({ kind: "side-effect", sessionPolicy: "continue", prompt: "follow up" });
		expect(warnings(w).some((i) => i.code === "prompt-continue-at-start")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// issue payload shape
// ---------------------------------------------------------------------------

describe("validateWorkflow — issue shape", () => {
	it("attaches workflow name + stage to every issue", () => {
		const w: Workflow = {
			name: "bad",
			start: "ghost",
			stages: { a: produces() },
			edges: { a: "missing" },
		};
		const issues = validateWorkflow(w);
		for (const i of issues) {
			expect(i.workflow).toBe("bad");
		}
		// At least one issue carries a specific stage attribution.
		expect(issues.some((i) => i.stage === "a")).toBe(true);
	});

	it("every issue carries a machine-readable code + params + rendered message", () => {
		const w: Workflow = {
			name: "bad",
			start: "ghost",
			stages: { a: produces(), b: { kind: "produces", sessionPolicy: "continue", run: async () => undefined } },
			edges: { a: "missing" },
		};
		const issues = validateWorkflow(w);
		expect(issues.length).toBeGreaterThan(0);
		for (const i of issues) {
			expect(typeof i.code).toBe("string");
			expect(i.params).toBeTypeOf("object");
			expect(i.message.length).toBeGreaterThan(0);
		}
	});

	it("messages never embed the stage attribution (renderers compose it)", () => {
		// A stage-attributed issue must not also spell `stage "<name>"` in its
		// prose — the double-attribution the old free-form messages produced.
		const w: Workflow = {
			name: "bad",
			start: "s",
			stages: { s: { ...produces(), sessionPolicy: "continue", loop: iterate({ next: () => null }) } as StageDef },
			edges: { s: "stop" },
		};
		const issues = validateWorkflow(w);
		expect(issues.length).toBeGreaterThan(0);
		for (const i of issues) {
			if (!i.stage) continue;
			expect(i.message).not.toContain(`stage "${i.stage}"`);
		}
	});

	it("skips reachability when an EdgeFn lacks .targets — gated on the issue CODE (C5)", () => {
		const naked: EdgeFn = () => "ghost";
		const w: Workflow = {
			name: "gated",
			start: "a",
			stages: { a: produces(), orphan: produces() },
			edges: { a: naked, orphan: "stop" },
		};
		const issues = validateWorkflow(w);
		expect(issues.some((i) => i.code === "edge-fn-no-targets")).toBe(true);
		// No unreachable-cascade: reachability was skipped.
		expect(issues.filter((i) => i.code === "stage-unreachable")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Edge-schema compatibility
// ---------------------------------------------------------------------------

describe("validateWorkflow — edge-schema compatibility", () => {
	it("warns when producer outputSchema is incompatible with consumer inputSchema", () => {
		const w: Workflow = {
			name: "incompat",
			start: "producer",
			stages: {
				producer: producesRaw({
					outcome: STUB_ARTIFACT_OUTCOME,
					outputSchema: typeboxSchema(Type.Object({ a: Type.String() })),
				}),
				consumer: acts({ inputSchema: typeboxSchema(Type.Object({ a: Type.Number() })) }),
			},
			edges: { producer: "consumer", consumer: "stop" },
		};
		const ws = warnings(w);
		expect(ws.some((i) => i.code === "edge-schema-incompatible")).toBe(true);
	});

	it("does NOT warn when schemas are compatible", () => {
		const w: Workflow = {
			name: "compat",
			start: "producer",
			stages: {
				producer: producesRaw({
					outcome: STUB_ARTIFACT_OUTCOME,
					outputSchema: typeboxSchema(Type.Object({ a: Type.String() })),
				}),
				consumer: acts({ inputSchema: typeboxSchema(Type.Object({ a: Type.String() })) }),
			},
			edges: { producer: "consumer", consumer: "stop" },
		};
		expect(warnings(w).filter((i) => i.code === "edge-schema-incompatible")).toEqual([]);
	});

	it("does NOT warn when producer or consumer schema is absent (degrade)", () => {
		const w: Workflow = {
			name: "no-schema",
			start: "a",
			stages: {
				a: producesRaw({ outcome: STUB_ARTIFACT_OUTCOME }),
				b: acts(),
			},
			edges: { a: "b", b: "stop" },
		};
		expect(warnings(w).filter((i) => i.code === "edge-schema-incompatible")).toEqual([]);
	});

	it("does NOT warn on predicate edges (only string edges are checked)", () => {
		const w: Workflow = {
			name: "predicate-edge",
			start: "a",
			stages: {
				a: producesRaw({
					outcome: STUB_ARTIFACT_OUTCOME,
					outputSchema: typeboxSchema(Type.Object({ a: Type.String() })),
				}),
				b: acts({ inputSchema: typeboxSchema(Type.Object({ a: Type.Number() })) }),
				c: acts(),
			},
			edges: {
				a: gate("x", { b: gt(0), c: eq(0) }, "c"),
				b: "stop",
				c: "stop",
			},
		};
		expect(warnings(w).filter((i) => i.code === "edge-schema-incompatible")).toEqual([]);
	});

	it("uses registry contracts when provided (overrides stage schemas)", () => {
		// Stage schemas say string→number (incompatible), but registry contracts
		// say both are string→string (compatible) — registry wins.
		const contracts: SkillContractMap = new Map([
			[
				"producer",
				{
					source: "declared",
					produces: { kind: "produces", data: { type: "object", properties: { a: { type: "string" } } } },
				},
			],
			[
				"consumer",
				{
					source: "declared",
					consumes: { data: { type: "object", properties: { a: { type: "string" } } } },
				},
			],
		]);
		const w: Workflow = {
			name: "override",
			start: "producer",
			stages: {
				producer: producesRaw({
					outcome: STUB_ARTIFACT_OUTCOME,
					outputSchema: typeboxSchema(Type.Object({ a: Type.String() })),
				}),
				consumer: acts({ inputSchema: typeboxSchema(Type.Object({ a: Type.Number() })) }),
			},
			edges: { producer: "consumer", consumer: "stop" },
		};
		const ws = validateWorkflow(w, { skillContracts: contracts }).filter(
			(i) => i.code === "edge-schema-incompatible",
		);
		expect(ws).toEqual([]);
	});

	it("warns from registry contract incompatibility", () => {
		const contracts: SkillContractMap = new Map([
			[
				"producer",
				{
					source: "declared",
					produces: {
						kind: "produces",
						data: { type: "object", properties: { a: { type: "string" } } },
					},
				},
			],
			[
				"consumer",
				{
					source: "declared",
					consumes: {
						data: { type: "object", properties: { a: { type: "number" } } },
					},
				},
			],
		]);
		const w: Workflow = {
			name: "contract-incompat",
			start: "producer",
			stages: {
				producer: producesRaw({ outcome: STUB_ARTIFACT_OUTCOME }),
				consumer: acts(),
			},
			edges: { producer: "consumer", consumer: "stop" },
		};
		const issues = validateWorkflow(w, { skillContracts: contracts });
		expect(issues.some((i) => i.code === "edge-schema-incompatible")).toBe(true);
	});

	it("does NOT warn on stop edges", () => {
		const w: Workflow = {
			name: "stop-edge",
			start: "a",
			stages: { a: produces() },
			edges: { a: "stop" },
		};
		expect(warnings(w).filter((i) => i.code === "edge-schema-incompatible")).toEqual([]);
	});
});

describe("checkFanoutSource (control-flow source lint)", () => {
	const loopMsgs = (w: Workflow) => warnings(w).filter((i) => i.code === "loop-source-unpublished");

	it("warns when a fanout loop's source is not published by any produces stage", () => {
		const w: Workflow = {
			name: "t",
			start: "start",
			stages: {
				start: produces(),
				impl: acts({ loop: fanout({ source: "plans", units: () => [] }) }),
			},
			edges: { start: "impl", impl: "stop" },
		};
		const msgs = loopMsgs(w);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]?.params).toMatchObject({ verb: "fans out over", source: "plans" });
	});

	it("warns when an iterate loop's source is unpublished (the no-`reads` case)", () => {
		const w: Workflow = {
			name: "t",
			start: "start",
			stages: {
				start: produces(),
				bp: produces({
					outcome: { name: "bp", collector: noopCollector },
					loop: iterate({ source: "architecture-reviews", next: () => null }),
				}),
			},
			edges: { start: "bp", bp: "stop" },
		};
		expect(
			loopMsgs(w).some((i) => i.params.verb === "iterates over" && i.params.source === "architecture-reviews"),
		).toBe(true);
	});

	it("is silent when the source IS published", () => {
		const w: Workflow = {
			name: "t",
			start: "plans",
			stages: {
				plans: produces(), // publishes channel "plans" (outcome.name ?? record-key)
				impl: acts({ loop: fanout({ source: "plans", units: () => [] }) }),
			},
			edges: { plans: "impl", impl: "stop" },
		};
		expect(loopMsgs(w)).toEqual([]);
	});

	it("defers to checkReadsReferences when the source is in the stage's reads (no double-report)", () => {
		const w: Workflow = {
			name: "t",
			start: "start",
			stages: {
				start: produces(),
				impl: acts({ loop: fanout({ source: "plans", units: () => [] }), reads: ["plans"] }),
			},
			edges: { start: "impl", impl: "stop" },
		};
		// reads owns "plans" (errors); checkFanoutSource stays quiet
		expect(loopMsgs(w)).toEqual([]);
		expect(errors(w).some((i) => i.code === "reads-unpublished" && i.params.channel === "plans")).toBe(true);
	});

	it("defers when the source is consumed via fanin() (normalized membership, no spurious warning)", () => {
		// Array.includes is strict-equality — a fanin() object never equals the
		// string source, so without normalization this would falsely fire.
		const w: Workflow = {
			name: "t",
			start: "plans",
			stages: {
				plans: produces(), // publishes "plans"
				impl: acts({ loop: fanout({ source: "plans", units: () => [] }), reads: [fanin("plans")] }),
			},
			edges: { plans: "impl", impl: "stop" },
		};
		expect(loopMsgs(w)).toEqual([]);
	});

	it("is silent for a loop with no source (degrade)", () => {
		const w: Workflow = {
			name: "t",
			start: "start",
			stages: {
				start: produces(),
				impl: acts({ loop: fanout({ units: () => [] }) }),
			},
			edges: { start: "impl", impl: "stop" },
		};
		expect(loopMsgs(w)).toEqual([]);
	});
});

describe("checkFanoutReadHint (reads-latest-from-fanout nudge)", () => {
	const hintMsgs = (w: Workflow) => warnings(w).filter((i) => i.code === "reads-latest-from-fanout");

	it("warns when a bare-string read targets a collecting-fanout channel", () => {
		const w: Workflow = {
			name: "t",
			start: "gen",
			stages: {
				gen: produces({
					outcome: { name: "plans", collector: noopCollector },
					loop: fanout({ units: () => [] }),
				}),
				synth: produces({ outcome: { name: "report", collector: noopCollector }, reads: ["plans"] }),
			},
			edges: { gen: "synth", synth: "stop" },
		};
		const msgs = hintMsgs(w);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]?.params).toMatchObject({ channel: "plans" });
	});

	it("is silent once the read is wrapped in fanin() (already opted in)", () => {
		const w: Workflow = {
			name: "t",
			start: "gen",
			stages: {
				gen: produces({
					outcome: { name: "plans", collector: noopCollector },
					loop: fanout({ units: () => [] }),
				}),
				synth: produces({ outcome: { name: "report", collector: noopCollector }, reads: [fanin("plans")] }),
			},
			edges: { gen: "synth", synth: "stop" },
		};
		expect(hintMsgs(w)).toEqual([]);
	});

	it("is silent for a bare read of a NON-fanout channel (plain produces / iterate)", () => {
		const w: Workflow = {
			name: "t",
			start: "gen",
			stages: {
				gen: produces({ outcome: { name: "plans", collector: noopCollector } }),
				bp: produces({
					outcome: { name: "reviews", collector: noopCollector },
					loop: iterate({ next: () => null }),
				}),
				synth: produces({
					outcome: { name: "report", collector: noopCollector },
					reads: ["plans", "reviews"],
				}),
			},
			edges: { gen: "bp", bp: "synth", synth: "stop" },
		};
		expect(hintMsgs(w)).toEqual([]);
	});

	it("is silent when the fanout sits on an acts() side-effect stage (the load-bearing produces-kind clause)", () => {
		// Mirrors rpiv-pi's built-ins: the fanout loop rides an `acts()` implement
		// stage (kind: side-effect, publishes nothing), while the read channel is
		// published by a separate produces stage. Relaxing the produces-kind clause
		// would falsely fire here and break the sibling package's zero-warning gate.
		const w: Workflow = {
			name: "t",
			start: "blueprint",
			stages: {
				blueprint: produces({ outcome: { name: "plans", collector: noopCollector } }),
				implement: acts({ loop: fanout({ source: "plans", units: () => [] }), reads: ["plans"] }),
			},
			edges: { blueprint: "implement", implement: "stop" },
		};
		expect(hintMsgs(w)).toEqual([]);
	});
});
