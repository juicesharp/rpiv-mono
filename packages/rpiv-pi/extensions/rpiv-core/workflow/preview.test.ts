/**
 * Tests for the workflow list/detail formatters. Pure functions over a
 * hand-built LoadedWorkflows — no filesystem, no Pi.
 */

import { describe, expect, it } from "vitest";
import { action, artifact, defineWorkflow, type NodeDef, threshold, type Workflow } from "./api.js";
import { gitCommitExtractor } from "./extractors/index.js";
import type { LoadedWorkflows } from "./load.js";
import { formatWorkflowDetails, formatWorkflowList } from "./preview.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const node = (overrides: Partial<NodeDef> & { skill: string }): NodeDef => ({
	completionStrategy: "agent-end",
	sessionPolicy: "fresh",
	...overrides,
});

const midWorkflow = defineWorkflow({
	name: "mid",
	start: "research",
	nodes: {
		research: node({ skill: "research", completionStrategy: "artifact-emit" }),
		implement: node({ skill: "implement" }),
		commit: node({ skill: "commit", extractor: gitCommitExtractor }),
	},
	edges: { research: "implement", implement: "commit", commit: "stop" },
});

const tinyWorkflow = defineWorkflow({
	name: "tiny",
	start: "research",
	nodes: {
		research: artifact(),
		commit: action(),
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
		expect(out).toContain("Usage: /rpiv [workflow] <description>");
		expect(out).toContain("/rpiv <workflow>");
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

	it("numbers stages 1-based and shows completionStrategy + sessionPolicy", () => {
		const out = formatWorkflowDetails(baseLoaded(), "mid");
		const lines = out.split("\n");
		expect(lines.some((l) => /^\s+1\.\s+research\b/.test(l))).toBe(true);
		expect(lines.some((l) => /^\s+2\.\s+implement\b/.test(l))).toBe(true);
		expect(lines.some((l) => /^\s+3\.\s+commit\b/.test(l))).toBe(true);
		// research has completionStrategy: "artifact-emit"
		expect(lines.find((l) => /research/.test(l))).toContain("artifact-emit");
		expect(lines.find((l) => /research/.test(l))).toContain("fresh");
	});

	it("decorates stages whose node carries snapshot / extractor", () => {
		const out = formatWorkflowDetails(baseLoaded(), "mid");
		const commitLine = out.split("\n").find((l) => /^\s+\d+\.\s+commit\b/.test(l)) ?? "";
		expect(commitLine).toContain("snapshot");
		expect(commitLine).toContain("extractor");
	});

	it("does NOT show snapshot / extractor decoration for plain nodes", () => {
		const out = formatWorkflowDetails(baseLoaded(), "mid");
		const implementLine = out.split("\n").find((l) => /^\s+\d+\.\s+implement\b/.test(l)) ?? "";
		expect(implementLine).not.toContain("snapshot");
		expect(implementLine).not.toContain("extractor");
	});

	it("falls through to formatWorkflowList for unknown workflow names", () => {
		const out = formatWorkflowDetails(baseLoaded(), "does-not-exist");
		expect(out).toContain("Available workflows:");
	});

	it("renders the predicate target set inline for EdgeFn edges", () => {
		const branchingWorkflow: Workflow = {
			name: "branching",
			start: "code-review",
			nodes: {
				"code-review": artifact(),
				revise: artifact(),
				commit: action(),
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
		expect(out).toContain("Usage: /rpiv tiny <description>");
	});
});
