/**
 * Load-time graph validation for `Workflow` objects.
 *
 * Catches the wiring mistakes a TS type system can't reach on its own:
 * unknown edge sources/targets, unreachable stages, missing terminals,
 * predicate functions that return targets outside the stage set.
 *
 * `validateWorkflow` returns a flat array of `WorkflowValidationIssue`s — errors
 * for problems that would crash the runner, warnings for shapes that
 * work but probably aren't what the author intended (unreachable stages,
 * implicit terminals via missing edges). The load pipeline can choose
 * to halt on any error and surface warnings non-fatally.
 *
 * No I/O, no throws — purely a graph walk + predicate probe.
 */

import {
	type EdgeTarget,
	marksReadsData,
	ON_INVALID_VALUES,
	SESSION_POLICIES,
	STAGE_KINDS,
	STOP,
	type StageDef,
	type Workflow,
} from "./api.js";
import type { ConfigLayer } from "./layers.js";
import {
	MAX_VALIDATION_RETRIES,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRIES,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
} from "./validate-output.js";

// ===========================================================================
// Issue shape
// ===========================================================================

export interface WorkflowValidationIssue {
	workflow: string;
	stage?: string;
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

	if (!workflow.stages[workflow.start]) {
		issues.push(error(workflow.name, undefined, `start stage "${workflow.start}" is not declared in stages`));
	}

	checkEdgeKeys(workflow, issues);
	checkEdgeTargets(workflow, issues);
	checkMissingEdges(workflow, issues);
	// Skip reachability when an EdgeFn lacks `.targets` — the BFS would emit
	// "unreachable from start" cascades whose root cause is the upstream error
	// already reported by checkEdgeTargets.
	const hasUnenumerableEdge = issues.some((i) => /\.targets` metadata/.test(i.message));
	if (!hasUnenumerableEdge) checkReachability(workflow, issues);
	checkStageSemantics(workflow, issues);
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

/** Every key in `edges` must be a declared stage. */
function checkEdgeKeys(w: Workflow, issues: WorkflowValidationIssue[]): void {
	for (const from of Object.keys(w.edges)) {
		if (!w.stages[from]) {
			issues.push(error(w.name, from, `edges["${from}"] references a stage that's not declared in stages`));
		}
	}
}

/**
 * Every edge target must resolve to a declared stage or the `"stop"` sentinel.
 * String targets are checked directly. `EdgeFn` targets are checked via the
 * paired `checkEdgeFnTargets` (emits the no-`.targets` error) and enumerated
 * via the pure `enumerateTargets`.
 */
function checkEdgeTargets(w: Workflow, issues: WorkflowValidationIssue[]): void {
	for (const [from, target] of Object.entries(w.edges)) {
		checkEdgeFnTargets(target, { workflow: w.name, from }, issues);
		for (const candidate of enumerateTargets(target)) {
			if (candidate === STOP) continue;
			if (!w.stages[candidate]) {
				issues.push(
					error(w.name, from, `edges["${from}"] resolves to "${candidate}" which is not declared in stages`),
				);
			}
		}
	}
}

/** Stages with no outgoing edge are implicit terminals — usually a missing connection. */
function checkMissingEdges(w: Workflow, issues: WorkflowValidationIssue[]): void {
	for (const name of Object.keys(w.stages)) {
		if (!(name in w.edges)) {
			issues.push(
				warning(
					w.name,
					name,
					`stage "${name}" has no edge — treated as terminal; declare \`${name}: "stop"\` to be explicit`,
				),
			);
		}
	}
}

/**
 * BFS from `start`; every declared stage should be reachable. Orphans aren't
 * a runner error (they can't fire) but they're almost always a mistake worth
 * surfacing.
 */
function checkReachability(w: Workflow, issues: WorkflowValidationIssue[]): void {
	if (!w.stages[w.start]) return; // already reported by start-check

	const reachable = new Set<string>();
	const frontier: string[] = [w.start];
	while (frontier.length > 0) {
		const cur = frontier.shift()!;
		if (reachable.has(cur)) continue;
		reachable.add(cur);

		const target = w.edges[cur];
		if (target === undefined || target === STOP) continue;

		for (const next of enumerateTargets(target)) {
			if (next !== STOP && w.stages[next] && !reachable.has(next)) frontier.push(next);
		}
	}

	for (const name of Object.keys(w.stages)) {
		if (!reachable.has(name)) {
			issues.push(warning(w.name, name, `stage "${name}" is unreachable from start "${w.start}"`));
		}
	}
}

/**
 * Per-stage semantic checks — bounds and enums that the TS type system narrows
 * at edit time but jiti erases at runtime. A user-authored config can ship any
 * numeric `maxRetries` or any string for `onInvalid`; this
 * pass catches them at load time. Each check is a focused helper so the
 * orchestrator reads top-down and individual rules can be exercised in
 * isolation.
 */
function checkStageSemantics(w: Workflow, issues: WorkflowValidationIssue[]): void {
	for (const [name, stage] of Object.entries(w.stages)) {
		checkRetryBounds(w, name, stage, issues);
		checkTimeoutBounds(w, name, stage, issues);
		checkStageEnums(w, name, stage, issues);
		checkFanoutContinueInvariant(w, name, stage, issues);
		checkInheritsArtifactsKind(w, name, stage, issues);
	}
}

function checkRetryBounds(w: Workflow, name: string, stage: StageDef, issues: WorkflowValidationIssue[]): void {
	if (stage.maxRetries === undefined) return;
	if (stage.maxRetries < MIN_VALIDATION_RETRIES || stage.maxRetries > MAX_VALIDATION_RETRIES) {
		issues.push(
			error(
				w.name,
				name,
				`maxRetries: ${stage.maxRetries} — must be in [${MIN_VALIDATION_RETRIES}, ${MAX_VALIDATION_RETRIES}]`,
			),
		);
	}
}

function checkTimeoutBounds(w: Workflow, name: string, stage: StageDef, issues: WorkflowValidationIssue[]): void {
	if (stage.validateTimeoutMs === undefined) return;
	if (
		stage.validateTimeoutMs < MIN_VALIDATION_RETRY_TIMEOUT_MS ||
		stage.validateTimeoutMs > MAX_VALIDATION_RETRY_TIMEOUT_MS
	) {
		issues.push(
			error(
				w.name,
				name,
				`validateTimeoutMs: ${stage.validateTimeoutMs} — must be in [${MIN_VALIDATION_RETRY_TIMEOUT_MS}, ${MAX_VALIDATION_RETRY_TIMEOUT_MS}]`,
			),
		);
	}
}

function checkStageEnums(w: Workflow, name: string, stage: StageDef, issues: WorkflowValidationIssue[]): void {
	if (stage.onInvalid !== undefined && !(ON_INVALID_VALUES as readonly string[]).includes(stage.onInvalid)) {
		issues.push(
			error(w.name, name, `onInvalid: "${stage.onInvalid}" — must be one of ${ON_INVALID_VALUES.join(", ")}`),
		);
	}
	if (!(STAGE_KINDS as readonly string[]).includes(stage.kind)) {
		issues.push(error(w.name, name, `kind: "${stage.kind}" — must be one of ${STAGE_KINDS.join(", ")}`));
	}
	if (!(SESSION_POLICIES as readonly string[]).includes(stage.sessionPolicy)) {
		issues.push(
			error(w.name, name, `sessionPolicy: "${stage.sessionPolicy}" — must be one of ${SESSION_POLICIES.join(", ")}`),
		);
	}
	if (stage.kind === "produces" && !stage.outcome) {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}" has kind "produces" but no \`outcome\` — ` +
					"there is no framework default for produces stages. Wire `outcome: rpivArtifactMdOutcome` " +
					"(from @juicesharp/rpiv-pi) or supply your own `{ collector, parser? }`.",
			),
		);
	}
}

/**
 * Fanout requires per-unit session isolation — `continue` would replay the
 * prior unit's branch into the next unit's session. The runner enforces
 * this at dispatch (`enforceSessionInvariants`); surfacing it at load
 * time gives user-authored configs a targeted error instead of a generic
 * chain-advance failure on first invocation.
 *
 * The invariant is keyed on the stage's `fanout` field — not on a skill
 * name — keeping the package skill-agnostic: any stage opting into
 * fanout must use `sessionPolicy: "fresh"` regardless of what skill it
 * dispatches.
 */
function checkFanoutContinueInvariant(
	w: Workflow,
	name: string,
	stage: StageDef,
	issues: WorkflowValidationIssue[],
): void {
	if (stage.fanout && stage.sessionPolicy === "continue") {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}" cannot combine fanout with sessionPolicy "continue" — fanout requires per-unit session isolation`,
			),
		);
	}
}

/**
 * `inheritsArtifacts: false` is the `terminal()` factory's mechanism — it
 * tells the runner to bypass upstream-artifact inheritance for a
 * side-effect stage. Setting it on a `produces` stage is meaningless: a
 * `produces` stage emits its own outcome and never consumes the upstream
 * primary artifact in `inputForStage` (the first stage always uses
 * originalInput, and inheritance only affects the prompt arg). Surface
 * the redundancy as a warning so users don't author "off" flags they
 * think are doing something.
 */
function checkInheritsArtifactsKind(
	w: Workflow,
	name: string,
	stage: StageDef,
	issues: WorkflowValidationIssue[],
): void {
	if (stage.inheritsArtifacts === false && stage.kind === "produces") {
		issues.push(
			warning(
				w.name,
				name,
				`stage "${name}" sets \`inheritsArtifacts: false\` on a \`produces\` stage — the flag is the \`terminal()\` factory's mechanism and is only meaningful on side-effect stages`,
			),
		);
	}
}

/**
 * Route edges that read `output.data[field]` (i.e. `defineRoute(...)` with
 * the default `readsData: true`, `gate(...)`, and any future factory that
 * auto-attaches the `READS_DATA` marker) should fire on data the source
 * stage has validated against its `outputSchema`. If the schema is absent,
 * the validation-retry loop never runs and the route may read an undefined
 * field — routing decisions silently default.
 *
 * Routes authored via `defineRoute(targets, fn, { readsData: false })`
 * consult only `state` or `output.meta` and carry no marker — exempt from
 * this lint.
 */
function checkPredicateSchemas(w: Workflow, issues: WorkflowValidationIssue[]): void {
	for (const [from, target] of Object.entries(w.edges)) {
		if (typeof target === "string") continue;
		if (!marksReadsData(target)) continue;
		const stage = w.stages[from];
		if (stage && !stage.outputSchema) {
			issues.push(
				warning(
					w.name,
					from,
					`route edge from "${from}" reads output.data but the stage has no outputSchema — routing may fire on un-validated data`,
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
 * enumerator. Users authoring routes by hand MUST go through
 * `defineRoute(targets, fn)` so the `.targets` metadata is structurally
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
			`edges["${ctx.from}"] is an EdgeFn without \`.targets\` metadata — use defineRoute([...], fn) or gate() so reachability can enumerate branches`,
		),
	);
}

// ===========================================================================
// Issue constructors
// ===========================================================================

function error(workflow: string, stage: string | undefined, message: string): WorkflowValidationIssue {
	return { workflow, stage, severity: "error", message };
}

function warning(workflow: string, stage: string | undefined, message: string): WorkflowValidationIssue {
	return { workflow, stage, severity: "warning", message };
}
