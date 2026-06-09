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
	gate,
	type IterateFn,
	type ProducesScriptFn,
	produces as producesRaw,
	type ScriptContext,
	type StageDef,
	terminal,
	type Workflow,
} from "./api.js";
import { fanoutOver, iterateOver } from "./control-flow.js";
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
	producesRaw({ outcome: STUB_ARTIFACT_OUTCOME, ...overrides });

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
		expect(e[0]!.message).toMatch(/start stage "ghost" is not declared/);
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
		expect(e.some((i) => /edges\["phantom"\] references a stage that's not declared/.test(i.message))).toBe(true);
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
		expect(e.some((i) => i.stage === "a" && /resolves to "missing" which is not declared/.test(i.message))).toBe(
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
			edges: { a: gate("count", { good: gt(0), bad: eq(0) }), good: "stop" },
		};
		const e = errors(w);
		expect(e.some((i) => /resolves to "bad"/.test(i.message))).toBe(true);
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
		expect(e.some((i) => /EdgeFn without `\.targets`/.test(i.message))).toBe(true);
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
		expect(w2.some((i) => i.stage === "b" && /has no edge — treated as terminal/.test(i.message))).toBe(true);
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
		expect(w2.some((i) => i.stage === "orphan" && /unreachable from start "a"/.test(i.message))).toBe(true);
	});

	it("treats EdgeFn branches as reachable via .targets metadata", () => {
		const w: Workflow = {
			name: "branching",
			start: "a",
			stages: { a: produces(), x: produces(), y: produces() },
			// Both x and y are reachable through the gate.
			edges: { a: gate("count", { x: gt(0), y: eq(0) }), x: "stop", y: "stop" },
		};
		const w2 = warnings(w);
		expect(w2.find((i) => /unreachable/.test(i.message))).toBeUndefined();
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
				validate: gate("severeIssueCount", { revise: gt(0), commit: eq(0) }),
				revise: "implement", // back-edge
				commit: "stop",
			},
		};
		const issues = validateWorkflow(w);
		expect(issues.filter((i) => i.severity === "error")).toEqual([]);
		expect(issues.filter((i) => i.severity === "warning" && /unreachable/.test(i.message))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Semantic checks — restored from the old validateDag
// ---------------------------------------------------------------------------

describe("validateWorkflow — semantic stage constraints", () => {
	const baseWithStage = (overrides: Partial<import("./api.js").StageDef>): Workflow => ({
		name: "semantic",
		start: "a",
		stages: { a: { ...produces(), ...overrides } },
		edges: { a: "stop" },
	});

	it("errors on maxRetries below the floor", () => {
		const issues = validateWorkflow(baseWithStage({ maxRetries: 0 }));
		expect(issues.some((i) => i.severity === "error" && /maxRetries: 0/.test(i.message))).toBe(true);
	});

	it("errors on maxRetries above the ceiling", () => {
		const issues = validateWorkflow(baseWithStage({ maxRetries: 100 }));
		expect(issues.some((i) => i.severity === "error" && /maxRetries: 100/.test(i.message))).toBe(true);
	});

	it("errors on validateTimeoutMs out of range", () => {
		const issues = validateWorkflow(baseWithStage({ validateTimeoutMs: 0 }));
		expect(issues.some((i) => i.severity === "error" && /validateTimeoutMs: 0/.test(i.message))).toBe(true);
	});

	it("errors on unknown onInvalid value", () => {
		const issues = validateWorkflow(baseWithStage({ onInvalid: "burn-it-down" as unknown as "retry" | "halt" }));
		expect(issues.some((i) => i.severity === "error" && /onInvalid: "burn-it-down"/.test(i.message))).toBe(true);
	});

	it("accepts the documented onInvalid values", () => {
		expect(validateWorkflow(baseWithStage({ onInvalid: "retry" })).filter((i) => i.severity === "error")).toEqual([]);
		expect(validateWorkflow(baseWithStage({ onInvalid: "halt" })).filter((i) => i.severity === "error")).toEqual([]);
	});

	it("errors on unknown kind", () => {
		const issues = validateWorkflow(baseWithStage({ kind: "burn-it" as unknown as "produces" }));
		expect(issues.some((i) => i.severity === "error" && /kind: "burn-it"/.test(i.message))).toBe(true);
	});

	it("errors on unknown sessionPolicy", () => {
		const issues = validateWorkflow(baseWithStage({ sessionPolicy: "lingering" as unknown as "fresh" }));
		expect(issues.some((i) => i.severity === "error" && /sessionPolicy: "lingering"/.test(i.message))).toBe(true);
	});

	it("warns when inheritsArtifacts: false is set on a produces stage", () => {
		// The flag is the `terminal()` factory's mechanism — meaningful only
		// for side-effect stages. Setting it on `produces` does nothing.
		const issues = validateWorkflow(baseWithStage({ inheritsArtifacts: false }));
		expect(issues.some((i) => i.severity === "warning" && /inheritsArtifacts: false/.test(i.message))).toBe(true);
	});

	it("does NOT warn when inheritsArtifacts: false is set on a side-effect stage", () => {
		const w: Workflow = {
			name: "term",
			start: "a",
			stages: { a: acts({ inheritsArtifacts: false }) },
			edges: { a: "stop" },
		};
		expect(warnings(w).filter((i) => /inheritsArtifacts/.test(i.message))).toEqual([]);
	});
});

describe("validateWorkflow — route-edge schema check", () => {
	it("warns when a route edge reads from a stage without outputSchema", () => {
		const w: Workflow = {
			name: "naked",
			start: "code-review",
			stages: { "code-review": produces(), revise: produces(), commit: acts() },
			edges: {
				"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }),
				revise: "commit",
				commit: "stop",
			},
		};
		const issues = validateWorkflow(w);
		expect(
			issues.some((i) => i.severity === "warning" && i.stage === "code-review" && /outputSchema/.test(i.message)),
		).toBe(true);
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
				"code-review": defineRoute(["a", "b"], ({ state }) => (state.telemetry.backwardJumps > 0 ? "a" : "b"), {
					readsData: false,
				}),
				a: "stop",
				b: "stop",
			},
		};
		const issues = validateWorkflow(w);
		expect(issues.filter((i) => i.severity === "warning" && /outputSchema/.test(i.message))).toEqual([]);
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
		expect(
			issues.some((i) => i.severity === "warning" && i.stage === "code-review" && /outputSchema/.test(i.message)),
		).toBe(true);
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
				"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }),
				revise: "commit",
				commit: "stop",
			},
		};
		const issues = validateWorkflow(w);
		expect(issues.filter((i) => i.severity === "warning" && /outputSchema/.test(i.message))).toEqual([]);
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
				"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }),
				revise: "commit",
				commit: "stop",
			},
		};
		const issues = validateWorkflow(w, { skillContracts: contracts });
		expect(issues.filter((i) => i.severity === "warning" && /outputSchema/.test(i.message))).toEqual([]);
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
				"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }),
				revise: "commit",
				commit: "stop",
			},
		};
		const issues = validateWorkflow(w, { skillContracts: contracts });
		expect(
			issues.some((i) => i.severity === "warning" && i.stage === "code-review" && /outputSchema/.test(i.message)),
		).toBe(true);
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
					i.severity === "error" &&
					/reads channel "plans" but publisher "blueprint" is incompatible/.test(i.message),
			),
		).toBe(true);
	});

	it("does NOT error when kinds match", () => {
		registerCompositionComparator("plans", kindComparator);
		const issues = validateWorkflow(wf, { skillContracts: contractsWith("plan", "plan") });
		expect(issues.filter((i) => /reads channel "plans"/.test(i.message))).toEqual([]);
	});

	it("degrades (no error) when no comparator is registered for the channel", () => {
		const issues = validateWorkflow(wf, { skillContracts: contractsWith("design", "plan") });
		expect(issues.filter((i) => /reads channel "plans"/.test(i.message))).toEqual([]);
	});

	it("degrades (no error) when the publisher is unsigned", () => {
		registerCompositionComparator("plans", kindComparator);
		// consumer signed + requires plan; producer (blueprint) absent from registry → degrade
		const issues = validateWorkflow(wf, {
			skillContracts: new Map([
				["implement", { source: "declared", consumes: { reads: { plans: { meta: { artifactKind: "plan" } } } } }],
			]),
		});
		expect(issues.filter((i) => /reads channel "plans"/.test(i.message))).toEqual([]);
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
		expect(issues.some((i) => i.severity === "error" && /publisher "revise" is incompatible/.test(i.message))).toBe(
			true,
		);
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
		expect(
			issues.some((i) => i.severity === "error" && /workflow name must be a non-empty string/.test(i.message)),
		).toBe(true);
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
		const e = errors(wf({ kind: "produces", sessionPolicy: "fresh", run: noopProducesScript, skill: "x" }));
		expect(e.some((i) => /script stages cannot set "skill"/.test(i.message))).toBe(true);
	});

	it("rejects `outcome` alongside `run`", () => {
		const e = errors(
			wf({
				kind: "produces",
				sessionPolicy: "fresh",
				run: noopProducesScript,
				outcome: { collector: noopCollector },
			}),
		);
		expect(e.some((i) => /script stages cannot set "outcome"/.test(i.message))).toBe(true);
	});

	it("rejects `fanout` alongside `run`", () => {
		const e = errors(
			wf({
				kind: "produces",
				sessionPolicy: "fresh",
				run: noopProducesScript,
				fanout: () => [],
			}),
		);
		expect(e.some((i) => /script stages cannot fanout/.test(i.message))).toBe(true);
	});

	it('rejects sessionPolicy: "continue" alongside `run`', () => {
		const e = errors(wf({ kind: "produces", sessionPolicy: "continue", run: noopProducesScript }));
		expect(e.some((i) => /script stages cannot use sessionPolicy "continue"/.test(i.message))).toBe(true);
	});

	it("warns when a side-effect script stage carries an outputSchema (no data to validate)", () => {
		const w = wf({
			kind: "side-effect",
			sessionPolicy: "fresh",
			run: noopActsScript,
			outputSchema: typeboxSchema(Type.Object({ ok: Type.Boolean() })),
		});
		const ws = warnings(w);
		expect(ws.some((i) => /outputSchema is meaningless on side-effect script stages/.test(i.message))).toBe(true);
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
		expect(ws.some((i) => /sets `inheritsArtifacts: false` on a `produces` stage/.test(i.message))).toBe(true);
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

describe("validateWorkflow — iterate invariants", () => {
	const iter: IterateFn = () => null;
	const namedOutcome = { name: "plans", collector: noopCollector };
	const noopActsScript: ActsScriptFn = (_ctx: ScriptContext) => {};

	const wf = (stage: StageDef): Workflow => ({
		name: "iterating",
		start: "s",
		stages: { s: stage },
		edges: { s: "stop" },
	});

	it("accepts a well-formed iterate stage (produces + named outcome + fresh)", () => {
		const w = wf({ kind: "produces", sessionPolicy: "fresh", outcome: namedOutcome, iterate: iter });
		expect(errors(w)).toEqual([]);
	});

	it("rejects iterate alongside fanout (mutually exclusive)", () => {
		const e = errors(
			wf({ kind: "produces", sessionPolicy: "fresh", outcome: namedOutcome, iterate: iter, fanout: () => [] }),
		);
		expect(e.some((i) => /iterate and fanout are mutually exclusive/.test(i.message))).toBe(true);
	});

	it("rejects iterate on a script stage (run set)", () => {
		const e = errors(wf({ kind: "produces", sessionPolicy: "fresh", run: noopActsScript, iterate: iter }));
		expect(e.some((i) => /script stages cannot iterate/.test(i.message))).toBe(true);
	});

	it('rejects iterate with sessionPolicy: "continue"', () => {
		const e = errors(wf({ kind: "produces", sessionPolicy: "continue", outcome: namedOutcome, iterate: iter }));
		expect(e.some((i) => /cannot combine iterate with sessionPolicy "continue"/.test(i.message))).toBe(true);
	});

	it('rejects iterate on a non-produces stage (kind: "side-effect")', () => {
		const e = errors(wf({ kind: "side-effect", sessionPolicy: "fresh", outcome: namedOutcome, iterate: iter }));
		expect(e.some((i) => /iterate requires kind "produces"/.test(i.message))).toBe(true);
	});

	it("rejects iterate when the outcome has no name", () => {
		const e = errors(
			wf({ kind: "produces", sessionPolicy: "fresh", outcome: { collector: noopCollector }, iterate: iter }),
		);
		expect(e.some((i) => /iterate requires an `outcome` with a `name`/.test(i.message))).toBe(true);
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
		const e = errors(wf({ kind: "side-effect", sessionPolicy: "fresh", prompt: "x", skill: "implement" }));
		expect(e.some((i) => /a prompt stage cannot also set `skill`/.test(i.message))).toBe(true);
	});

	it("rejects prompt + fanout", () => {
		const e = errors(wf({ kind: "side-effect", sessionPolicy: "fresh", prompt: "x", fanout: () => [] }));
		expect(e.some((i) => /prompt and fanout are mutually exclusive/.test(i.message))).toBe(true);
	});

	it("rejects prompt + iterate", () => {
		const e = errors(
			wf({
				kind: "produces",
				sessionPolicy: "fresh",
				prompt: "x",
				outcome: { name: "p", collector: noopCollector },
				iterate: () => null,
			}),
		);
		expect(e.some((i) => /prompt and iterate are mutually exclusive/.test(i.message))).toBe(true);
	});

	it("rejects prompt + reads", () => {
		const e = errors(wf({ kind: "side-effect", sessionPolicy: "fresh", prompt: "x", reads: ["plans"] }));
		expect(e.some((i) => /a prompt stage cannot set `reads`/.test(i.message))).toBe(true);
	});

	it("rejects prompt + run (a script stage cannot set a raw prompt)", () => {
		const e = errors(wf({ kind: "side-effect", sessionPolicy: "fresh", prompt: "x", run: noopActsScript }));
		expect(e.some((i) => /script stages cannot set a raw prompt/.test(i.message))).toBe(true);
	});

	it("rejects an empty-string prompt", () => {
		const e = errors(wf({ kind: "side-effect", sessionPolicy: "fresh", prompt: "   " }));
		expect(e.some((i) => /prompt is an empty string/.test(i.message))).toBe(true);
	});

	it("requires an outcome on a produces prompt stage (no run carve-out)", () => {
		const e = errors(wf({ kind: "produces", sessionPolicy: "fresh", prompt: "write it" }));
		expect(e.some((i) => /has kind "produces" but no `outcome`/.test(i.message))).toBe(true);
	});

	it("warns when a continue prompt stage is the workflow start", () => {
		const w = wf({ kind: "side-effect", sessionPolicy: "continue", prompt: "follow up" });
		expect(warnings(w).some((i) => /continue prompt stage is the workflow start/.test(i.message))).toBe(true);
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
		expect(ws.some((i) => /schema incompatibility/.test(i.message))).toBe(true);
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
		expect(warnings(w).filter((i) => /schema incompatibility/.test(i.message))).toEqual([]);
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
		expect(warnings(w).filter((i) => /schema incompatibility/.test(i.message))).toEqual([]);
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
				a: gate("x", { b: gt(0), c: eq(0) }),
				b: "stop",
				c: "stop",
			},
		};
		expect(warnings(w).filter((i) => /schema incompatibility/.test(i.message))).toEqual([]);
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
			(i) => i.severity === "warning" && /schema incompatibility/.test(i.message),
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
		expect(issues.some((i) => i.severity === "warning" && /schema incompatibility/.test(i.message))).toBe(true);
	});

	it("does NOT warn on stop edges", () => {
		const w: Workflow = {
			name: "stop-edge",
			start: "a",
			stages: { a: produces() },
			edges: { a: "stop" },
		};
		expect(warnings(w).filter((i) => /schema incompatibility/.test(i.message))).toEqual([]);
	});
});

describe("checkFanoutSource (control-flow source lint)", () => {
	const fanoutMsgs = (w: Workflow) => warnings(w).filter((i) => /(fans out|iterates) over/.test(i.message));

	it("warns when a fanout spec's source is not published by any produces stage", () => {
		const w: Workflow = {
			name: "t",
			start: "start",
			stages: {
				start: produces(),
				impl: acts({ fanout: fanoutOver({ source: "plans", run: () => [] }) }),
			},
			edges: { start: "impl", impl: "stop" },
		};
		const msgs = fanoutMsgs(w);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]?.message).toContain('fans out over source "plans"');
	});

	it("warns when an iterate spec's source is unpublished (the no-`reads` case)", () => {
		const w: Workflow = {
			name: "t",
			start: "start",
			stages: {
				start: produces(),
				bp: produces({ iterate: iterateOver({ source: "architecture-reviews", run: () => null }) }),
			},
			edges: { start: "bp", bp: "stop" },
		};
		expect(fanoutMsgs(w).some((i) => /iterates over source "architecture-reviews"/.test(i.message))).toBe(true);
	});

	it("is silent when the source IS published", () => {
		const w: Workflow = {
			name: "t",
			start: "plans",
			stages: {
				plans: produces(), // publishes channel "plans" (outcome.name ?? record-key)
				impl: acts({ fanout: fanoutOver({ source: "plans", run: () => [] }) }),
			},
			edges: { plans: "impl", impl: "stop" },
		};
		expect(fanoutMsgs(w)).toEqual([]);
	});

	it("defers to checkReadsReferences when the source is in the stage's reads (no double-report)", () => {
		const w: Workflow = {
			name: "t",
			start: "start",
			stages: {
				start: produces(),
				impl: acts({ fanout: fanoutOver({ source: "plans", run: () => [] }), reads: ["plans"] }),
			},
			edges: { start: "impl", impl: "stop" },
		};
		// reads owns "plans" (errors); checkFanoutSource stays quiet
		expect(fanoutMsgs(w)).toEqual([]);
		expect(errors(w).some((i) => /reads "plans"/.test(i.message))).toBe(true);
	});

	it("is silent for a raw fanout with no spec (opaque → degrade)", () => {
		const w: Workflow = {
			name: "t",
			start: "start",
			stages: {
				start: produces(),
				impl: acts({ fanout: () => [] }),
			},
			edges: { start: "impl", impl: "stop" },
		};
		expect(fanoutMsgs(w)).toEqual([]);
	});
});
