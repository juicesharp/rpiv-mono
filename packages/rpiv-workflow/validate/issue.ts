/**
 * The validation issue model — machine-readable codes, structured params,
 * ONE renderer.
 *
 * Every rule the validator enforces has exactly one entry in `ISSUE_DEFS`:
 * its severity (a property of the RULE, not the call site — so severity can
 * never drift between two emissions of the same rule) and its message
 * template. Checks report `(code, params)` through an `IssueReporter`; the
 * reporter renders the prose once, here. Consumers filter/assert on `code`
 * — never on message text.
 *
 * Messages NEVER embed the stage name — `stage` is carried structurally on
 * the issue and display renderers compose the attribution
 * (`[layer] workflow "X" — stage "Y": …`, see `command-run.ts`). Params that
 * name OTHER entities (an edge's target, a publisher stage, a channel) do
 * appear in the prose — they're content, not attribution.
 *
 * Leaf module: no imports from the rest of the package (rule inputs that
 * come from domain tables — enum lists, bounds — arrive pre-rendered as
 * params, keeping this file dependency-free).
 */

// ===========================================================================
// Issue defs — one row per rule: severity + message template
// ===========================================================================

type IssueParams = Record<string, string | number>;

interface IssueSpec<P extends IssueParams> {
	severity: "error" | "warning";
	render: (params: P) => string;
}

/**
 * Binds the param shape to the template so `report(code, params)` is
 * compile-checked. The zero-param overload pins `P` to the empty record —
 * without it, inference collapses `P` to `never` and every call site would
 * demand a (useless) params argument.
 */
function def(severity: "error" | "warning", render: () => string): IssueSpec<Record<never, never>>;
function def<P extends IssueParams>(severity: "error" | "warning", render: (params: P) => string): IssueSpec<P>;
function def(severity: "error" | "warning", render: (params: IssueParams) => string): IssueSpec<IssueParams> {
	return { severity, render };
}

export const ISSUE_DEFS = {
	// --- workflow / graph topology -----------------------------------------
	"workflow-name-invalid": def("error", () => "workflow name must be a non-empty string"),
	"start-stage-missing": def<{ start: string }>("error", (p) => `start stage "${p.start}" is not declared in stages`),
	"edge-key-unknown": def<{ from: string }>(
		"error",
		(p) => `edges["${p.from}"] references a stage that's not declared in stages`,
	),
	"edge-target-unknown": def<{ from: string; target: string }>(
		"error",
		(p) => `edges["${p.from}"] resolves to "${p.target}" which is not declared in stages`,
	),
	"edge-fn-no-targets": def<{ from: string }>(
		"error",
		(p) =>
			`edges["${p.from}"] is an EdgeFn without \`.targets\` metadata — use defineRoute([...], fn) or gate() so reachability can enumerate branches`,
	),
	"edge-missing": def<{ stage: string }>(
		"warning",
		(p) => `has no edge — treated as terminal; declare \`${p.stage}: "stop"\` to be explicit`,
	),
	"stage-unreachable": def<{ start: string }>("warning", (p) => `unreachable from start "${p.start}"`),

	// --- per-stage bounds & enums -------------------------------------------
	"max-retries-out-of-range": def<{ value: number; min: number; max: number }>(
		"error",
		(p) => `maxRetries: ${p.value} — must be in [${p.min}, ${p.max}]`,
	),
	"validate-timeout-out-of-range": def<{ value: number; min: number; max: number }>(
		"error",
		(p) => `validateTimeoutMs: ${p.value} — must be in [${p.min}, ${p.max}]`,
	),
	"on-invalid-unknown": def<{ value: string; allowed: string }>(
		"error",
		(p) => `onInvalid: "${p.value}" — must be one of ${p.allowed}`,
	),
	"stage-kind-unknown": def<{ value: string; allowed: string }>(
		"error",
		(p) => `kind: "${p.value}" — must be one of ${p.allowed}`,
	),
	"session-policy-unknown": def<{ value: string; allowed: string }>(
		"error",
		(p) => `sessionPolicy: "${p.value}" — must be one of ${p.allowed}`,
	),
	"produces-without-outcome": def(
		"error",
		() =>
			'has kind "produces" but no `outcome` — there is no framework default for produces stages. ' +
			"Wire `outcome: rpivArtifactMdOutcome` (from @juicesharp/rpiv-pi) or supply your own `{ collector, parser? }`.",
	),
	"inherits-artifacts-on-produces": def(
		"warning",
		() =>
			"sets `inheritsArtifacts: false` on a `produces` stage — the flag is the `terminal()` factory's mechanism and is only meaningful on side-effect stages",
	),

	// --- loop invariants ------------------------------------------------------
	"loop-kind-unknown": def<{ kind: string; allowed: string }>(
		"error",
		(p) => `loop.kind: "${p.kind}" — must be one of ${p.allowed}`,
	),
	"loop-continue-session": def(
		"error",
		() => 'cannot combine a loop with sessionPolicy "continue" — each unit requires an isolated session',
	),
	"loop-max-invalid": def<{ max: number }>(
		"error",
		(p) => `loop.max: ${p.max} — must be an integer >= 1 (run.maxIterations caps the upper bound)`,
	),
	"loop-concurrency-invalid": def<{ concurrency: number }>(
		"error",
		(p) =>
			`fanout concurrency: ${p.concurrency} — must be an integer >= 1 (host maxConcurrency caps the upper bound)`,
	),
	"loop-dep-flag-invalid": def<{ depArtifactFlag: string }>(
		"error",
		(p) =>
			`fanout depArtifactFlag: ${JSON.stringify(p.depArtifactFlag)} — must be a non-empty string (the flag the dispatcher prefixes each dep artifact path with)`,
	),
	"loop-requires-produces": def<{ kind: string }>(
		"error",
		(p) => `${p.kind} requires kind "produces" — each unit runs an outcome collector`,
	),
	"loop-outcome-name-required": def(
		"error",
		() => "a collecting loop requires an `outcome` with a `name` so units publish to a stable named slot",
	),
	"loop-source-unpublished": def<{ verb: string; source: string }>(
		"warning",
		(p) => `${p.verb} source "${p.source}" but no produces stage in this workflow publishes it`,
	),

	// --- assess invariants ------------------------------------------------------
	"assess-judge-shape": def<{ issue: string }>("error", (p) => `assess ${p.issue}`),
	"assess-done-not-function": def(
		"error",
		() => "assess requires `done` to be a function deciding termination from the verdict",
	),
	"assess-feed-forward-not-function": def(
		"error",
		() => "assess requires `feedForward` to be a function building the next producer arg",
	),
	"assess-verdict-channel-collision": def<{ channel: string }>(
		"error",
		(p) =>
			`judge.outcome.name "${p.channel}" collides with the producer's publish name — give the verdict its own channel`,
	),

	// --- verify invariants ------------------------------------------------------
	"verify-shape": def<{ issue: string }>("error", (p) => p.issue),
	"verify-with-loop": def(
		"error",
		() => "verify and loop are mutually exclusive in v1 — verify already runs the stage through the loop driver",
	),
	"verify-with-run": def(
		"error",
		() =>
			"verify and run are mutually exclusive — verify attempts dispatch /skill:<skill>; a script stage has no session",
	),
	"verify-requires-produces": def(
		"error",
		() => 'verify requires kind "produces" — the judge grades the attempt\'s produced artifact',
	),
	"verify-continue-session": def(
		"error",
		() => 'verify cannot combine with sessionPolicy "continue" — each attempt requires an isolated session',
	),
	"verify-outcome-name-required": def(
		"error",
		() => "verify requires an `outcome` with a `name` so attempts publish to a stable named slot",
	),
	"verify-verdict-channel-collision": def<{ channel: string }>(
		"error",
		(p) =>
			`verify judge.outcome.name "${p.channel}" collides with the producer's publish name — give the verdict its own channel`,
	),

	// --- panel invariants -------------------------------------------------------
	"panel-member-channel-collision": def<{ channel: string }>(
		"error",
		(p) =>
			`panel member verdict channel "${p.channel}" is claimed more than once — each member, the producer, and the fold need a distinct channel`,
	),
	"panel-verdict-channel-collision": def<{ channel: string }>(
		"error",
		(p) =>
			`panel folded-verdict channel "${p.channel}" collides with another published channel in this stage — give the fold its own channel`,
	),

	// --- prompt invariants ------------------------------------------------------
	"prompt-with-skill": def(
		"error",
		() => "a prompt stage cannot also set `skill` — it dispatches raw text, not /skill:<skill>",
	),
	"prompt-with-loop": def<{ kind: string }>(
		"error",
		(p) =>
			`prompt and ${p.kind} loops are mutually exclusive — units own their prompts (only assess loops and verify compose with prompt dispatch)`,
	),
	"prompt-with-reads": def(
		"error",
		() => "a prompt stage cannot set `reads` — read state.named from the PromptFn instead",
	),
	"prompt-empty": def("error", () => "prompt is an empty string — nothing would be dispatched"),
	"prompt-continue-at-start": def(
		"warning",
		() =>
			"a continue prompt stage is the workflow start — there is no prior session to continue; it will open a fresh one",
	),

	// --- script-stage invariants ------------------------------------------------
	"script-with-skill": def("error", () => 'script stages cannot set "skill" (the run function IS the work)'),
	"script-with-outcome": def("error", () => 'script stages cannot set "outcome" (the run function IS the Outcome)'),
	"script-with-loop": def("error", () => "script stages cannot loop — write a loop inside run() instead"),
	"script-with-prompt": def("error", () => "script stages cannot set a raw prompt — the run function IS the work"),
	"script-continue-session": def(
		"error",
		() => 'script stages cannot use sessionPolicy "continue" (no session to continue)',
	),
	"script-side-effect-output-schema": def(
		"warning",
		() => "outputSchema is meaningless on side-effect script stages — no data to validate",
	),

	// --- named-channel wiring ------------------------------------------------
	"reads-unpublished": def<{ channel: string }>(
		"error",
		(p) =>
			`reads "${p.channel}" but no produces stage in this workflow publishes it (check outcome.name or stage record key)`,
	),
	"reads-latest-from-fanout": def<{ channel: string }>(
		"warning",
		(p) =>
			`reads "${p.channel}" latest-only, but that channel is filled by a fanout — ` +
			`wrap it in fanin("${p.channel}") to synthesize over every unit (latest-wins reads only the last)`,
	),

	// --- contract / schema compatibility --------------------------------------
	"route-reads-unvalidated-data": def(
		"warning",
		() => "a route edge reads output.data but the stage has no outputSchema — routing may fire on un-validated data",
	),
	"edge-schema-incompatible": def<{ to: string; reason: string }>(
		"warning",
		(p) => `edge to "${p.to}": schema incompatibility — ${p.reason}`,
	),
	"reads-comparator-threw": def<{ channel: string; producer: string; error: string }>(
		"warning",
		(p) =>
			`composition comparator for channel "${p.channel}" threw (${p.error}) — reads-compat not adjudicated against publisher "${p.producer}"`,
	),
	"reads-channel-incompatible": def<{ channel: string; producer: string; reason: string }>(
		"error",
		(p) => `reads channel "${p.channel}" but publisher "${p.producer}" is incompatible — ${p.reason}`,
	),
} satisfies Record<string, IssueSpec<never>>;

// ===========================================================================
// Issue shape
// ===========================================================================

/** Machine-readable rule id — the stable contract; filter/assert on this, never on message text. */
export type ValidationIssueCode = keyof typeof ISSUE_DEFS;

/** The structured inputs `code`'s message template was rendered from. */
export type ValidationIssueParamsOf<C extends ValidationIssueCode> =
	(typeof ISSUE_DEFS)[C] extends IssueSpec<infer P> ? P : never;

export interface WorkflowValidationIssue {
	workflow: string;
	stage?: string;
	severity: "error" | "warning";
	/** Machine-readable rule id. Severity is a property of the rule (see `ISSUE_DEFS`). */
	code: ValidationIssueCode;
	/** Structured inputs the message was rendered from — for machine filtering/dedup. */
	params: Readonly<IssueParams>;
	/**
	 * Rendered prose. Never embeds the stage name — `stage` is structural; the
	 * display renderer (`command-run.ts:formatIssue`) composes the attribution.
	 */
	message: string;
}

// ===========================================================================
// Reporter
// ===========================================================================

/** Params argument is omitted entirely for codes whose template takes none. */
type ReportArgs<C extends ValidationIssueCode> = keyof ValidationIssueParamsOf<C> extends never
	? []
	: [params: ValidationIssueParamsOf<C>];

export type ReportFn = <C extends ValidationIssueCode>(code: C, ...args: ReportArgs<C>) => void;

/**
 * Issue reporter bound to one workflow + one sink. Checks hold either the
 * workflow-level `report` or a `forStage(name)` binding; construction
 * (severity lookup + render) happens in exactly one place.
 */
export interface IssueReporter {
	/** Workflow-level issue (no stage attribution). */
	report: ReportFn;
	/** Reporter bound to one stage — per-stage rule blocks take this. */
	forStage(stage: string): ReportFn;
}

export function issueReporter(workflow: string, sink: WorkflowValidationIssue[]): IssueReporter {
	const emit =
		(stage: string | undefined): ReportFn =>
		(code, ...args) => {
			const spec = ISSUE_DEFS[code];
			const params = (args[0] ?? {}) as IssueParams;
			sink.push({
				workflow,
				stage,
				severity: spec.severity,
				code,
				params,
				message: (spec.render as (p: IssueParams) => string)(params),
			});
		};
	return { report: emit(undefined), forStage: (stage) => emit(stage) };
}
