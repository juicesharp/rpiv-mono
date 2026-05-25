/**
 * Tests for the workflow list/detail formatters. Pure functions over a
 * hand-built LoadedWorkflows — no filesystem, no Pi.
 */

import { describe, expect, it } from "vitest";
import { acts, defineWorkflow, produces, type StageDef, threshold, type Workflow } from "./api.js";
import type { LoadedWorkflows } from "./load/index.js";
import { gitCommitOutcome } from "./outcomes/index.js";
import { formatWorkflowDetails, formatWorkflowList } from "./preview.js";

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
				"code-review": threshold("severeIssueCount", 0, "revise", "commit"),
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
		};
		const out = formatWorkflowDetails(loaded, "aliased");
		const aliasLine = out.split("\n").find((l) => /implement-after-revise/.test(l)) ?? "";
		expect(aliasLine).toContain("implement-after-revise (skill: implement)");
	});
});
