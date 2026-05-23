/**
 * DAG definition for the /rpiv workflow command.
 *
 * Types, constants, and pure validation functions. The DAG is a static
 * adjacency map with edge conditions (auto or choice) plus a `nodes` table
 * holding per-stage metadata. Presets resolve the DAG into a linear node
 * sequence by id. Validation checks every id referenced in edges/presets
 * resolves to a node, and node bodies reference real bundled skills.
 *
 * No ExtensionAPI dependency. Functions take the DAG explicitly for testability.
 *
 * Static-config style — sibling pattern to siblings.ts/agents.ts (const adjacency
 * array + lazy validation set), not the dynamic Map-based task-graph.ts.
 *
 * Supported node kinds: `kind: "skill"`. The type system declares space for
 * future kinds (chat / script) so the schema doesn't churn when those land;
 * validation rejects unknown kinds at config-load time.
 *
 * Supported session policies: `"fresh"` (new session per stage) and `"continue"`
 * (reuse the prior stage's session). Both pass validation; the runner branches
 * on the policy at dispatch time.
 */

import type { TSchema } from "typebox";
import { BUNDLED_SKILL_NAMES } from "../paths.js";
import { gitCommitExtractor, gitHeadSnapshot } from "./extractors/index.js";
import type { ExtractorFn, SnapshotFn } from "./manifest.js";
import { predicateThreshold } from "./predicates.js";
import { MAX_VALIDATION_RETRIES, MIN_VALIDATION_RETRIES } from "./validation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Edge condition: "auto" (single successor), "choice" (user picks), or "predicate" (runtime function decides). */
export type EdgeCondition = "auto" | "choice" | "predicate";

/** A single directed edge in the DAG. */
export interface DagEdge {
	/** Source node id (must resolve to a key in `WorkflowDag.nodes`). */
	from: string;
	/** Target node id(s). For "auto": exactly one. For "choice": two or more. */
	to: string[];
	/** How the target is selected. */
	condition: EdgeCondition;
	/** Predicate function for conditional routing. Required when condition is "predicate". */
	predicate?: import("./predicates.js").EdgePredicate;
}

/** Preset name — widened to string to support custom config-driven presets. */
export type PresetName = string;

/**
 * How the runner decides a node has finished. Different completion semantics
 * map to different chain-transition decisions.
 *
 * - `"artifact-emit"` — the node's protocol writes a `.rpiv/artifacts/<bucket>/<file>.md`
 *   path. The runner considers the stage done when that path appears in the
 *   transcript. If the agent stops cleanly without writing the path (e.g. asked
 *   a plain-text clarifying question instead of using `ask_user_question`),
 *   the runner halts the chain. Use for protocol skills (discover, research,
 *   plan, design, blueprint, validate, code-review, explore, revise,
 *   outline-test-cases).
 *
 * - `"agent-end"` — the stage is done as soon as the agent loop reaches any
 *   clean stop reason. Used for action skills (commit, implement, annotate-*)
 *   where the side effect IS the work; no chained artifact is expected and the
 *   chain inherits the prior stage's `state.artifactPath`.
 */
export type StopStrategy = "artifact-emit" | "agent-end";

/**
 * Whether the runner spawns a fresh Pi session for the node or continues the
 * current session.
 *
 * - `"fresh"` — wrap the node in `ctx.newSession({ withSession })`. Every node
 *   gets an isolated session, clean context window, fresh transcript inspection.
 *
 * - `"continue"` — reuse the prior session (no `newSession`), send the prompt
 *   directly via `pi.sendUserMessage()` and await `ctx.waitForIdle()`. The
 *   runner slices the branch with `branchOffset` to inspect only entries
 *   produced by this stage.
 */
export type SessionPolicy = "fresh" | "continue";

/** Fields shared by every node kind. */
interface NodeCommon {
	/** How the runner decides this node has finished. */
	stopStrategy: StopStrategy;
	/** Whether the node runs in a new session or continues the prior one. */
	sessionPolicy: SessionPolicy;
	/** Optional pre-stage snapshot function. */
	snapshot?: SnapshotFn;
	/** Optional post-stage extractor override. When absent, the runner uses
	 *  the default based on stopStrategy. */
	extractor?: ExtractorFn;
	/** TypeBox schema for validating manifest.data post-extraction. */
	outputSchema?: TSchema;
	/** What to do when output validation fails. Default: "retry". */
	onValidationFailure?: "retry" | "halt";
	/** Max validation retries. Default: 1, hard cap: 3. */
	maxValidationRetries?: number;
	/** TypeBox schema for validating incoming manifest.data pre-execution. */
	inputSchema?: TSchema;
}

/**
 * A node that invokes a bundled skill via `/skill:<name>`. The only kind
 * supported by the runner in Phase 1.
 */
export interface SkillNode extends NodeCommon {
	kind: "skill";
	/**
	 * Bundled-skill directory name. Validated against `BUNDLED_SKILL_NAMES` — the
	 * skill must exist under `packages/rpiv-pi/skills/`.
	 */
	skill: string;
}

/**
 * Discriminated union of all node kinds. Phase 1 has a single variant
 * (`SkillNode`); chat and script kinds will land later as additional
 * variants — additive, non-breaking.
 */
export type DagNode = SkillNode;

/** The full DAG definition. */
export interface WorkflowDag {
	edges: DagEdge[];
	presets: Record<string, string[]>;
	/**
	 * Per-stage metadata, keyed by node id. Every id referenced in `edges` or
	 * `presets` MUST exist here — `validateDag` enforces this. The DAG is
	 * fully self-describing; there are no implicit defaults.
	 */
	nodes: Record<string, DagNode>;
}

// ---------------------------------------------------------------------------
// DAG edge map
// ---------------------------------------------------------------------------

/**
 * Built-in DAG. Every node referenced in `edges` or `presets` has a matching
 * entry in `nodes` with its stop strategy and session policy.
 *
 * `stopStrategy` mapping is the protocol contract per skill:
 * - Artifact-producing skills (discover/research/design/plan/blueprint/explore/
 *   validate/revise/code-review/outline-test-cases) → `"artifact-emit"`.
 *   These skills' SKILL.md Step 7-ish writes `.rpiv/artifacts/<bucket>/<file>.md`.
 * - Action skills (implement/commit/annotate-guidance/migrate-to-guidance) →
 *   `"agent-end"`. The work IS the side effect; no chain artifact.
 */
/**
 * Factory for skill-kind nodes — defaults `kind` to "skill" and
 * `sessionPolicy` to "fresh". Override `sessionPolicy` via the optional
 * third parameter for nodes that should reuse the prior stage's session.
 *
 * The node id used as the dictionary key equals the skill name for all
 * built-in nodes; passing the skill name once removes the duplication
 * that would otherwise repeat for every entry.
 */
export const skillNode = (
	skill: string,
	stopStrategy: StopStrategy,
	overrides?: {
		sessionPolicy?: SessionPolicy;
		snapshot?: SnapshotFn;
		extractor?: ExtractorFn;
		outputSchema?: TSchema;
		onValidationFailure?: "retry" | "halt";
		maxValidationRetries?: number;
		inputSchema?: TSchema;
	},
): SkillNode => ({
	kind: "skill",
	skill,
	stopStrategy,
	sessionPolicy: overrides?.sessionPolicy ?? "fresh",
	snapshot: overrides?.snapshot,
	extractor: overrides?.extractor,
	outputSchema: overrides?.outputSchema,
	onValidationFailure: overrides?.onValidationFailure,
	maxValidationRetries: overrides?.maxValidationRetries,
	inputSchema: overrides?.inputSchema,
});

export const WORKFLOW_DAG: WorkflowDag = {
	edges: [
		{ from: "discover", to: ["research"], condition: "auto" },
		{ from: "design", to: ["plan"], condition: "auto" },
		{ from: "plan", to: ["implement"], condition: "auto" },
		{ from: "blueprint", to: ["implement"], condition: "auto" },
		{ from: "implement", to: ["validate"], condition: "auto" },
		{ from: "validate", to: ["commit"], condition: "auto" },
		{ from: "revise", to: ["implement"], condition: "auto" },
		{ from: "outline-test-cases", to: ["write-test-cases"], condition: "auto" },
		{ from: "migrate-to-guidance", to: ["annotate-guidance"], condition: "auto" },

		{ from: "research", to: ["design", "blueprint"], condition: "choice" },
		{ from: "explore", to: ["design", "blueprint"], condition: "choice" },
		{
			from: "code-review",
			to: ["revise", "commit"],
			condition: "predicate",
			predicate: predicateThreshold("severeIssueCount", 0, "revise", "commit"),
		},
	],

	// Linear research → build → verify chains. `commit` and `revise` are
	// intentionally left to the user once the working tree is in a known-good
	// state. `large` includes `code-review` since architectural changes earn
	// the parallel-specialist review pass.
	presets: {
		small: ["research", "blueprint", "implement", "validate"],
		mid: ["discover", "research", "blueprint", "implement", "validate"],
		large: ["discover", "research", "design", "plan", "implement", "validate", "code-review", "revise", "commit"],
	},

	nodes: {
		// Artifact-producing protocol skills.
		discover: skillNode("discover", "artifact-emit"),
		research: skillNode("research", "artifact-emit"),
		design: skillNode("design", "artifact-emit"),
		plan: skillNode("plan", "artifact-emit"),
		blueprint: skillNode("blueprint", "artifact-emit"),
		explore: skillNode("explore", "artifact-emit"),
		validate: skillNode("validate", "artifact-emit"),
		revise: skillNode("revise", "artifact-emit"),
		"code-review": skillNode("code-review", "artifact-emit"),
		"outline-test-cases": skillNode("outline-test-cases", "artifact-emit"),

		// Action skills (side-effect is the work; no chained artifact).
		"write-test-cases": skillNode("write-test-cases", "agent-end"),
		implement: skillNode("implement", "agent-end"),
		commit: skillNode("commit", "agent-end", { snapshot: gitHeadSnapshot, extractor: gitCommitExtractor }),
		"annotate-guidance": skillNode("annotate-guidance", "agent-end"),
		"migrate-to-guidance": skillNode("migrate-to-guidance", "agent-end"),
	},
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_STOP_STRATEGIES: ReadonlySet<StopStrategy> = new Set(["artifact-emit", "agent-end"] as const);
const VALID_SESSION_POLICIES: ReadonlySet<SessionPolicy> = new Set(["fresh", "continue"] as const);

/** Outcome of validating a DAG: errors block startup; warnings are advisory. */
export interface DagValidation {
	errors: string[];
	warnings: string[];
}

/**
 * Validate a DAG, returning `{errors, warnings}`. Errors gate startup;
 * warnings are advisory (e.g. predicate edges without an outputSchema).
 * Pure function — takes the DAG explicitly so tests can pass alternatives.
 *
 * Each check is its own helper so this top level reads as the validation
 * checklist itself.
 */
export function validateDag(dag: WorkflowDag): DagValidation {
	const errors: string[] = [];
	const warnings: string[] = [];

	collectReferenceErrors(dag, errors);
	collectEdgeIssues(dag, errors, warnings);
	collectNodeErrors(dag, errors);

	return { errors, warnings };
}

/** Every id used in `edges` and `presets` must resolve to an entry in `nodes`. */
function collectReferenceErrors(dag: WorkflowDag, errors: string[]): void {
	for (const edge of dag.edges) {
		if (!(edge.from in dag.nodes)) errors.push(`Edge source "${edge.from}" has no entry in nodes`);
		for (const target of edge.to) {
			if (!(target in dag.nodes)) errors.push(`Edge target "${target}" (from "${edge.from}") has no entry in nodes`);
		}
	}
	for (const [presetName, nodeIds] of Object.entries(dag.presets)) {
		for (const id of nodeIds) {
			if (!(id in dag.nodes)) errors.push(`Preset "${presetName}" references "${id}" which has no entry in nodes`);
		}
	}
}

/** Edge-specific validation: predicate edges need a function + schema on source. */
function collectEdgeIssues(dag: WorkflowDag, errors: string[], warnings: string[]): void {
	for (const edge of dag.edges) {
		if (edge.condition !== "predicate") continue;

		if (typeof edge.predicate !== "function") {
			errors.push(
				`Edge "${edge.from} → [${edge.to.join(", ")}]" has condition "predicate" but no predicate function`,
			);
		}
		// Predicate edges reading manifest.data without a schema on the source
		// fire on un-validated frontmatter. Advisory — schemas can land later.
		const sourceNode = dag.nodes[edge.from];
		if (sourceNode && !sourceNode.outputSchema) {
			warnings.push(
				`Predicate edge "${edge.from} → [${edge.to.join(", ")}]" reads from manifest.data but source node "${edge.from}" has no outputSchema — predicate decisions will fire on un-validated frontmatter`,
			);
		}
	}
}

/** Per-node shape validation: kinds, strategies, schemas, retry bounds, skill membership. */
function collectNodeErrors(dag: WorkflowDag, errors: string[]): void {
	for (const [id, node] of Object.entries(dag.nodes)) {
		checkStopStrategy(id, node, errors);
		checkSessionPolicy(id, node, errors);
		checkValidationConfig(id, node, errors);
		checkNodeKind(id, node, errors);
	}
}

function checkStopStrategy(id: string, node: DagNode, errors: string[]): void {
	if (!VALID_STOP_STRATEGIES.has(node.stopStrategy)) {
		errors.push(`Node "${id}" has invalid stopStrategy: "${node.stopStrategy}"`);
	}
}

function checkSessionPolicy(id: string, node: DagNode, errors: string[]): void {
	if (!VALID_SESSION_POLICIES.has(node.sessionPolicy)) {
		errors.push(`Node "${id}" has invalid sessionPolicy: "${node.sessionPolicy}"`);
	}
}

function checkValidationConfig(id: string, node: DagNode, errors: string[]): void {
	if (
		node.onValidationFailure !== undefined &&
		node.onValidationFailure !== "retry" &&
		node.onValidationFailure !== "halt"
	) {
		errors.push(`Node "${id}" has invalid onValidationFailure: "${node.onValidationFailure}"`);
	}

	if (
		node.maxValidationRetries !== undefined &&
		(node.maxValidationRetries < MIN_VALIDATION_RETRIES || node.maxValidationRetries > MAX_VALIDATION_RETRIES)
	) {
		errors.push(
			`Node "${id}" has maxValidationRetries: ${node.maxValidationRetries} — must be ${MIN_VALIDATION_RETRIES}..${MAX_VALIDATION_RETRIES}`,
		);
	}
}

function checkNodeKind(id: string, node: DagNode, errors: string[]): void {
	switch (node.kind) {
		case "skill":
			if (!BUNDLED_SKILL_NAMES.has(node.skill)) {
				errors.push(`Node "${id}" (kind=skill) references unknown bundled skill: "${node.skill}"`);
			}
			return;
		default: {
			// Defensive: surfaces any unknown `kind` value as a validation error
			// rather than letting the runner crash on dispatch. With only one
			// variant in `DagNode` today, the TypeScript exhaustiveness check
			// (`const _: never = node`) can't be expressed without an error;
			// once chat / script kinds land, add their case branches and
			// `assertNever(node)` will start narrowing correctly.
			const unknownKind = (node as { kind?: unknown }).kind;
			errors.push(`Node "${id}" has unknown kind: ${String(unknownKind)}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Edge traversal
// ---------------------------------------------------------------------------

/**
 * Look up the next node(s) from the DAG for a given source skill.
 * Returns undefined if the skill has no outgoing edge (leaf/exit node).
 */
export function getEdge(dag: WorkflowDag, from: string): DagEdge | undefined {
	return dag.edges.find((e) => e.from === from);
}

/**
 * Resolve a preset name to its linear node sequence.
 * Returns undefined if the preset name is unknown.
 */
export function resolvePreset(dag: WorkflowDag, name: PresetName): string[] | undefined {
	return dag.presets[name];
}

/**
 * Check whether a skill name is a valid skill-node target (references an
 * actual bundled skill directory). Does NOT check membership in any
 * particular DAG's `nodes` map.
 */
export function isValidNode(skillName: string): boolean {
	return BUNDLED_SKILL_NAMES.has(skillName);
}
