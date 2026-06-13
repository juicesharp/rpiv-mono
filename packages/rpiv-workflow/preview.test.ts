/**
 * Tests for the workflow list/detail formatters. Pure functions over a
 * hand-built LoadedWorkflows — no filesystem, no Pi.
 */

import { describe, expect, it } from "vitest";
import { acts, defineWorkflow, gate, produces, type StageDef, type Workflow } from "./api.js";
import { judge } from "./judge.js";
import type { LoadedWorkflows } from "./load/index.js";
import { assess, fanout, iterate, majority, panel, verify } from "./loop-constructors.js";
import { gitCommitOutcome } from "./outcomes/index.js";
import { eq, gt } from "./predicates.js";
import { formatWorkflowDetails, formatWorkflowList } from "./preview.js";
import type { SkillContract } from "./skill-contract.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const stage = (overrides: Partial<StageDef> & { skill: string }): StageDef => ({
	kind: "side-effect",
	sessionPolicy: "fresh",
	...overrides,
});

const midWorkflow = defineWorkflow({
	name: "mid",
	start: "research",
	stages: {
		research: stage({ skill: "research", kind: "produces" }),
		implement: stage({ skill: "implement" }),
		commit: stage({ skill: "commit", outcome: gitCommitOutcome }),
	},
	edges: { research: "implement", implement: "commit", commit: "stop" },
});

const tinyWorkflow = defineWorkflow({
	name: "tiny",
	start: "research",
	stages: {
		research: produces(),
		commit: acts(),
	},
	edges: { research: "commit", commit: "stop" },
});

const baseLoaded = (overrides: Partial<LoadedWorkflows> = {}): LoadedWorkflows => ({
	workflows: [midWorkflow, tinyWorkflow],
	default: "mid",
	workflowSources: new Map([
		["mid", "built-in"],
		["tiny", "project"],
	]),
	layers: ["built-in", "project"],
	issues: [],
	skillAliases: {},
	skillContracts: new Map(),
	...overrides,
});

// ---------------------------------------------------------------------------
// formatWorkflowList
// ---------------------------------------------------------------------------

describe("formatWorkflowList", () => {
	it("lists every workflow with its stage count and source layer", () => {
		const out = formatWorkflowList(baseLoaded());
		expect(out).toContain("mid");
		expect(out).toContain("3 stages");
		expect(out).toContain("[built-in]");
		expect(out).toContain("tiny");
		expect(out).toContain("2 stages");
		expect(out).toContain("[project]");
	});

	it("annotates the default workflow with (default)", () => {
		const out = formatWorkflowList(baseLoaded());
		const midLine = out.split("\n").find((l) => l.trimStart().startsWith("mid")) ?? "";
		expect(midLine).toContain("(default)");
		const tinyLine = out.split("\n").find((l) => l.trimStart().startsWith("tiny")) ?? "";
		expect(tinyLine).not.toContain("(default)");
	});

	it("renders a single-line source banner for the merged layer set", () => {
		const out = formatWorkflowList(baseLoaded());
		expect(out).toContain("Sources: built-in + project");
	});

	it("includes both usage hints — run and preview", () => {
		const out = formatWorkflowList(baseLoaded());
		expect(out).toContain("Usage: /wf [workflow] <description>");
		expect(out).toContain("/wf <workflow>");
		expect(out).toContain("preview stages");
	});

	it("renders single-layer banner when only built-in is active", () => {
		const out = formatWorkflowList(
			baseLoaded({
				layers: ["built-in"],
				workflowSources: new Map([
					["mid", "built-in"],
					["tiny", "built-in"],
				]),
			}),
		);
		expect(out).toContain("Sources: built-in");
	});

	it("appends the workflow description after the tags", () => {
		const described: Workflow = {
			name: "described",
			description: "Short summary for the list view.",
			start: "research",
			stages: { research: produces(), commit: acts() },
			edges: { research: "commit", commit: "stop" },
		};
		const loaded: LoadedWorkflows = {
			workflows: [described],
			default: "described",
			workflowSources: new Map([["described", "built-in"]]),
			layers: ["built-in"],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		};
		const out = formatWorkflowList(loaded);
		const descLine = out.split("\n").find((l) => l.includes("described")) ?? "";
		expect(descLine).toContain("Short summary for the list view.");
	});

	it("truncates long descriptions at 50 characters with ellipsis", () => {
		const longDesc = "This is a very long description that definitely exceeds the fifty character limit for sure.";
		const described: Workflow = {
			name: "long",
			description: longDesc,
			start: "research",
			stages: { research: produces(), commit: acts() },
			edges: { research: "commit", commit: "stop" },
		};
		const loaded: LoadedWorkflows = {
			workflows: [described],
			default: "long",
			workflowSources: new Map([["long", "built-in"]]),
			layers: ["built-in"],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		};
		const out = formatWorkflowList(loaded);
		const descLine = out.split("\n").find((l) => l.includes("long")) ?? "";
		expect(descLine).toContain("This is a very long description that definitely...");
		expect(descLine).not.toContain("for sure");
	});

	it("omits the description field when workflow has no description", () => {
		const out = formatWorkflowList(baseLoaded());
		const midLine = out.split("\n").find((l) => l.trimStart().startsWith("mid")) ?? "";
		// Column padding may insert multi-space separators between fields.
		expect(midLine.trim()).toMatch(/^mid\s+\d+ stages\s+\[built-in\]\s+\(default\)$/);
	});
});

// ---------------------------------------------------------------------------
// formatWorkflowDetails
// ---------------------------------------------------------------------------

describe("formatWorkflowDetails", () => {
	it("renders the header with layer + default tags", () => {
		const out = formatWorkflowDetails(baseLoaded(), "mid");
		expect(out).toContain("workflow: mid  (built-in, default)");
	});

	it("renders header without (default) tag for non-default workflows", () => {
		const out = formatWorkflowDetails(baseLoaded(), "tiny");
		expect(out).toContain("workflow: tiny  (project)");
		expect(out).not.toContain("workflow: tiny  (project, default)");
	});

	it("numbers stages 1-based and shows kind + sessionPolicy", () => {
		const out = formatWorkflowDetails(baseLoaded(), "mid");
		const lines = out.split("\n");
		expect(lines.some((l) => /^\s+1\.\s+research\b/.test(l))).toBe(true);
		expect(lines.some((l) => /^\s+2\.\s+implement\b/.test(l))).toBe(true);
		expect(lines.some((l) => /^\s+3\.\s+commit\b/.test(l))).toBe(true);
		// research has kind: "produces"
		expect(lines.find((l) => /research/.test(l))).toContain("produces");
		expect(lines.find((l) => /research/.test(l))).toContain("fresh");
	});

	it("tags custom-outcome stages that declare a snapshot + parser with a single 'custom+snapshot+parser' decoration", () => {
		const out = formatWorkflowDetails(baseLoaded(), "mid");
		const commitLine = out.split("\n").find((l) => /^\s+\d+\.\s+commit\b/.test(l)) ?? "";
		// gitCommitOutcome carries both snapshot (via collector) and parser.
		expect(commitLine).toContain("custom+snapshot+parser");
		expect(commitLine).not.toContain("· custom ·"); // not double-tagged
	});

	it("tags produces stages without an outcome with '???' (load-time validation should reject; tag is defensive)", () => {
		const out = formatWorkflowDetails(baseLoaded(), "mid");
		const researchLine = out.split("\n").find((l) => /^\s+\d+\.\s+research\b/.test(l)) ?? "";
		expect(researchLine).toContain("???");
	});

	it("tags side-effect stages (no override) with the default 'side-effect' outcome", () => {
		const out = formatWorkflowDetails(baseLoaded(), "mid");
		const implementLine = out.split("\n").find((l) => /^\s+\d+\.\s+implement\b/.test(l)) ?? "";
		expect(implementLine).toContain("side-effect");
	});

	it("throws when asked to render a workflow not in the loaded set", () => {
		expect(() => formatWorkflowDetails(baseLoaded(), "does-not-exist")).toThrow(
			/workflow "does-not-exist" not found/,
		);
	});

	it("renders the predicate target set inline for EdgeFn edges", () => {
		const branchingWorkflow: Workflow = {
			name: "branching",
			start: "code-review",
			stages: {
				"code-review": produces(),
				revise: produces(),
				commit: acts(),
			},
			edges: {
				"code-review": gate("severeIssueCount", { revise: gt(0), commit: eq(0) }, "commit"),
				revise: "commit",
				commit: "stop",
			},
		};
		const loaded: LoadedWorkflows = {
			workflows: [branchingWorkflow],
			default: "branching",
			workflowSources: new Map([["branching", "built-in"]]),
			layers: ["built-in"],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		};
		const out = formatWorkflowDetails(loaded, "branching");
		const crLine = out.split("\n").find((l) => /code-review/.test(l)) ?? "";
		expect(crLine).toContain("predicate(revise | commit)");
	});

	it("emits a per-workflow usage hint", () => {
		const out = formatWorkflowDetails(baseLoaded(), "tiny");
		expect(out).toContain("Usage: /wf tiny <description>");
	});

	it("renders workflow.description between the heading and the stage list", () => {
		const described: Workflow = {
			name: "described",
			description: "Short prose summary for the preview header.",
			start: "research",
			stages: { research: produces(), commit: acts() },
			edges: { research: "commit", commit: "stop" },
		};
		const loaded: LoadedWorkflows = {
			workflows: [described],
			default: "described",
			workflowSources: new Map([["described", "built-in"]]),
			layers: ["built-in"],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		};
		const out = formatWorkflowDetails(loaded, "described");
		const lines = out.split("\n");
		const headingIdx = lines.findIndex((l) => l.startsWith("workflow: described"));
		expect(headingIdx).toBeGreaterThanOrEqual(0);
		expect(lines[headingIdx + 1]).toBe("Short prose summary for the preview header.");
	});

	it("tags stages with in-schema / out-schema when StageDef carries inputSchema / outputSchema", () => {
		const fakeSchema = { "~standard": { vendor: "test", version: 1, validate: () => ({ value: {} }) } } as never;
		const schemaWorkflow: Workflow = {
			name: "schemas",
			start: "a",
			stages: {
				a: produces({ outputSchema: fakeSchema }),
				b: produces({ inputSchema: fakeSchema, outputSchema: fakeSchema }),
				c: acts(),
			},
			edges: { a: "b", b: "c", c: "stop" },
		};
		const loaded: LoadedWorkflows = {
			workflows: [schemaWorkflow],
			default: "schemas",
			workflowSources: new Map([["schemas", "built-in"]]),
			layers: ["built-in"],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		};
		const out = formatWorkflowDetails(loaded, "schemas");
		const lines = out.split("\n");
		const aLine = lines.find((l) => /^\s+\d+\.\s+a\b/.test(l)) ?? "";
		const bLine = lines.find((l) => /^\s+\d+\.\s+b\b/.test(l)) ?? "";
		const cLine = lines.find((l) => /^\s+\d+\.\s+c\b/.test(l)) ?? "";
		expect(aLine).toContain("out-schema");
		expect(aLine).not.toContain("in-schema");
		expect(bLine).toContain("in-schema");
		expect(bLine).toContain("out-schema");
		expect(cLine).not.toContain("in-schema");
		expect(cLine).not.toContain("out-schema");
	});

	it("renders the loop tag for an assess stage — skill judge", () => {
		const verdictSpec = { name: "verdicts", collector: { snapshot: false } } as never;
		const assessWorkflow: Workflow = {
			name: "assessed",
			start: "breakdown",
			stages: {
				breakdown: produces({
					loop: assess({
						judge: judge({ skill: "grade-breakdown", outcome: verdictSpec }),
						done: () => true,
						feedForward: () => "decompose further",
						max: 5,
					}),
				}),
				commit: acts(),
			},
			edges: { breakdown: "commit", commit: "stop" },
		};
		const loaded: LoadedWorkflows = {
			workflows: [assessWorkflow],
			default: "assessed",
			workflowSources: new Map([["assessed", "built-in"]]),
			layers: ["built-in"],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		};
		const out = formatWorkflowDetails(loaded, "assessed");
		const bdLine = out.split("\n").find((l) => /breakdown/.test(l)) ?? "";
		expect(bdLine).toContain("assess(judge: skill:grade-breakdown)·max=5");
	});

	it("renders the loop tag for an assess stage — prompt judge with default max", () => {
		const verdictSpec = { name: "verdicts", collector: { snapshot: false } } as never;
		const assessWorkflow: Workflow = {
			name: "assessed-prompt",
			start: "breakdown",
			stages: {
				breakdown: produces({
					loop: assess({
						judge: judge({ prompt: "Are all tasks atomic?", outcome: verdictSpec }),
						done: () => true,
						feedForward: () => "decompose further",
					}),
				}),
				commit: acts(),
			},
			edges: { breakdown: "commit", commit: "stop" },
		};
		const loaded: LoadedWorkflows = {
			workflows: [assessWorkflow],
			default: "assessed-prompt",
			workflowSources: new Map([["assessed-prompt", "built-in"]]),
			layers: ["built-in"],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		};
		const out = formatWorkflowDetails(loaded, "assessed-prompt");
		const bdLine = out.split("\n").find((l) => /breakdown/.test(l)) ?? "";
		expect(bdLine).toContain("assess(judge: prompt)·max=8");
	});

	it("renders the loop tag for an assess stage — N-judge panel (fan-in + fold name)", () => {
		const vspec = (name: string) => ({ name, collector: { snapshot: false } }) as never;
		const panelWorkflow: Workflow = {
			name: "paneled",
			start: "breakdown",
			stages: {
				breakdown: produces({
					loop: assess({
						judge: panel({
							members: [
								judge({ skill: "grade-a", outcome: vspec("va") }),
								judge({ skill: "grade-b", outcome: vspec("vb") }),
								judge({ skill: "grade-c", outcome: vspec("vc") }),
							],
							fold: majority(() => true),
						}),
						done: () => true,
						feedForward: () => "again",
						max: 5,
					}),
				}),
				commit: acts(),
			},
			edges: { breakdown: "commit", commit: "stop" },
		};
		const loaded: LoadedWorkflows = {
			workflows: [panelWorkflow],
			default: "paneled",
			workflowSources: new Map([["paneled", "built-in"]]),
			layers: ["built-in"],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		};
		const out = formatWorkflowDetails(loaded, "paneled");
		const bdLine = out.split("\n").find((l) => /breakdown/.test(l)) ?? "";
		expect(bdLine).toContain("assess(judge: panel(3, majority))·max=5");
	});

	it("renders the verify tag for a panel post-condition", () => {
		const vspec = (name: string) => ({ name, collector: { snapshot: false } }) as never;
		const verifyWorkflow: Workflow = {
			name: "gated",
			start: "build",
			stages: {
				build: produces({
					outcome: { name: "impl", collector: { snapshot: false } } as never,
					verify: verify({
						judge: panel({
							members: [
								judge({ skill: "grade-a", outcome: vspec("va") }),
								judge({ skill: "grade-b", outcome: vspec("vb") }),
							],
							fold: majority(() => true),
						}),
						done: () => true,
					}),
				}),
			},
			edges: { build: "stop" },
		};
		const loaded: LoadedWorkflows = {
			workflows: [verifyWorkflow],
			default: "gated",
			workflowSources: new Map([["gated", "built-in"]]),
			layers: ["built-in"],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		};
		const out = formatWorkflowDetails(loaded, "gated");
		const buildLine = out.split("\n").find((l) => /build/.test(l)) ?? "";
		expect(buildLine).toContain("verify(panel(2, majority))");
	});

	it("renders the loop tag for fanout / iterate stages (max and bare kind)", () => {
		const loopWorkflow: Workflow = {
			name: "looped",
			start: "build",
			stages: {
				build: acts({ loop: fanout({ units: () => [], max: 32 }) }),
				bp: produces({
					outcome: { name: "plans", collector: { snapshot: false } } as never,
					loop: iterate({ next: () => null }),
				}),
				commit: acts(),
			},
			edges: { build: "bp", bp: "commit", commit: "stop" },
		};
		const loaded: LoadedWorkflows = {
			workflows: [loopWorkflow],
			default: "looped",
			workflowSources: new Map([["looped", "built-in"]]),
			layers: ["built-in"],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		};
		const out = formatWorkflowDetails(loaded, "looped");
		const buildLine = out.split("\n").find((l) => /^\s*\d+\.\s+build\b/.test(l)) ?? "";
		const bpLine = out.split("\n").find((l) => /^\s*\d+\.\s+bp\b/.test(l)) ?? "";
		expect(buildLine).toContain("fanout·max=32");
		expect(bpLine).toContain("iterate");
		expect(bpLine).not.toContain("iterate·max");
	});

	it("annotates aliased stages with (skill: <body>) when stage.skill differs from the stage id", () => {
		const aliased: Workflow = {
			name: "aliased",
			start: "implement-after-revise",
			stages: {
				"implement-after-revise": stage({ skill: "implement" }),
				commit: acts(),
			},
			edges: { "implement-after-revise": "commit", commit: "stop" },
		};
		const loaded: LoadedWorkflows = {
			workflows: [aliased],
			default: "aliased",
			workflowSources: new Map([["aliased", "built-in"]]),
			layers: ["built-in"],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		};
		const out = formatWorkflowDetails(loaded, "aliased");
		const aliasLine = out.split("\n").find((l) => /implement-after-revise/.test(l)) ?? "";
		expect(aliasLine).toContain("implement-after-revise (skill: implement)");
	});
});

// ---------------------------------------------------------------------------
// Skill-alias banner — shown in both formatters when aliases are in effect
// ---------------------------------------------------------------------------

describe("skill-alias banner", () => {
	it("renders the banner in the details view when aliases are in effect", () => {
		const out = formatWorkflowDetails(
			baseLoaded({ skillAliases: { commit: "attributed-commit", "code-review": "strict-review" } }),
			"mid",
		);
		expect(out).toContain("Skill aliases in effect: commit → attributed-commit, code-review → strict-review");
	});

	it("renders the banner in the list view when aliases are in effect", () => {
		const out = formatWorkflowList(baseLoaded({ skillAliases: { commit: "attributed-commit" } }));
		expect(out).toContain("Skill aliases in effect: commit → attributed-commit");
	});

	it("omits the banner when no aliases are in effect", () => {
		expect(formatWorkflowDetails(baseLoaded(), "mid")).not.toContain("Skill aliases in effect");
		expect(formatWorkflowList(baseLoaded())).not.toContain("Skill aliases in effect");
	});
});

describe("skill-contracts banner", () => {
	const contract = (source: SkillContract["source"]): SkillContract => ({ source });

	it("tallies declared vs harvested contracts in the list view", () => {
		const out = formatWorkflowList(
			baseLoaded({
				skillContracts: new Map([
					["research", contract("declared")],
					["design", contract("declared")],
					["plan", contract("declared")],
					["implement", contract("harvested")],
					["commit", contract("harvested")],
				]),
			}),
		);
		expect(out).toContain("Skill contracts: 3 declared, 2 harvested");
	});

	it("omits the banner when no contracts are in effect", () => {
		expect(formatWorkflowList(baseLoaded())).not.toContain("Skill contracts:");
	});
});
