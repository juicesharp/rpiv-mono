/**
 * Load-time graph validation for `Workflow` objects — the thin orchestrator.
 *
 * Catches the wiring mistakes a TS type system can't reach on its own:
 * unknown edge sources/targets, unreachable stages, missing terminals,
 * predicate functions that return targets outside the stage set.
 *
 * `validateWorkflow` returns a flat array of `WorkflowValidationIssue`s —
 * each carrying a machine-readable `code` (the stable contract — filter and
 * assert on codes, never message text), structured `params`, and prose
 * rendered by the ONE renderer in `validate/issue.ts`. Errors are problems
 * that would crash the runner; warnings are shapes that work but probably
 * aren't what the author intended. The load pipeline can choose to halt on
 * any error and surface warnings non-fatally.
 *
 * No I/O, no throws — purely a graph walk + predicate probe.
 *
 * Module map (mirrors the `load/` decomposition):
 *   ./validate/issue.ts           — codes, params, severity table, reporter, renderer
 *   ./validate/graph.ts           — graph topology (names, edges, reachability)
 *   ./validate/stage-rules.ts     — per-stage semantics + named-channel wiring
 *   ./validate/contract-compat.ts — skill-contract / JSON-Schema compatibility
 */

import type { Workflow } from "./api.js";
import type { SkillContractMap } from "./skill-contract.js";
import { checkEdgeSchemaCompat, checkPredicateSchemas, checkReadsChannelCompat } from "./validate/contract-compat.js";
import {
	checkEdgeKeys,
	checkEdgeTargets,
	checkMissingEdges,
	checkReachability,
	checkStartStage,
	checkWorkflowName,
} from "./validate/graph.js";
import { issueReporter, type WorkflowValidationIssue } from "./validate/issue.js";
import {
	checkFanoutReadHint,
	checkFanoutSource,
	checkReadsReferences,
	checkStageSemantics,
	fanoutPublishedChannels,
	publishedNamesOf,
} from "./validate/stage-rules.js";

export type {
	ValidationIssueCode,
	ValidationIssueParamsOf,
	WorkflowValidationIssue,
} from "./validate/issue.js";

/**
 * Validate one workflow. Aggregates all issues; never short-circuits. Caller
 * decides what's fatal — `severity === "error"` is the runner-blocking set.
 */
export function validateWorkflow(
	workflow: Workflow,
	opts?: { skillContracts?: SkillContractMap },
): WorkflowValidationIssue[] {
	const issues: WorkflowValidationIssue[] = [];
	const label = typeof workflow.name === "string" && workflow.name.length > 0 ? workflow.name : "(anonymous)";
	const r = issueReporter(label, issues);

	checkWorkflowName(workflow, r);
	checkStartStage(workflow, r);
	checkEdgeKeys(workflow, r);
	checkEdgeTargets(workflow, r);
	checkMissingEdges(workflow, r);
	// Skip reachability when an EdgeFn lacks `.targets` — the BFS would emit
	// "unreachable from start" cascades whose root cause is the metadata error
	// already reported. Gated on the issue CODE (machine-readable — the
	// message-regex this replaced was finding C5).
	if (!issues.some((i) => i.code === "edge-fn-no-targets")) checkReachability(workflow, r);

	checkStageSemantics(workflow, r);

	// The publisher set is computed ONCE and threaded to both consumers (D10).
	const published = publishedNamesOf(workflow);
	checkReadsReferences(workflow, published, r);
	checkFanoutSource(workflow, published, r);
	checkFanoutReadHint(workflow, fanoutPublishedChannels(workflow), r);

	checkPredicateSchemas(workflow, r, opts?.skillContracts);
	checkEdgeSchemaCompat(workflow, r, opts?.skillContracts);
	checkReadsChannelCompat(workflow, r, opts?.skillContracts);

	return issues;
}
