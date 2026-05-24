/**
 * Tests for `validateWorkflow` — load-time graph checks.
 *
 * Each test builds a small `Workflow` by hand and asserts the issues it
 * produces. The built-in workflows get a smoke pass (zero errors expected).
 */

import { describe, expect, it } from "vitest";
import { action, defineWorkflow, type EdgeFn, skill, threshold, type Workflow } from "./api.js";
import { builtInWorkflows } from "./built-in.js";
import { validateWorkflow } from "./validate.js";

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
			nodes: { a: skill("a"), b: action("b") },
			edges: { a: "b", b: "stop" },
		});
		expect(errors(w)).toEqual([]);
	});

	it("returns zero issues for the built-in workflows", () => {
		for (const w of builtInWorkflows) {
			const issues = validateWorkflow(w);
			expect(
				issues.filter((i) => i.severity === "error"),
				`${w.name} errors`,
			).toEqual([]);
			expect(
				issues.filter((i) => i.severity === "warning"),
				`${w.name} warnings`,
			).toEqual([]);
		}
	});
});

// ---------------------------------------------------------------------------
// start node checks
// ---------------------------------------------------------------------------

describe("validateWorkflow — start", () => {
	it("errors when start is not in nodes", () => {
		const w: Workflow = {
			name: "bad-start",
			start: "ghost",
			nodes: { a: skill("a") },
			edges: { a: "stop" },
		};
		const e = errors(w);
		expect(e).toHaveLength(1);
		expect(e[0]!.message).toMatch(/start node "ghost" is not declared/);
	});
});

// ---------------------------------------------------------------------------
// edge-key checks
// ---------------------------------------------------------------------------

describe("validateWorkflow — edge keys", () => {
	it("errors when an edges key isn't a declared node", () => {
		const w: Workflow = {
			name: "stray-edge",
			start: "a",
			nodes: { a: skill("a") },
			edges: { a: "stop", phantom: "a" },
		};
		const e = errors(w);
		expect(e.some((i) => /edges\["phantom"\] references a node that's not declared/.test(i.message))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// edge-target checks
// ---------------------------------------------------------------------------

describe("validateWorkflow — edge targets", () => {
	it("errors when a string target isn't a declared node", () => {
		const w: Workflow = {
			name: "bad-target",
			start: "a",
			nodes: { a: skill("a"), b: skill("b") },
			edges: { a: "missing", b: "stop" },
		};
		const e = errors(w);
		expect(e.some((i) => i.node === "a" && /resolves to "missing" which is not declared/.test(i.message))).toBe(true);
	});

	it('accepts "stop" as a terminal target', () => {
		const w: Workflow = {
			name: "leaf",
			start: "a",
			nodes: { a: skill("a") },
			edges: { a: "stop" },
		};
		expect(errors(w)).toEqual([]);
	});

	it("checks every branch of an EdgeFn via .targets metadata", () => {
		const w: Workflow = {
			name: "predicate",
			start: "a",
			nodes: { a: skill("a"), good: skill("good") },
			// threshold writes .targets = ["good", "bad"] — "bad" isn't a declared node.
			edges: { a: threshold("count", 0, "good", "bad"), good: "stop" },
		};
		const e = errors(w);
		expect(e.some((i) => /resolves to "bad"/.test(i.message))).toBe(true);
	});

	it("errors on an EdgeFn without .targets metadata (no probe fallback)", () => {
		// A hand-rolled EdgeFn that skips `definePredicate` / `threshold` carries
		// no `.targets` annotation. validate.ts refuses to probe — the missing
		// metadata makes reachability + status-line totals structurally unsound.
		const handCrafted: EdgeFn = () => "ghost";
		const w: Workflow = {
			name: "naked",
			start: "a",
			nodes: { a: skill("a") },
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
	it('warns on nodes with no edge entry (suggest `: "stop"`)', () => {
		const w: Workflow = {
			name: "implicit",
			start: "a",
			nodes: { a: skill("a"), b: skill("b") },
			edges: { a: "b" }, // b has no edge — implicit terminal
		};
		const w2 = warnings(w);
		expect(w2.some((i) => i.node === "b" && /has no edge — treated as terminal/.test(i.message))).toBe(true);
	});

	it('does not warn when terminal is declared with "stop"', () => {
		const w: Workflow = {
			name: "explicit",
			start: "a",
			nodes: { a: skill("a"), b: skill("b") },
			edges: { a: "b", b: "stop" },
		};
		expect(warnings(w)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

describe("validateWorkflow — reachability", () => {
	it("warns on orphan nodes unreachable from start", () => {
		const w: Workflow = {
			name: "orphan",
			start: "a",
			nodes: { a: skill("a"), b: skill("b"), orphan: skill("orphan") },
			edges: { a: "b", b: "stop", orphan: "stop" },
		};
		const w2 = warnings(w);
		expect(w2.some((i) => i.node === "orphan" && /unreachable from start "a"/.test(i.message))).toBe(true);
	});

	it("treats EdgeFn branches as reachable via .targets metadata", () => {
		const w: Workflow = {
			name: "branching",
			start: "a",
			nodes: { a: skill("a"), x: skill("x"), y: skill("y") },
			// Both x and y are reachable through the threshold.
			edges: { a: threshold("count", 0, "x", "y"), x: "stop", y: "stop" },
		};
		const w2 = warnings(w);
		expect(w2.find((i) => /unreachable/.test(i.message))).toBeUndefined();
	});

	it("treats a back-edge cycle as reachable (e.g. revise loop)", () => {
		const w: Workflow = {
			name: "loop",
			start: "implement",
			nodes: {
				implement: action("implement"),
				validate: skill("validate"),
				revise: skill("revise"),
				commit: action("commit"),
			},
			edges: {
				implement: "validate",
				validate: threshold("severeIssueCount", 0, "revise", "commit"),
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

describe("validateWorkflow — semantic node constraints", () => {
	const baseWithNode = (overrides: Partial<import("./api.js").NodeDef>): Workflow => ({
		name: "semantic",
		start: "a",
		nodes: { a: { ...skill("a"), ...overrides } },
		edges: { a: "stop" },
	});

	it("errors on maxValidationRetries below the floor", () => {
		const issues = validateWorkflow(baseWithNode({ maxValidationRetries: 0 }));
		expect(issues.some((i) => i.severity === "error" && /maxValidationRetries: 0/.test(i.message))).toBe(true);
	});

	it("errors on maxValidationRetries above the ceiling", () => {
		const issues = validateWorkflow(baseWithNode({ maxValidationRetries: 100 }));
		expect(issues.some((i) => i.severity === "error" && /maxValidationRetries: 100/.test(i.message))).toBe(true);
	});

	it("errors on validationRetryTimeoutMs out of range", () => {
		const issues = validateWorkflow(baseWithNode({ validationRetryTimeoutMs: 0 }));
		expect(issues.some((i) => i.severity === "error" && /validationRetryTimeoutMs: 0/.test(i.message))).toBe(true);
	});

	it("errors on unknown onValidationFailure value", () => {
		const issues = validateWorkflow(
			baseWithNode({ onValidationFailure: "burn-it-down" as unknown as "retry" | "halt" }),
		);
		expect(issues.some((i) => i.severity === "error" && /onValidationFailure: "burn-it-down"/.test(i.message))).toBe(
			true,
		);
	});

	it("accepts the documented onValidationFailure values", () => {
		expect(
			validateWorkflow(baseWithNode({ onValidationFailure: "retry" })).filter((i) => i.severity === "error"),
		).toEqual([]);
		expect(
			validateWorkflow(baseWithNode({ onValidationFailure: "halt" })).filter((i) => i.severity === "error"),
		).toEqual([]);
	});
});

describe("validateWorkflow — predicate-edge schema check", () => {
	it("warns when a predicate edge reads from a node without outputSchema", () => {
		const w: Workflow = {
			name: "naked",
			start: "code-review",
			nodes: { "code-review": skill("code-review"), revise: skill("revise"), commit: action("commit") },
			edges: {
				"code-review": threshold("severeIssueCount", 0, "revise", "commit"),
				revise: "commit",
				commit: "stop",
			},
		};
		const issues = validateWorkflow(w);
		expect(
			issues.some((i) => i.severity === "warning" && i.node === "code-review" && /outputSchema/.test(i.message)),
		).toBe(true);
	});

	it("does not warn when the predicate source carries an outputSchema", () => {
		const w: Workflow = {
			name: "clothed",
			start: "code-review",
			nodes: {
				"code-review": skill("code-review", { outputSchema: { type: "object" } as never }),
				revise: skill("revise"),
				commit: action("commit"),
			},
			edges: {
				"code-review": threshold("severeIssueCount", 0, "revise", "commit"),
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
			nodes: { a: skill("a") },
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
	it("attaches workflow name + node to every issue", () => {
		const w: Workflow = {
			name: "bad",
			start: "ghost",
			nodes: { a: skill("a") },
			edges: { a: "missing" },
		};
		const issues = validateWorkflow(w);
		for (const i of issues) {
			expect(i.workflow).toBe("bad");
		}
		// At least one issue carries a specific node attribution.
		expect(issues.some((i) => i.node === "a")).toBe(true);
	});
});
