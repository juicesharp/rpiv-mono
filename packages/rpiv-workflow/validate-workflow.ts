/**
 * Load-time graph validation for `Workflow` objects.
 *
 * Catches the wiring mistakes a TS type system can't reach on its own:
 * unknown edge sources/targets, unreachable nodes, missing terminals,
 * predicate functions that return targets outside the node set.
 *
 * `validateWorkflow` returns a flat array of `WorkflowValidationIssue`s — errors
 * for problems that would crash the runner, warnings for shapes that
 * work but probably aren't what the author intended (unreachable nodes,
 * implicit terminals via missing edges). The load pipeline can choose
 * to halt on any error and surface warnings non-fatally.
 *
 * No I/O, no throws — purely a graph walk + predicate probe.
 */

import {
	COMPLETION_STRATEGIES,
	type EdgeTarget,
	marksFrontmatter,
	type NodeDef,
	ON_VALIDATION_FAILURE_VALUES,
	SESSION_POLICIES,
	STOP,
	type Workflow,
} from "./api.js";
import type { ConfigLayer } from "./layers.js";
import {
	MAX_VALIDATION_RETRIES,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRIES,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
} from "./validate-manifest.js";

// ===========================================================================
// Issue shape
// ===========================================================================

export interface WorkflowValidationIssue {
	workflow: string;
	node?: string;
	severity: "error" | "warning";
	message: string;
	/**
	 * Populated by `load.ts` after aggregation — the layer the workflow came
	 * from. `validateWorkflow` itself doesn't know about layers; the loader
	 * is the seam that has both `workflowSources` and the issue list in scope.
	 */
	layer?: ConfigLayer;
	/** Source path (rpiv.config.ts) when the layer is user or project. */
	path?: string;
}

// ===========================================================================
// Public — validateWorkflow
// ===========================================================================

/**
 * Validate one workflow. Aggregates all issues; never short-circuits. Caller
 * decides what's fatal — `severity === "error"` is the runner-blocking set.
 */
export function validateWorkflow(workflow: Workflow): WorkflowValidationIssue[] {
	const issues: WorkflowValidationIssue[] = [];

	checkWorkflowName(workflow, issues);

	if (!workflow.nodes[workflow.start]) {
		issues.push(error(workflow.name, undefined, `start node "${workflow.start}" is not declared in nodes`));
	}

	checkEdgeKeys(workflow, issues);
	checkEdgeTargets(workflow, issues);
	checkMissingEdges(workflow, issues);
	// Skip reachability when an EdgeFn lacks `.targets` — the BFS would emit
	// "unreachable from start" cascades whose root cause is the upstream error
	// already reported by checkEdgeTargets.
	const hasUnenumerableEdge = issues.some((i) => /\.targets` metadata/.test(i.message));
	if (!hasUnenumerableEdge) checkReachability(workflow, issues);
	checkNodeSemantics(workflow, issues);
	checkPredicateSchemas(workflow, issues);

	return issues;
}

// ===========================================================================
// Individual checks
// ===========================================================================

/** `name` is what users type as `/wf <name>` — empty string makes the workflow unreachable. */
function checkWorkflowName(w: Workflow, issues: WorkflowValidationIssue[]): void {
	if (typeof w.name !== "string" || w.name.length === 0) {
		issues.push(error("(anonymous)", undefined, "workflow name must be a non-empty string"));
	}
}

/** Every key in `edges` must be a declared node. */
function checkEdgeKeys(w: Workflow, issues: WorkflowValidationIssue[]): void {
	for (const from of Object.keys(w.edges)) {
		if (!w.nodes[from]) {
			issues.push(error(w.name, from, `edges["${from}"] references a node that's not declared in nodes`));
		}
	}
}

/**
 * Every edge target must resolve to a declared node or the `"stop"` sentinel.
 * String targets are checked directly. `EdgeFn` targets are checked via the
 * paired `checkEdgeFnTargets` (emits the no-`.targets` error) and enumerated
 * via the pure `enumerateTargets`.
 */
function checkEdgeTargets(w: Workflow, issues: WorkflowValidationIssue[]): void {
	for (const [from, target] of Object.entries(w.edges)) {
		checkEdgeFnTargets(target, { workflow: w.name, from }, issues);
		for (const candidate of enumerateTargets(target)) {
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
function checkMissingEdges(w: Workflow, issues: WorkflowValidationIssue[]): void {
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
function checkReachability(w: Workflow, issues: WorkflowValidationIssue[]): void {
	if (!w.nodes[w.start]) return; // already reported by start-check

	const reachable = new Set<string>();
	const frontier: string[] = [w.start];
	while (frontier.length > 0) {
		const cur = frontier.shift()!;
		if (reachable.has(cur)) continue;
		reachable.add(cur);

		const target = w.edges[cur];
		if (target === undefined || target === STOP) continue;

		for (const next of enumerateTargets(target)) {
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
 * pass catches them at load time. Each check is a focused helper so the
 * orchestrator reads top-down and individual rules can be exercised in
 * isolation.
 */
function checkNodeSemantics(w: Workflow, issues: WorkflowValidationIssue[]): void {
	for (const [name, node] of Object.entries(w.nodes)) {
		checkRetryBounds(w, name, node, issues);
		checkTimeoutBounds(w, name, node, issues);
		checkNodeEnums(w, name, node, issues);
		checkImplementContinueInvariant(w, name, node, issues);
		checkSchemasNotAsync(w, name, node, issues);
	}
}

function checkRetryBounds(w: Workflow, name: string, node: NodeDef, issues: WorkflowValidationIssue[]): void {
	if (node.maxValidationRetries === undefined) return;
	if (node.maxValidationRetries < MIN_VALIDATION_RETRIES || node.maxValidationRetries > MAX_VALIDATION_RETRIES) {
		issues.push(
			error(
				w.name,
				name,
				`maxValidationRetries: ${node.maxValidationRetries} — must be in [${MIN_VALIDATION_RETRIES}, ${MAX_VALIDATION_RETRIES}]`,
			),
		);
	}
}

function checkTimeoutBounds(w: Workflow, name: string, node: NodeDef, issues: WorkflowValidationIssue[]): void {
	if (node.validationRetryTimeoutMs === undefined) return;
	if (
		node.validationRetryTimeoutMs < MIN_VALIDATION_RETRY_TIMEOUT_MS ||
		node.validationRetryTimeoutMs > MAX_VALIDATION_RETRY_TIMEOUT_MS
	) {
		issues.push(
			error(
				w.name,
				name,
				`validationRetryTimeoutMs: ${node.validationRetryTimeoutMs} — must be in [${MIN_VALIDATION_RETRY_TIMEOUT_MS}, ${MAX_VALIDATION_RETRY_TIMEOUT_MS}]`,
			),
		);
	}
}

function checkNodeEnums(w: Workflow, name: string, node: NodeDef, issues: WorkflowValidationIssue[]): void {
	if (
		node.onValidationFailure !== undefined &&
		!(ON_VALIDATION_FAILURE_VALUES as readonly string[]).includes(node.onValidationFailure)
	) {
		issues.push(
			error(
				w.name,
				name,
				`onValidationFailure: "${node.onValidationFailure}" — must be one of ${ON_VALIDATION_FAILURE_VALUES.join(", ")}`,
			),
		);
	}
	if (!(COMPLETION_STRATEGIES as readonly string[]).includes(node.completionStrategy)) {
		issues.push(
			error(
				w.name,
				name,
				`completionStrategy: "${node.completionStrategy}" — must be one of ${COMPLETION_STRATEGIES.join(", ")}`,
			),
		);
	}
	if (!(SESSION_POLICIES as readonly string[]).includes(node.sessionPolicy)) {
		issues.push(
			error(w.name, name, `sessionPolicy: "${node.sessionPolicy}" — must be one of ${SESSION_POLICIES.join(", ")}`),
		);
	}
}

/**
 * Phase fanout for implement nodes requires per-phase session isolation —
 * `continue` would replay the prior phase's branch into the next phase's
 * session. The runner enforces this at dispatch (`enforceSessionInvariants`);
 * surfacing it at load time gives user-authored configs a targeted error
 * instead of a generic chain-advance failure on first invocation.
 */
function checkImplementContinueInvariant(
	w: Workflow,
	name: string,
	node: NodeDef,
	issues: WorkflowValidationIssue[],
): void {
	if ((node.skill === "implement" || name === "implement") && node.sessionPolicy === "continue") {
		issues.push(
			error(
				w.name,
				name,
				`implement node "${name}" cannot use sessionPolicy "continue" — phase fanout requires per-phase session isolation`,
			),
		);
	}
}

/**
 * Async schemas can't drive the runner's synchronous retry loop. Probe each
 * schema with an empty object at load time and reject ones whose
 * `~standard.validate` returns a Promise. Without this, `extractAndValidateManifest`
 * throws mid-stage and the audit trail surfaces an opaque chain-advance error
 * instead of a workflow-load error pointing at the offending node.
 *
 * Looping over the slot names keeps the contract symmetric and adds the next
 * schema slot in one place.
 */
function checkSchemasNotAsync(w: Workflow, name: string, node: NodeDef, issues: WorkflowValidationIssue[]): void {
	for (const slot of ["outputSchema", "inputSchema"] as const) {
		const schema = node[slot];
		if (schema && isAsyncSchema(schema)) {
			issues.push(
				error(
					w.name,
					name,
					`${slot} declares an async \`~standard.validate\` — workflow runner is synchronous at the validation seam; refactor the schema to be synchronous or drop the schema entirely`,
				),
			);
		}
	}
}

/**
 * Probe a Standard Schema with an empty object and report whether its
 * `~standard.validate` returned a Promise. The probe value is intentionally
 * meaningless — we don't care about the validation outcome, only its
 * sync/async shape. Any schema that throws on the probe is treated as
 * "not async" (the throw bubbles to the runner anyway and surfaces under
 * the same fatal-extraction path).
 *
 * Best-effort: a schema whose synchronous arm throws on the empty-object
 * probe is reported as non-async; if such a schema is in fact async, the
 * runtime `validateManifestData` throw is the load-bearing safety net —
 * see `validate-manifest.ts:validateManifestData` (the `result instanceof Promise`
 * branch).
 */
function isAsyncSchema(schema: { "~standard": { validate: (data: unknown) => unknown } }): boolean {
	try {
		const result = schema["~standard"].validate({});
		return result instanceof Promise;
	} catch {
		return false;
	}
}

/**
 * Predicate edges that read `manifest.data[field]` (i.e. `definePredicate`,
 * `threshold`, and any future factory that auto-attaches the
 * `READS_FRONTMATTER` marker) should fire on data the source node has
 * validated against its `outputSchema`. If the schema is absent, the
 * validation-retry loop never runs and the predicate may read an undefined
 * field — routing decisions silently default.
 *
 * Predicates authored via `defineStatePredicate` consult only `state` or
 * `manifest.meta` and carry no marker — exempt from this lint.
 */
function checkPredicateSchemas(w: Workflow, issues: WorkflowValidationIssue[]): void {
	for (const [from, target] of Object.entries(w.edges)) {
		if (typeof target === "string") continue;
		if (!marksFrontmatter(target)) continue;
		const node = w.nodes[from];
		if (node && !node.outputSchema) {
			issues.push(
				warning(
					w.name,
					from,
					`predicate edge from "${from}" reads manifest.data but the node has no outputSchema — routing may fire on un-validated frontmatter`,
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
 * Pure — no issue emission, no caller-supplied discard buffer.
 *
 * - String → singleton.
 * - `EdgeFn` with `.targets` metadata → declared targets.
 * - `EdgeFn` without `.targets` → empty list. The missing-metadata error is
 *   the responsibility of `checkEdgeFnTargets` (paired emit-only function);
 *   call it alongside `enumerateTargets` only at sites that lint edges
 *   (currently `checkEdgeTargets`). Reachability traversal calls only the
 *   pure form.
 */
function enumerateTargets(target: EdgeTarget): string[] {
	if (typeof target === "string") return [target];
	if (Array.isArray(target.targets) && target.targets.length > 0) return [...target.targets];
	return [];
}

/**
 * Emits the "EdgeFn without `.targets` metadata" error for an `EdgeTarget`
 * that's a hand-rolled `EdgeFn` lacking the marker. Pairs with
 * `enumerateTargets`: lint sites call both; reachability calls only the
 * enumerator. Users authoring predicates by hand MUST go through
 * `definePredicate(targets, fn)` so the `.targets` metadata is structurally
 * attached.
 */
function checkEdgeFnTargets(
	target: EdgeTarget,
	ctx: { workflow: string; from: string },
	issues: WorkflowValidationIssue[],
): void {
	if (typeof target === "string") return;
	if (Array.isArray(target.targets) && target.targets.length > 0) return;
	issues.push(
		error(
			ctx.workflow,
			ctx.from,
			`edges["${ctx.from}"] is an EdgeFn without \`.targets\` metadata — use definePredicate([...], fn) or threshold() so reachability can enumerate branches`,
		),
	);
}

// ===========================================================================
// Issue constructors
// ===========================================================================

function error(workflow: string, node: string | undefined, message: string): WorkflowValidationIssue {
	return { workflow, node, severity: "error", message };
}

function warning(workflow: string, node: string | undefined, message: string): WorkflowValidationIssue {
	return { workflow, node, severity: "warning", message };
}
