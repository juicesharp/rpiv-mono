/**
 * Per-stage semantic rules — bounds and enums the TS type system narrows at
 * edit time but jiti erases at runtime, plus the loop/verify/prompt/script
 * exclusion matrices and named-channel (`reads`) wiring. A user-authored
 * config can ship any numeric `maxRetries` or any string for `onInvalid`;
 * this pass catches them at load time.
 *
 * Each check is a focused helper taking the stage-bound `ReportFn` so the
 * orchestration loop reads top-down and individual rules can be exercised in
 * isolation. Contract/schema compatibility lives in `contract-compat.ts`
 * (different dependency footprint entirely).
 */

import { LOOP_KINDS, ON_INVALID_VALUES, SESSION_POLICIES, STAGE_KINDS, type StageDef, type Workflow } from "../api.js";
import { type AnyJudge, isPanel, judgeShapeIssues } from "../judge.js";
import {
	forEachJudgeChannel,
	loopSpecOf,
	panelShapeIssues,
	panelVerdictChannel,
	verifyShapeIssues,
} from "../loop-constructors.js";
import { readName } from "../stage-def.js";
import { resolvePublishName } from "../stage-identity.js";
import {
	MAX_VALIDATION_RETRIES,
	MAX_VALIDATION_RETRY_TIMEOUT_MS,
	MIN_VALIDATION_RETRIES,
	MIN_VALIDATION_RETRY_TIMEOUT_MS,
} from "../validation-bounds.js";
import type { IssueReporter, ReportFn } from "./issue.js";

/**
 * Orchestrates the per-stage rule blocks. The orchestration loop binds the
 * reporter to each stage once; rules that need workflow context beyond the
 * stage (currently only "is this the start stage") receive it explicitly.
 */
export function checkStageSemantics(w: Workflow, r: IssueReporter): void {
	for (const [name, stage] of Object.entries(w.stages)) {
		const report = r.forStage(name);
		checkRetryBounds(stage, report);
		checkTimeoutBounds(stage, report);
		checkStageEnums(stage, report);
		checkLoopInvariants(stage, name, report);
		checkVerifyInvariants(stage, name, report);
		checkPromptInvariants(stage, name === w.start, report);
		checkInheritsArtifactsKind(stage, report);
		checkScriptStageInvariants(stage, report);
	}
}

/**
 * One rule block for the single `loop` field. Constructors already threw on
 * these at authoring time; this is the defensive load gate for hand-rolled
 * literals (jiti erases TS types) and programmatic embedders.
 */
function checkLoopInvariants(stage: StageDef, name: string, report: ReportFn): void {
	const loop = stage.loop;
	if (!loop) return;

	if (!(LOOP_KINDS as readonly string[]).includes(loop.kind)) {
		report("loop-kind-unknown", { kind: loop.kind, allowed: LOOP_KINDS.join(", ") });
		return; // kind-specific rules below would misfire on an unknown kind
	}
	// ONE continue rule (was three identical ones).
	if (stage.sessionPolicy === "continue") {
		report("loop-continue-session");
	}
	// Enforced for ALL loops now (was advisory-only for fanout/iterate specs).
	if (loop.max !== undefined && (!Number.isInteger(loop.max) || loop.max < 1)) {
		report("loop-max-invalid", { max: loop.max });
	}
	if (
		loop.kind === "fanout" &&
		loop.concurrency !== undefined &&
		(!Number.isInteger(loop.concurrency) || loop.concurrency < 1)
	) {
		report("loop-concurrency-invalid", { concurrency: loop.concurrency });
	}
	if (
		loop.kind === "fanout" &&
		loop.depArtifactFlag !== undefined &&
		(typeof loop.depArtifactFlag !== "string" || loop.depArtifactFlag.trim().length === 0)
	) {
		report("loop-dep-flag-invalid", { depArtifactFlag: loop.depArtifactFlag });
	}
	// Pull loops + assess run the stage's outcome collector per unit.
	if ((loop.kind === "iterate" || loop.kind === "assess") && stage.kind !== "produces") {
		report("loop-requires-produces", { kind: loop.kind });
	}
	// A stable named slot: iterate and assess always (every unit/round runs the
	// produces collector), fanout when COLLECTING (produces kind) — the decorated
	// display string must never split the accumulation slot.
	const needsName =
		loop.kind === "iterate" || loop.kind === "assess" || (loop.kind === "fanout" && stage.kind === "produces");
	if (needsName && !stage.outcome?.name) {
		report("loop-outcome-name-required");
	}

	if (loop.kind !== "assess") return;

	// Judge shape — SAME rule sources as the judge()/panel() factories (no
	// wording drift). The slot is an `AnyJudge`: a panel routes through
	// `panelShapeIssues`, a single judge through `judgeShapeIssues`.
	const slot = loop.judge;
	const shapeIssues = slot && isPanel(slot) ? panelShapeIssues(slot) : judgeShapeIssues(slot);
	for (const issue of shapeIssues) {
		report("assess-judge-shape", { issue });
	}
	if (typeof loop.done !== "function") {
		report("assess-done-not-function");
	}
	if (typeof loop.feedForward !== "function") {
		report("assess-feed-forward-not-function");
	}
	// Verdict-channel collisions — STAY workflow-level (need the producer's
	// publish identity, which only the stage knows).
	checkVerdictChannels(slot, name, stage, "assess-verdict-channel-collision", report);
}

/**
 * Verdict-channel collisions for a judge SLOT (`AnyJudge`) — workflow-level
 * because it needs the producer's publish identity (`stage.outcome?.name ??
 * name`). A single judge owns ONE verdict channel; a PANEL owns one channel per
 * member PLUS the folded-verdict channel, and every one of them must be
 * distinct from the others and from the producer's own slot, or two sessions
 * clobber a single `state.named` entry. The SHAPE is checked separately through
 * the matching rule source; this is purely the channel-namespace rule.
 *
 * `singleCode` (assess- vs verify-worded) is the only per-site difference; the
 * panel codes are site-independent.
 */
function checkVerdictChannels(
	slot: AnyJudge | undefined,
	name: string,
	stage: StageDef,
	singleCode: "assess-verdict-channel-collision" | "verify-verdict-channel-collision",
	report: ReportFn,
): void {
	if (!slot) return;
	const producer = stage.outcome?.name ?? name;
	if (!isPanel(slot)) {
		if (slot.outcome?.name && slot.outcome.name === producer) {
			report(singleCode, { channel: slot.outcome.name });
		}
		return;
	}
	// Panel: members + fold share one namespace with the producer. First
	// claimant of a name wins; a later claimant is the collision.
	const claimed = new Set<string>([producer]);
	for (const m of slot.members) {
		const channel = m?.outcome?.name;
		if (!channel) continue; // a member missing outcome.name is a shape issue (panelShapeIssues)
		if (claimed.has(channel)) report("panel-member-channel-collision", { channel });
		else claimed.add(channel);
	}
	const fold = panelVerdictChannel(slot, name);
	if (claimed.has(fold)) report("panel-verdict-channel-collision", { channel: fold });
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
function checkVerifyInvariants(stage: StageDef, name: string, report: ReportFn): void {
	const v = stage.verify;
	if (!v) return;

	// Shape — SAME rule source as the verify() factory (no wording drift).
	for (const issue of verifyShapeIssues(v)) {
		report("verify-shape", { issue });
	}
	if (stage.loop) {
		report("verify-with-loop");
	}
	if (stage.run) {
		report("verify-with-run");
	}
	if (stage.kind !== "produces") {
		report("verify-requires-produces");
	}
	if (stage.sessionPolicy === "continue") {
		report("verify-continue-session");
	}
	// Attempts publish to a stable named slot — without `outcome.name` the
	// fallback publish key would be the DECORATED unit display string
	// ("build (a0·attempt)"), splitting the accumulation slot per attempt
	// (same rationale as the collecting-loop rule).
	if (stage.kind === "produces" && !stage.run && !stage.outcome?.name) {
		report("verify-outcome-name-required");
	}
	// Verdict-channel collisions — STAY workflow-level (need the producer's
	// publish identity, which only the stage knows). Mirrors the assess rule;
	// `checkVerdictChannels` walks panel members + fold for an `AnyJudge` slot.
	checkVerdictChannels(v.judge, name, stage, "verify-verdict-channel-collision", report);
}

/**
 * ONE range probe — collapses `checkRetryBounds`/`checkTimeoutBounds`. Optional-
 * field early-out → range predicate → `{value, min, max}` report. The bounds
 * constants already live first-class at each call site, so the probe carries
 * zero information not expressible as parameters.
 */
function checkRange(
	report: ReportFn,
	code: "max-retries-out-of-range" | "validate-timeout-out-of-range",
	value: number | undefined,
	min: number,
	max: number,
): void {
	if (value === undefined) return;
	if (value < min || value > max) report(code, { value, min, max });
}

/**
 * ONE enum probe — collapses the three same-shape `{value, allowed}` guards in
 * `checkStageEnums` (onInvalid / kind / sessionPolicy). NOTE: `loop-kind-unknown`
 * (`checkLoopInvariants`) is intentionally NOT unified — it reports `{kind,
 * allowed}` (different param key) and carries an early `return` after the report
 * (kind-specific rules would misfire on an unknown kind); forcing it through this
 * helper would touch the public issue-param shape for marginal gain.
 */
function checkEnum(
	report: ReportFn,
	code: "on-invalid-unknown" | "stage-kind-unknown" | "session-policy-unknown",
	value: string | undefined,
	allowed: readonly string[],
): void {
	if (value !== undefined && !allowed.includes(value)) report(code, { value, allowed: allowed.join(", ") });
}

function checkRetryBounds(stage: StageDef, report: ReportFn): void {
	checkRange(report, "max-retries-out-of-range", stage.maxRetries, MIN_VALIDATION_RETRIES, MAX_VALIDATION_RETRIES);
}

function checkTimeoutBounds(stage: StageDef, report: ReportFn): void {
	checkRange(
		report,
		"validate-timeout-out-of-range",
		stage.validateTimeoutMs,
		MIN_VALIDATION_RETRY_TIMEOUT_MS,
		MAX_VALIDATION_RETRY_TIMEOUT_MS,
	);
}

function checkStageEnums(stage: StageDef, report: ReportFn): void {
	checkEnum(report, "on-invalid-unknown", stage.onInvalid, ON_INVALID_VALUES);
	checkEnum(report, "stage-kind-unknown", stage.kind, STAGE_KINDS);
	checkEnum(report, "session-policy-unknown", stage.sessionPolicy, SESSION_POLICIES);
	if (stage.kind === "produces" && !stage.outcome && !stage.run) {
		report("produces-without-outcome");
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
 *   - mutually exclusive with `fanout`/`iterate` loops (principled, not
 *     deferred: every unit's message comes from `units()`/`next()`, so a
 *     stage-level `prompt` would have no role). `assess` loops and `verify`
 *     COMPOSE: the stage's `prompt` is round/attempt 0's message and
 *     `feedForward` builds each retry's complete message (raw — no `/skill:`
 *     prefix to attach an arg to);
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
function checkPromptInvariants(stage: StageDef, isStart: boolean, report: ReportFn): void {
	if (stage.prompt === undefined) return;
	// The narrowed PromptStage arm pins `reads` to `never` — exactly why this
	// gate exists: a jiti-loaded literal can still ship the field. Probe the
	// erased shape, not the arm.
	const erased = stage as { skill?: unknown; reads?: readonly string[] };
	if (erased.skill !== undefined) {
		report("prompt-with-skill");
	}
	if (stage.loop && stage.loop.kind !== "assess") {
		report("prompt-with-loop", { kind: stage.loop.kind });
	}
	if (erased.reads?.length) {
		report("prompt-with-reads");
	}
	if (typeof stage.prompt === "string" && stage.prompt.trim() === "") {
		report("prompt-empty");
	}
	if (stage.sessionPolicy === "continue" && isStart) {
		report("prompt-continue-at-start");
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
function checkInheritsArtifactsKind(stage: StageDef, report: ReportFn): void {
	if (stage.inheritsArtifacts === false && stage.kind === "produces") {
		report("inherits-artifacts-on-produces");
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
function checkScriptStageInvariants(stage: StageDef, report: ReportFn): void {
	if (!stage.run) return;

	if (stage.skill !== undefined) {
		report("script-with-skill");
	}
	if (stage.outcome) {
		report("script-with-outcome");
	}
	if (stage.loop) {
		report("script-with-loop");
	}
	if (stage.prompt !== undefined) {
		report("script-with-prompt");
	}
	if (stage.sessionPolicy === "continue") {
		report("script-continue-session");
	}
	if (stage.kind === "side-effect" && stage.outputSchema) {
		report("script-side-effect-output-schema");
	}
}

/**
 * Every named channel some stage in this workflow can publish: top-level
 * `produces` publishes (`resolvePublishName` — the runtime write rule), PLUS
 * judge verdict channels from `loop` (assess) and `verify` — judge sessions
 * run as `produces` and publish to `judge.outcome.name` (`judgeStageDef`). A
 * PANEL slot publishes one channel per member verdict plus the folded verdict
 * (`panelVerdictChannel`). The old produces-only scan missed verdict channels,
 * so a downstream `reads: ["<verdict>"]` falsely errored at load while the
 * runtime `ensureNamedReads` preflight would have passed.
 *
 * Computed ONCE by the orchestrator and threaded to both consumers
 * (`checkReadsReferences`, `checkFanoutSource`).
 */
export function publishedNamesOf(w: Workflow): Set<string> {
	const published = new Set<string>();
	for (const [name, stage] of Object.entries(w.stages)) {
		if (stage.kind === "produces") published.add(resolvePublishName(stage, name));
		// Every judge channel (single judge, panel members, AND the folded verdict)
		// counts for reachability — shared walk with the contract-compat index.
		forEachJudgeChannel(stage, name, (channel) => published.add(channel));
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
export function checkReadsReferences(w: Workflow, published: ReadonlySet<string>, r: IssueReporter): void {
	for (const [name, stage] of Object.entries(w.stages)) {
		if (!stage.reads?.length) continue;
		const report = r.forStage(name);
		for (const read of stage.reads) {
			const channel = readName(read);
			if (published.has(channel)) continue;
			report("reads-unpublished", { channel });
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

export function checkFanoutSource(w: Workflow, published: ReadonlySet<string>, r: IssueReporter): void {
	for (const [name, stage] of Object.entries(w.stages)) {
		const spec = loopSpecOf(stage.loop);
		const source = spec?.source;
		if (!source || published.has(source)) continue; // no source / satisfied → degrade
		if (stage.reads?.some((read) => readName(read) === source)) continue; // checkReadsReferences owns this channel
		r.forStage(name)("loop-source-unpublished", { verb: LOOP_VERB[spec.kind], source });
	}
}

/**
 * Channels published by a `fanout()` stage — the producer walk of
 * `publishedNamesOf`, narrowed to fanout loops. Built once and threaded to
 * `checkFanoutReadHint`.
 *
 * The `stage.kind === "produces"` clause is LOAD-BEARING — only a COLLECTING
 * fanout (produces kind) accumulates per-unit Outputs into a named channel; an
 * `acts()` fanout (`kind: "side-effect"`) publishes nothing, so its name would
 * be a false fanout channel. rpiv-pi's built-ins carry fanout loops on
 * `acts()` implement stages while the "plans" channel they read is published by
 * a separate `produces()` stage — relaxing this predicate would fire the hint
 * across every shipped built-in and break the sibling package's zero-warning
 * release gate.
 */
export function fanoutPublishedChannels(w: Workflow): Set<string> {
	const channels = new Set<string>();
	for (const [name, stage] of Object.entries(w.stages)) {
		if (loopSpecOf(stage.loop)?.kind === "fanout" && stage.kind === "produces") {
			channels.add(resolvePublishName(stage, name));
		}
	}
	return channels;
}

/**
 * Soft nudge: a bare-string read of a channel that a fanout fills reads only the
 * last unit's output (`array.at(-1)`). Almost always the author meant `fanin()`
 * — the fanout-and-synthesize barrier. WARNS (never errors): latest-only is
 * legal. `fanin()` reads are already opted in (object form) — skipped.
 */
export function checkFanoutReadHint(w: Workflow, fanoutChannels: ReadonlySet<string>, r: IssueReporter): void {
	for (const [name, stage] of Object.entries(w.stages)) {
		if (!stage.reads?.length) continue;
		const report = r.forStage(name);
		for (const read of stage.reads) {
			if (typeof read !== "string") continue; // already opted in via fanin()
			if (fanoutChannels.has(read)) report("reads-latest-from-fanout", { channel: read });
		}
	}
}
