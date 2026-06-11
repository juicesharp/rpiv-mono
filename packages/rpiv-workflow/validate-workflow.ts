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
 *
 * Enforcement layers (where each contract channel is adjudicated):
 *   - reads / wiring  → LOAD-TIME, complete (`checkReadsChannelCompat`, all
 *                       publishers, errors on signed mismatch — all stage kinds).
 *   - linear `data` + `status` → RUNTIME (`ensureContractInputValid`).
 *   - produces self-check → PRODUCE-TIME (`extraction.ts:effectiveOutputSchema`).
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
import { loopSpecOf, verifyShapeIssues } from "./control-flow.js";
import { resolvePublishName, resolveSkill } from "./internal-utils.js";
import { extractJsonSchema } from "./json-schema.js";
import { judgeShapeIssues } from "./judge.js";
import type { ConfigLayer } from "./layers.js";
import { isSchemaCompatible } from "./schema-compat.js";
import type { ProducesSpec, SkillContractMap } from "./skill-contract.js";
import { getCompositionComparators } from "./skill-contracts/index.js";
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
export function validateWorkflow(
	workflow: Workflow,
	opts?: { skillContracts?: SkillContractMap },
): WorkflowValidationIssue[] {
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
	checkPredicateSchemas(workflow, issues, opts?.skillContracts);
	checkReadsReferences(workflow, issues);
	checkFanoutSource(workflow, issues);
	checkEdgeSchemaCompat(workflow, issues, opts?.skillContracts);
	checkReadsChannelCompat(workflow, issues, opts?.skillContracts);

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
		checkLoopInvariants(w, name, stage, issues);
		checkVerifyInvariants(w, name, stage, issues);
		checkPromptInvariants(w, name, stage, issues);
		checkInheritsArtifactsKind(w, name, stage, issues);
		checkScriptStageInvariants(w, name, stage, issues);
	}
}

const LOOP_KINDS = ["fanout", "iterate", "assess"] as const;

/**
 * One rule block for the single `loop` field. Constructors already threw on
 * these at authoring time; this is the defensive load gate for hand-rolled
 * literals (jiti erases TS types) and programmatic embedders.
 */
function checkLoopInvariants(w: Workflow, name: string, stage: StageDef, issues: WorkflowValidationIssue[]): void {
	const loop = stage.loop;
	if (!loop) return;

	if (!(LOOP_KINDS as readonly string[]).includes(loop.kind)) {
		issues.push(error(w.name, name, `loop.kind: "${loop.kind}" — must be one of ${LOOP_KINDS.join(", ")}`));
		return; // kind-specific rules below would misfire on an unknown kind
	}
	// ONE continue rule (was three identical ones).
	if (stage.sessionPolicy === "continue") {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}" cannot combine a loop with sessionPolicy "continue" — each unit requires an isolated session`,
			),
		);
	}
	// Enforced for ALL loops now (was advisory-only for fanout/iterate specs).
	if (loop.max !== undefined && (!Number.isInteger(loop.max) || loop.max < 1)) {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": loop.max: ${loop.max} — must be an integer >= 1 (run.maxIterations caps the upper bound)`,
			),
		);
	}
	// Pull loops + assess run the stage's outcome collector per unit.
	if ((loop.kind === "iterate" || loop.kind === "assess") && stage.kind !== "produces") {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": ${loop.kind} requires kind "produces" — each unit runs an outcome collector`,
			),
		);
	}
	// A stable named slot: iterate and assess always (every unit/round runs the
	// produces collector), fanout when COLLECTING (produces kind) — the decorated
	// display string must never split the accumulation slot.
	const needsName =
		loop.kind === "iterate" || loop.kind === "assess" || (loop.kind === "fanout" && stage.kind === "produces");
	if (needsName && !stage.outcome?.name) {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": a collecting loop requires an \`outcome\` with a \`name\` so units publish to a stable named slot`,
			),
		);
	}

	if (loop.kind !== "assess") return;

	// Judge shape — SAME rule source as the judge() factory (no wording drift).
	for (const issue of judgeShapeIssues(loop.judge)) {
		issues.push(error(w.name, name, `stage "${name}": assess ${issue}`));
	}
	if (typeof loop.done !== "function") {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": assess requires \`done\` to be a function deciding termination from the verdict`,
			),
		);
	}
	if (typeof loop.feedForward !== "function") {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": assess requires \`feedForward\` to be a function building the next producer arg`,
			),
		);
	}
	// Verdict-channel collision — STAYS workflow-level (needs the producer's
	// publish identity, which only the stage knows).
	if (loop.judge?.outcome?.name && loop.judge.outcome.name === (stage.outcome?.name ?? name)) {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": judge.outcome.name "${loop.judge.outcome.name}" collides with the producer's publish name — give the verdict its own channel`,
			),
		);
	}
}

/**
 * One rule block for the `verify` field. The `verify()` constructor already
 * threw on shape violations at authoring time; this is the defensive load
 * gate for hand-rolled literals (jiti erases TS types), plus the
 * workflow-level rules that need the stage's identity. The runtime engine is
 * the loop driver (the desugar), so the structural exclusions mirror the
 * loop rules — but verify-worded, because the author declared a
 * post-condition, not a loop.
 */
function checkVerifyInvariants(w: Workflow, name: string, stage: StageDef, issues: WorkflowValidationIssue[]): void {
	const v = stage.verify;
	if (!v) return;

	// Shape — SAME rule source as the verify() factory (no wording drift).
	for (const issue of verifyShapeIssues(v)) {
		issues.push(error(w.name, name, `stage "${name}": ${issue}`));
	}
	if (stage.loop) {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": verify and loop are mutually exclusive in v1 — verify already runs the stage through the loop driver`,
			),
		);
	}
	if (stage.run) {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": verify and run are mutually exclusive — verify attempts dispatch /skill:<skill>; a script stage has no session`,
			),
		);
	}
	if (stage.kind !== "produces") {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": verify requires kind "produces" — the judge grades the attempt's produced artifact`,
			),
		);
	}
	if (stage.sessionPolicy === "continue") {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": verify cannot combine with sessionPolicy "continue" — each attempt requires an isolated session`,
			),
		);
	}
	// Attempts publish to a stable named slot — without `outcome.name` the
	// fallback publish key would be the DECORATED unit display string
	// ("build (a0·attempt)"), splitting the accumulation slot per attempt
	// (same rationale as the collecting-loop rule).
	if (stage.kind === "produces" && !stage.run && !stage.outcome?.name) {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": verify requires an \`outcome\` with a \`name\` so attempts publish to a stable named slot`,
			),
		);
	}
	// Verdict-channel collision — STAYS workflow-level (needs the producer's
	// publish identity, which only the stage knows). Mirrors the assess rule.
	if (v.judge?.outcome?.name && v.judge.outcome.name === (stage.outcome?.name ?? name)) {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": verify judge.outcome.name "${v.judge.outcome.name}" collides with the producer's publish name — give the verdict its own channel`,
			),
		);
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
	if (stage.kind === "produces" && !stage.outcome && !stage.run) {
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
 * `prompt` is the raw-text dispatch — the third option alongside skill
 * (`/skill:<name>`) and script `run`. Its invariants keep the dispatch
 * discriminator unambiguous and the input model single:
 *
 *   - mutually exclusive with an explicit `skill` (you're either invoking a
 *     skill or sending raw text — `skill` defaulting to the record key does
 *     NOT trip this, only an explicitly-set `skill`);
 *   - mutually exclusive with a `loop` in v1 (chat fan-out is a deferred
 *     composition; units own their own prompts);
 *   - mutually exclusive with `reads` — a skill stage's `reads` auto-builds a
 *     labelled-flag arg, but a prompt stage's text is author-owned; rather than
 *     give `reads` two meanings, require the prompt to read `state.named`
 *     itself via its `PromptFn`;
 *   - a literal empty/whitespace string is a no-op dispatch → author error.
 *
 * (`prompt` + `run` is reported by checkScriptStageInvariants, mirroring
 * fanout/iterate + run. `produces` + `prompt` with no `outcome` is already
 * caught by the produces-requires-outcome rule — `prompt`, unlike `run`, is not
 * carved out of it.)
 *
 * A `continue` prompt stage used as the workflow START gets a WARNING: a
 * follow-up turn with no prior context to lean on is almost certainly an
 * authoring mistake (the continue session would have nothing to continue).
 */
function checkPromptInvariants(w: Workflow, name: string, stage: StageDef, issues: WorkflowValidationIssue[]): void {
	if (stage.prompt === undefined) return;
	if (stage.skill !== undefined) {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": a prompt stage cannot also set \`skill\` — it dispatches raw text, not /skill:<skill>`,
			),
		);
	}
	if (stage.loop) {
		issues.push(
			error(w.name, name, `stage "${name}": prompt and loop are mutually exclusive — units own their prompts`),
		);
	}
	if (stage.verify) {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": prompt and verify are mutually exclusive in v1 — verify attempts dispatch /skill:<skill>; a prompt stage has no skill`,
			),
		);
	}
	if (stage.reads?.length) {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": a prompt stage cannot set \`reads\` — read state.named from the PromptFn instead`,
			),
		);
	}
	if (typeof stage.prompt === "string" && stage.prompt.trim() === "") {
		issues.push(error(w.name, name, `stage "${name}": prompt is an empty string — nothing would be dispatched`));
	}
	if (stage.sessionPolicy === "continue" && name === w.start) {
		issues.push(
			warning(
				w.name,
				name,
				`stage "${name}": a continue prompt stage is the workflow start — there is no prior session to continue; it will open a fresh one`,
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
 * Skillless script stages: presence of `stage.run` declares "the runner
 * calls this TS function instead of dispatching a Pi skill." Four fields
 * are categorically incompatible with that contract — fail loudly at
 * load time so the runner branch can assume the invariant.
 *
 * Mutual-exclusion rules:
 *
 *   - `skill`     — the function IS the work; a skill body would never
 *                   be dispatched.
 *   - `outcome`   — the function returns the `Output` envelope directly;
 *                   there is no transcript / tool-use stream for a
 *                   collector to scan.
 *   - `loop`      — a TS function can write its own loop; the runner's
 *                   per-unit session machinery doesn't apply.
 *   - `sessionPolicy: "continue"` — there is no Pi session at all on a
 *                                   script stage; nothing to continue.
 *
 * Side-effect script stages with an `outputSchema` get a warning — the
 * function returns `void`, so no data ever flows through the validator.
 *
 * The existing `produces` + `inheritsArtifacts: false` warning
 * (`checkInheritsArtifactsKind`) fires uniformly for both skill and
 * script variants — same author error, same message.
 */
function checkScriptStageInvariants(
	w: Workflow,
	name: string,
	stage: StageDef,
	issues: WorkflowValidationIssue[],
): void {
	if (!stage.run) return;

	if (stage.skill !== undefined) {
		issues.push(
			error(w.name, name, `stage "${name}": script stages cannot set "skill" (the run function IS the work)`),
		);
	}
	if (stage.outcome) {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": script stages cannot set "outcome" (the run function IS the OutputSpec)`,
			),
		);
	}
	if (stage.loop) {
		issues.push(
			error(w.name, name, `stage "${name}": script stages cannot loop — write a loop inside run() instead`),
		);
	}
	if (stage.prompt !== undefined) {
		issues.push(
			error(w.name, name, `stage "${name}": script stages cannot set a raw prompt — the run function IS the work`),
		);
	}
	if (stage.sessionPolicy === "continue") {
		issues.push(
			error(
				w.name,
				name,
				`stage "${name}": script stages cannot use sessionPolicy "continue" (no session to continue)`,
			),
		);
	}
	if (stage.kind === "side-effect" && stage.outputSchema) {
		issues.push(
			warning(
				w.name,
				name,
				`stage "${name}": outputSchema is meaningless on side-effect script stages — no data to validate`,
			),
		);
	}
}

/**
 * Every named channel some stage in this workflow can publish: top-level
 * `produces` publishes (`resolvePublishName` — the runtime write rule), PLUS
 * judge verdict channels from `loop` (assess) and `verify` — judge sessions
 * run as `produces` and publish to `judge.outcome.name` (`judgeStageDef`).
 * The old produces-only scan missed verdict channels, so a downstream
 * `reads: ["<verdict>"]` falsely errored at load while the runtime
 * `ensureNamedReads` preflight would have passed.
 */
function publishedNamesOf(w: Workflow): Set<string> {
	const published = new Set<string>();
	for (const [name, stage] of Object.entries(w.stages)) {
		if (stage.kind === "produces") published.add(resolvePublishName(stage, name));
		const judge = stage.loop?.kind === "assess" ? stage.loop.judge : stage.verify?.judge;
		if (judge?.outcome?.name) published.add(judge.outcome.name);
	}
	return published;
}

/**
 * Every name in a stage's `reads:` must be filled by some `produces` stage
 * in the workflow. The publish key is `stage.outcome?.name ?? <record-key>`
 * — same rule the runner enforces at write time (see
 * `resolvePublishName`). Reachability isn't checked here: validating that
 * the producer can actually reach the consumer in the edge graph is a
 * larger graph problem and the static check is intentionally narrow —
 * it answers "does this name correspond to something in the workflow at
 * all?", catching typos and renames; the runtime `ensureNamedReads`
 * preflight handles the "haven't fired yet" case.
 */
function checkReadsReferences(w: Workflow, issues: WorkflowValidationIssue[]): void {
	const publishedNames = publishedNamesOf(w);
	for (const [name, stage] of Object.entries(w.stages)) {
		if (!stage.reads?.length) continue;
		for (const read of stage.reads) {
			if (publishedNames.has(read)) continue;
			issues.push(
				error(
					w.name,
					name,
					`stage "${name}" reads "${read}" but no produces stage in this workflow publishes it (check outcome.name or stage record key)`,
				),
			);
		}
	}
}

/**
 * Load-time loop-source check (control-flow as data). A stage whose `loop`
 * declares a `source` channel (via `fanout()`/`iterate()`/`assess()`) must have
 * that channel published by some `produces` stage in this workflow — otherwise
 * the stage splits over a channel nothing fills. Same publisher model as
 * `checkReadsReferences` (`stage.outcome?.name ?? <record-key>`).
 *
 * WARNS (never errors): `source` is an introspective hint, and a loop without
 * `source` degrades silently — mirrors the edge-compat posture. When the source
 * is already in the stage's `reads`, `checkReadsReferences` owns it (errors) —
 * skip to avoid double-reporting. The additive value is the `iterate`/closure-
 * sourced case, which declares no `reads:` and is otherwise unchecked.
 */
const LOOP_VERB = { fanout: "fans out over", iterate: "iterates over", assess: "assesses over" } as const;

function checkFanoutSource(w: Workflow, issues: WorkflowValidationIssue[]): void {
	const published = publishedNamesOf(w);
	for (const [name, stage] of Object.entries(w.stages)) {
		const spec = loopSpecOf(stage.loop);
		const source = spec?.source;
		if (!source || published.has(source)) continue; // no source / satisfied → degrade
		if (stage.reads?.includes(source)) continue; // checkReadsReferences owns this channel
		issues.push(
			warning(
				w.name,
				name,
				`stage "${name}" ${LOOP_VERB[spec.kind]} source "${source}" but no produces stage in this workflow publishes it`,
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
 * A stage carrying no `outputSchema` is still covered when its dispatched
 * skill declares a contract `produces.data` — output validation sources that
 * schema at runtime (`effectiveOutputSchema` in extraction.ts), so the route
 * fires on validated data. Such stages are exempt from this lint.
 *
 * Routes authored via `defineRoute(targets, fn, { readsData: false })`
 * consult only `state` or `output.meta` and carry no marker — exempt from
 * this lint.
 */
function checkPredicateSchemas(
	w: Workflow,
	issues: WorkflowValidationIssue[],
	skillContracts: SkillContractMap | undefined,
): void {
	for (const [from, target] of Object.entries(w.edges)) {
		if (typeof target === "string") continue;
		if (!marksReadsData(target)) continue;
		const stage = w.stages[from];
		if (!stage || stage.outputSchema) continue;
		// Contract-sourced output schema covers the stage like its own `outputSchema`
		// would — mirror `effectiveOutputSchema`'s fallback (same `resolveSkill` key).
		const contractData = skillContracts?.get(resolveSkill(stage, from))?.produces?.data;
		if (contractData) continue;
		issues.push(
			warning(
				w.name,
				from,
				`route edge from "${from}" reads output.data but the stage has no outputSchema — routing may fire on un-validated data`,
			),
		);
	}
}

/**
 * Load-time compat for the LINEAR `data` channel: for each string edge from→to,
 * compare the producer's `produces.data` to the consumer's `consumes.data`
 * (registry-sourced, falling back to the stage's own output/input schema). Warns
 * on a definite mismatch; degrades on predicate/STOP edges and opaque schemas.
 *
 * Edge-local is correct here — the rolling primary flows along edges. The
 * many-to-one NAMED (`reads`) channel is handled by `checkReadsChannelCompat`.
 * Runtime mirror: `ensureContractInputValid`.
 */
function checkEdgeSchemaCompat(
	w: Workflow,
	issues: WorkflowValidationIssue[],
	skillContracts: SkillContractMap | undefined,
): void {
	for (const [from, target] of Object.entries(w.edges)) {
		if (typeof target !== "string" || target === STOP) continue; // degrade on predicate/STOP edges
		const fromStage = w.stages[from];
		const toStage = w.stages[target];
		if (!fromStage || !toStage) continue; // unknown stages already reported by edge-target checks
		const producerContract = skillContracts?.get(resolveSkill(fromStage, from));
		const consumerContract = skillContracts?.get(resolveSkill(toStage, target));

		const producer = producerContract?.produces?.data ?? extractJsonSchema(fromStage.outputSchema);
		const consumer = consumerContract?.consumes?.data ?? extractJsonSchema(toStage.inputSchema);
		if (producer && consumer) {
			const compat = isSchemaCompatible(producer, consumer);
			if (!compat.ok) {
				issues.push(
					warning(w.name, from, `edge "${from}" → "${target}": schema incompatibility — ${compat.reason}`),
				);
			}
		}
	}
}

/**
 * Load-time named-channel (`reads`) compat — the COMPLETE authoring gate for
 * `reads:` wiring. For each consumer with `consumes.reads`, adjudicate
 * against EVERY `produces` stage that publishes the channel
 * (`resolvePublishName === channel`), not just the edge predecessor — named
 * channels are many-to-one (loop-backs, non-adjacent producers). The publisher
 * set is statically computable.
 *
 * ERRORS on a clean comparator incompatibility between two SIGNED contracts —
 * the "mechanically reject invalid wirings" guarantee, uniform across all stage
 * kinds, which is why no runtime reads gate is needed. Degrades (never errors)
 * when either side is unsigned, no comparator is registered, the channel isn't
 * declared, or the comparator throws. "No publisher at all" is
 * `checkReadsReferences`'s job, not this one's.
 */
function checkReadsChannelCompat(
	w: Workflow,
	issues: WorkflowValidationIssue[],
	skillContracts: SkillContractMap | undefined,
): void {
	if (!skillContracts) return;
	const comparators = getCompositionComparators();
	if (comparators.size === 0) return; // no adjudicators registered

	// Index signed publishers by channel. `kind === "produces"` mirrors the
	// runtime publish rule (`applyCompletedStage`).
	const publishersByChannel = new Map<string, Array<{ stage: string; produces: ProducesSpec }>>();
	const indexPublisher = (channel: string, stage: string, produces: ProducesSpec): void => {
		const list = publishersByChannel.get(channel);
		if (list) list.push({ stage, produces });
		else publishersByChannel.set(channel, [{ stage, produces }]);
	};
	for (const [name, stage] of Object.entries(w.stages)) {
		if (stage.kind === "produces") {
			const produces = skillContracts.get(resolveSkill(stage, name))?.produces;
			if (produces) indexPublisher(resolvePublishName(stage, name), name, produces);
		}
		// A skill judge is a publisher of its verdict channel; unsigned judges degrade.
		const judge = stage.loop?.kind === "assess" ? stage.loop.judge : stage.verify?.judge;
		if (judge?.skill && judge.outcome?.name) {
			const produces = skillContracts.get(judge.skill)?.produces;
			if (produces) indexPublisher(judge.outcome.name, name, produces);
		}
	}

	for (const [consumerName, consumer] of Object.entries(w.stages)) {
		if (!consumer.reads?.length) continue;
		const consumes = skillContracts.get(resolveSkill(consumer, consumerName))?.consumes;
		if (!consumes?.reads) continue; // unsigned consumer — degrade
		for (const channel of consumer.reads) {
			const comparator = comparators.get(channel);
			if (!comparator || !consumes.reads[channel]) continue; // no adjudicator / undeclared channel — degrade
			const publishers = publishersByChannel.get(channel);
			if (!publishers) continue; // "no publisher at all" is checkReadsReferences's job
			for (const { stage: producerName, produces } of publishers) {
				let compat: { ok: boolean; reason?: string };
				try {
					compat = comparator(produces, consumes, channel);
				} catch {
					continue; // comparator threw — author defect, degrade
				}
				if (compat.ok) continue;
				issues.push(
					error(
						w.name,
						consumerName,
						`stage "${consumerName}" reads channel "${channel}" but publisher "${producerName}" is incompatible — ${compat.reason ?? "named-channel meta incompatibility"}`,
					),
				);
			}
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
