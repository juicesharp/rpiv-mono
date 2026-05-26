/**
 * Tests for `validateWorkflow` — load-time graph checks.
 *
 * Each test builds a small `Workflow` by hand and asserts the issues it
 * produces. The built-in workflows get a smoke pass (zero errors expected).
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	acts,
	defineRoute,
	defineWorkflow,
	type EdgeFn,
	gate,
	produces as producesRaw,
	type StageDef,
	type Workflow,
} from "./api.js";
import { noopCollector } from "./outcomes/index.js";
import { eq, gt } from "./predicates.js";
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
// Semantic checks — restored from the old validateDag (SB2)
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
		// lint — closes the I3 gap where the marker was opt-in.
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
