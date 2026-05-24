/**
 * Built-in workflows shipped with rpiv-pi. Each workflow's `nodes`
 * insertion order IS its linear stage order — `Object.keys(nodes)` gives
 * the natural read order for previews and traversal alike.
 *
 * Predicate edges use `threshold(...)` from `api.ts`, which attaches
 * `.targets` metadata so reachability checks (validate.ts) and graph
 * introspectors can enumerate possible branches without probing.
 */

import { Type } from "typebox";
import { action, artifact, defineWorkflow, threshold, type Workflow } from "./api.js";
import { gitCommitExtractor } from "./extractors/index.js";
import { typeboxSchema } from "./standard-schema.js";

const CODE_REVIEW_SCHEMA = typeboxSchema(
	Type.Object({ severeIssueCount: Type.Integer({ minimum: 0 }) }, { additionalProperties: true }),
);

// ===========================================================================
// small — blueprint → implement → validate
// ===========================================================================

const smallWorkflow = defineWorkflow({
	name: "small",
	start: "blueprint",
	nodes: {
		blueprint: artifact(),
		implement: action(),
		validate: artifact(),
	},
	edges: {
		blueprint: "implement",
		implement: "validate",
		validate: "stop",
	},
});

// ===========================================================================
// mid — research → blueprint → implement → validate → code-review →
//       (revise → implement-after-revise → commit) | commit
// ===========================================================================

const midWorkflow = defineWorkflow({
	name: "mid",
	start: "research",
	nodes: {
		research: artifact(),
		blueprint: artifact(),
		implement: action(),
		validate: artifact(),
		"code-review": artifact({ outputSchema: CODE_REVIEW_SCHEMA }),
		revise: artifact(),
		"implement-after-revise": action({ skill: "implement" }),
		commit: action({ extractor: gitCommitExtractor }),
	},
	edges: {
		research: "blueprint",
		blueprint: "implement",
		implement: "validate",
		validate: "code-review",
		"code-review": threshold("severeIssueCount", 0, "revise", "commit"),
		revise: "implement-after-revise",
		"implement-after-revise": "commit",
		commit: "stop",
	},
});

// ===========================================================================
// large — research → design → plan → implement → validate → code-review-large →
//         (design-after-review → plan-after-review → implement-after-review → commit) | commit
// ===========================================================================

const largeWorkflow = defineWorkflow({
	name: "large",
	start: "research",
	nodes: {
		research: artifact(),
		design: artifact(),
		plan: artifact(),
		implement: action(),
		validate: artifact(),
		"code-review-large": artifact({ skill: "code-review", outputSchema: CODE_REVIEW_SCHEMA }),
		"design-after-review": artifact({ skill: "design" }),
		"plan-after-review": artifact({ skill: "plan" }),
		"implement-after-review": action({ skill: "implement" }),
		commit: action({ extractor: gitCommitExtractor }),
	},
	edges: {
		research: "design",
		design: "plan",
		plan: "implement",
		implement: "validate",
		validate: "code-review-large",
		"code-review-large": threshold("severeIssueCount", 0, "design-after-review", "commit"),
		"design-after-review": "plan-after-review",
		"plan-after-review": "implement-after-review",
		"implement-after-review": "commit",
		commit: "stop",
	},
});

// ===========================================================================
// Exports
// ===========================================================================

export const builtInWorkflows: readonly Workflow[] = [smallWorkflow, midWorkflow, largeWorkflow];
