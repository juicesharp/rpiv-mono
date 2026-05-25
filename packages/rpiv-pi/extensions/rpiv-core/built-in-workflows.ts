/**
 * Built-in workflows shipped with rpiv-pi. Each workflow's `nodes`
 * insertion order IS its linear stage order — `Object.keys(nodes)` gives
 * the natural read order for previews and traversal alike.
 *
 * Predicate edges use `threshold(...)` from `@juicesharp/rpiv-workflow`,
 * which attaches `.targets` metadata so reachability checks and graph
 * introspectors can enumerate possible branches without probing.
 *
 * These workflows name skills bundled by rpiv-pi (research, design, plan,
 * implement, validate, code-review, revise, commit). Installing
 * rpiv-workflow without rpiv-pi means these workflows aren't loaded —
 * users author their own over their own skills.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	action,
	artifact,
	defineWorkflow,
	type FanoutFn,
	gitCommitOutcome,
	threshold,
	typeboxSchema,
	type Workflow,
} from "@juicesharp/rpiv-workflow";
import { Type } from "typebox";

const CODE_REVIEW_SCHEMA = typeboxSchema(
	Type.Object({ blockers_count: Type.Integer({ minimum: 0 }) }, { additionalProperties: true }),
);

/**
 * Markdown `## Phase N:` headings in the inherited plan artifact define
 * fanout units for the bundled `implement` skill. The convention lives
 * here — rpiv-workflow knows nothing about phases.
 *
 * Cap: a plan declaring more than 32 phases throws. The rpiv-pi `plan`
 * skill caps around 8 phases in practice; 32 leaves headroom for stretch
 * plans without letting a pathological (or hostile) plan drive an
 * unbounded fanout loop.
 */
const MAX_PHASES = 32;

const PHASE_FANOUT: FanoutFn = ({ artifactPath, cwd }) => {
	if (!artifactPath) return [];
	const abs = isAbsolute(artifactPath) ? artifactPath : join(cwd, artifactPath);
	const content = readFileSync(abs, "utf-8");
	const matches = [...content.matchAll(/^## Phase (\d+):/gm)];
	if (matches.length > MAX_PHASES) {
		throw new Error(
			`PHASE_FANOUT: plan ${artifactPath} declares ${matches.length} phases — exceeds MAX_PHASES (${MAX_PHASES}); split into smaller plans`,
		);
	}
	return matches.map((m, i) => ({
		prompt: `${artifactPath} Phase ${m[1]}`,
		label: `phase ${i + 1}/${matches.length}`,
	}));
};

// ===========================================================================
// small — blueprint → implement → validate
// ===========================================================================

const smallWorkflow = defineWorkflow({
	name: "small",
	start: "blueprint",
	nodes: {
		blueprint: artifact(),
		implement: action({ fanout: PHASE_FANOUT }),
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
		implement: action({ fanout: PHASE_FANOUT }),
		validate: artifact(),
		"code-review": artifact({ outputSchema: CODE_REVIEW_SCHEMA }),
		revise: artifact(),
		"implement-after-revise": action({ skill: "implement", fanout: PHASE_FANOUT }),
		commit: action({ outcome: gitCommitOutcome }),
	},
	edges: {
		research: "blueprint",
		blueprint: "implement",
		implement: "validate",
		validate: "code-review",
		"code-review": threshold("blockers_count", 0, "revise", "commit"),
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
		implement: action({ fanout: PHASE_FANOUT }),
		validate: artifact(),
		"code-review-large": artifact({ skill: "code-review", outputSchema: CODE_REVIEW_SCHEMA }),
		"design-after-review": artifact({ skill: "design" }),
		"plan-after-review": artifact({ skill: "plan" }),
		"implement-after-review": action({ skill: "implement", fanout: PHASE_FANOUT }),
		commit: action({ outcome: gitCommitOutcome }),
	},
	edges: {
		research: "design",
		design: "plan",
		plan: "implement",
		implement: "validate",
		validate: "code-review-large",
		"code-review-large": threshold("blockers_count", 0, "design-after-review", "commit"),
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
