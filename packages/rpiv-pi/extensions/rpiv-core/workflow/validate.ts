/**
 * Load-time graph validation for `Workflow` objects.
 *
 * Catches the wiring mistakes a TS type system can't reach on its own:
 * unknown edge sources/targets, unreachable nodes, missing terminals,
 * predicate functions that return targets outside the node set.
 *
 * `validateWorkflow` returns a flat array of `ValidationIssue`s — errors
 * for problems that would crash the runner, warnings for shapes that
 * work but probably aren't what the author intended (unreachable nodes,
 * implicit terminals via missing edges). The load pipeline can choose
 * to halt on any error and surface warnings non-fatally.
 *
 * No I/O, no throws — purely a graph walk + predicate probe.
 */

import type { EdgeTarget, Workflow } from "./api.js";
import {
	MAX_VALIDATION_RETRIES,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRIES,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
} from "./validation.js";

// ===========================================================================
// Issue shape
// ===========================================================================

export interface ValidationIssue {
	workflow: string;
	node?: string;
	severity: "error" | "warning";
	message: string;
	/**
	 * Populated by `load.ts` after aggregation — the layer the workflow came
	 * from. `validateWorkflow` itself doesn't know about layers; the loader
	 * is the seam that has both `workflowSources` and the issue list in scope.
	 */
	layer?: "built-in" | "user" | "project";
	/** Source path (rpiv.config.ts) when the layer is user or project. */
	path?: string;
}

const STOP = "stop";

// ===========================================================================
// Public — validateWorkflow
// ===========================================================================

/**
 * Validate one workflow. Aggregates all issues; never short-circuits. Caller
 * decides what's fatal — `severity === "error"` is the runner-blocking set.
 */
export function validateWorkflow(workflow: Workflow): ValidationIssue[] {
	const issues: ValidationIssue[] = [];

	checkWorkflowName(workflow, issues);

	if (!workflow.nodes[workflow.start]) {
		issues.push(error(workflow.name, undefined, `start node "${workflow.start}" is not declared in nodes`));
	}

	checkEdgeKeys(workflow, issues);
	checkEdgeTargets(workflow, issues);
	checkMissingEdges(workflow, issues);
	checkReachability(workflow, issues);
	checkNodeSemantics(workflow, issues);
	checkPredicateSchemas(workflow, issues);

	return issues;
}

// ===========================================================================
// Individual checks
// ===========================================================================

/** `name` is what users type as `/rpiv <name>` — empty string makes the workflow unreachable. */
function checkWorkflowName(w: Workflow, issues: ValidationIssue[]): void {
	if (typeof w.name !== "string" || w.name.length === 0) {
		issues.push(error("(anonymous)", undefined, "workflow name must be a non-empty string"));
	}
}

/** Every key in `edges` must be a declared node. */
function checkEdgeKeys(w: Workflow, issues: ValidationIssue[]): void {
	for (const from of Object.keys(w.edges)) {
		if (!w.nodes[from]) {
			issues.push(error(w.name, from, `edges["${from}"] references a node that's not declared in nodes`));
		}
	}
}

/**
 * Every edge target must resolve to a declared node or the `"stop"` sentinel.
 * String targets are checked directly. `EdgeFn` targets are checked via
 * `.targets` metadata when present, or by probing — see `enumerateEdgeFnTargets`.
 */
function checkEdgeTargets(w: Workflow, issues: ValidationIssue[]): void {
	for (const [from, target] of Object.entries(w.edges)) {
		for (const candidate of enumerateTargets(target, w.name, from, issues)) {
			if (candidate === STOP) continue;
			if (!w.nodes[candidate]) {
				issues.push(
					error(w.name, from, `edges["${from}"] resolves to "${candidate}" which is not declared in nodes`),
				);
			}
		}
	}
}

/** Nodes with no outgoing edge are implicit terminals — usually a missing connection. */
function checkMissingEdges(w: Workflow, issues: ValidationIssue[]): void {
	for (const name of Object.keys(w.nodes)) {
		if (!(name in w.edges)) {
			issues.push(
				warning(
					w.name,
					name,
					`node "${name}" has no edge — treated as terminal; declare \`${name}: "stop"\` to be explicit`,
				),
			);
		}
	}
}

/**
 * BFS from `start`; every declared node should be reachable. Orphans aren't
 * a runner error (they can't fire) but they're almost always a mistake worth
 * surfacing.
 */
function checkReachability(w: Workflow, issues: ValidationIssue[]): void {
	if (!w.nodes[w.start]) return; // already reported by start-check

	const reachable = new Set<string>();
	const frontier: string[] = [w.start];
	while (frontier.length > 0) {
		const cur = frontier.shift()!;
		if (reachable.has(cur)) continue;
		reachable.add(cur);

		const target = w.edges[cur];
		if (target === undefined || target === STOP) continue;

		for (const next of enumerateTargets(target, w.name, cur, [])) {
			if (next !== STOP && w.nodes[next] && !reachable.has(next)) frontier.push(next);
		}
	}

	for (const name of Object.keys(w.nodes)) {
		if (!reachable.has(name)) {
			issues.push(warning(w.name, name, `node "${name}" is unreachable from start "${w.start}"`));
		}
	}
}

/**
 * Per-node semantic checks — bounds and enums that the TS type system narrows
 * at edit time but jiti erases at runtime. A user-authored config can ship any
 * numeric `maxValidationRetries` or any string for `onValidationFailure`; this
 * pass catches them at load time.
 */
function checkNodeSemantics(w: Workflow, issues: ValidationIssue[]): void {
	for (const [name, node] of Object.entries(w.nodes)) {
		if (
			node.maxValidationRetries !== undefined &&
			(node.maxValidationRetries < MIN_VALIDATION_RETRIES || node.maxValidationRetries > MAX_VALIDATION_RETRIES)
		) {
			issues.push(
				error(
					w.name,
					name,
					`maxValidationRetries: ${node.maxValidationRetries} — must be in [${MIN_VALIDATION_RETRIES}, ${MAX_VALIDATION_RETRIES}]`,
				),
			);
		}
		if (
			node.validationRetryTimeoutMs !== undefined &&
			(node.validationRetryTimeoutMs < MIN_VALIDATION_RETRY_TIMEOUT_MS ||
				node.validationRetryTimeoutMs > MAX_VALIDATION_RETRY_TIMEOUT_MS)
		) {
			issues.push(
				error(
					w.name,
					name,
					`validationRetryTimeoutMs: ${node.validationRetryTimeoutMs} — must be in [${MIN_VALIDATION_RETRY_TIMEOUT_MS}, ${MAX_VALIDATION_RETRY_TIMEOUT_MS}]`,
				),
			);
		}
		if (
			node.onValidationFailure !== undefined &&
			node.onValidationFailure !== "retry" &&
			node.onValidationFailure !== "halt"
		) {
			issues.push(
				error(w.name, name, `onValidationFailure: "${node.onValidationFailure}" — must be "retry" or "halt"`),
			);
		}
	}
}

/**
 * Predicate edges read `manifest.data[field]` — that data should have been
 * validated against the source node's `outputSchema` before the predicate
 * fires. A predicate on a node WITHOUT an `outputSchema` is reading
 * unvalidated frontmatter; routing decisions made on absent fields silently
 * default. Warn so the author can declare the schema and let the validation
 * retry loop guard the boundary.
 */
function checkPredicateSchemas(w: Workflow, issues: ValidationIssue[]): void {
	for (const [from, target] of Object.entries(w.edges)) {
		if (typeof target === "string") continue;
		const node = w.nodes[from];
		if (node && !node.outputSchema) {
			issues.push(
				warning(
					w.name,
					from,
					`predicate edge from "${from}" reads manifest data but the node has no outputSchema — routing may fire on un-validated frontmatter`,
				),
			);
		}
	}
}

// ===========================================================================
// Edge-target enumeration
// ===========================================================================

/**
 * Returns the set of possible string targets an `EdgeTarget` could resolve to.
 *
 * - String → singleton.
 * - `EdgeFn` with `.targets` metadata → declared targets.
 * - `EdgeFn` without `.targets` → error; the missing metadata makes reachability
 *   analysis and the runtime status-line denominator structurally unsound.
 *   Users authoring predicates by hand MUST go through `definePredicate(targets, fn)`.
 *
 * Issues collected via the `issues` array — pass an empty array when you're
 * only interested in enumeration (reachability traversal).
 */
function enumerateTargets(target: EdgeTarget, workflow: string, from: string, issues: ValidationIssue[]): string[] {
	if (typeof target === "string") return [target];
	if (Array.isArray(target.targets) && target.targets.length > 0) return [...target.targets];
	issues.push(
		error(
			workflow,
			from,
			`edges["${from}"] is an EdgeFn without \`.targets\` metadata — use definePredicate([...], fn) or threshold() so reachability can enumerate branches`,
		),
	);
	return [];
}

// ===========================================================================
// Issue constructors
// ===========================================================================

function error(workflow: string, node: string | undefined, message: string): ValidationIssue {
	return { workflow, node, severity: "error", message };
}

function warning(workflow: string, node: string | undefined, message: string): ValidationIssue {
	return { workflow, node, severity: "warning", message };
}
