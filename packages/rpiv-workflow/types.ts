/**
 * Runtime types. Three nouns flow through the workflow runtime:
 *
 *  - `RunContext` — per-run carry (cwd, runId, workflow, state, visited,
 *    registeredSkills, resolveModel, maxBackwardJumps). Read by every
 *    layer; mutated only by the runner.
 *  - `RunState` — mutable bookkeeping (output, counters, telemetry,
 *    termination). Read by every layer; mutated through the chain-state
 *    authorities (chain-state.ts) by the runner, the loop driver, the audit
 *    layer, and the resume fold — external consumers get the deep-readonly
 *    `RunView` projection instead. Always read the chain's primary artifact
 *    via `currentPrimaryArtifact(state)` (chain-state.ts).
 *  - `WorkflowHostContext` — the host port (defined in `host.js`, re-exported
 *    here) threaded from `withSession` callbacks down through stage/phase
 *    helpers, so the runtime layers import all three nouns from one module.
 *
 * Per-stage / per-phase sessions extend a shared `SessionContext` base
 * (cwd, runId, state, prompt, skill). The audit layer pins its dependency
 * on this base structurally via `AuditContext = Pick<SessionContext, ...>`.
 *
 * Lives apart from runner.ts / sessions.ts so both can reference the same
 * shapes without a runtime import cycle (type-only refs back via this
 * module are cycle-free).
 */

import type { StageDef, Workflow } from "./api.js";
import type { LifecycleDispatcher, LifecycleListeners } from "./events.js";
import type { Artifact } from "./handle.js";
import type { ModelSelection, WorkflowHost, WorkflowHostContext } from "./host.js";
import type { Output } from "./output.js";
import type { SkillContractMap } from "./skill-contract.js";
import type { SessionRef } from "./state/index.js";
import type { BranchEntry } from "./transcript.js";
import type { RunTrigger } from "./triggers.js";

// Re-export the host port so runtime layers can pull `RunContext`,
// `RunState`, and the threaded ctx + model type from this single
// runtime-types module.
export type {
	ModelSelection,
	WorkflowHostContext,
	WorkflowSessionContext,
} from "./host.js";

/** Mutable per-run bookkeeping threaded through the chain by reference. */
export interface RunState {
	// ── Identity ────────────────────────────────────────────────────────
	/** Frozen — the user's `/wf` argument. */
	originalInput: string;

	// ── Progress (hot paths — runner reads on every stage) ─────────────
	/**
	 * Chain-input artifact — the rolling slot the next stage's prompt
	 * inherits as input. Updated ONLY by produces stages whose
	 * collector returned at least one artifact (the first becomes the new
	 * primary). Side-effect stages (commit, side-effect) record their own
	 * output but do not touch this slot — preserves the "commit
	 * inherits the prior chain's artifact" semantic without forcing
	 * side-effect collectors to re-emit the prior list.
	 *
	 * Reads must go through `currentPrimaryArtifact(state)`
	 * (internal-utils.ts); a direct read here is a hint of a missed
	 * accessor.
	 */
	primaryArtifact: Artifact | undefined;
	output: Output | undefined;
	/**
	 * Named publish registry — `produces` stages APPEND their full `Output`
	 * envelope onto the slot keyed by `stage.outcome?.name ??
	 * stage.<record-key>` after each successful run. Slots are arrays so
	 * iteration history is preserved across backward-jump loops; the
	 * default read resolves to the most-recent entry (`array.at(-1)`).
	 * Multiple stages MAY share a slot on purpose — their outputs interleave
	 * in run order.
	 *
	 * Side-effect stages don't write to this slot. The slot is never
	 * cleared by `terminal()` either: it's an additive history channel
	 * orthogonal to the rolling `primaryArtifact`.
	 */
	named: Record<string, Output[]>;
	/** Stages whose JSONL row landed on disk. */
	stagesCompleted: number;
	/** Most recently allocated stageNumber. Advances on every recordStage call. */
	lastAllocatedStageNumber: number;
	/**
	 * The `SessionRef` of the most recently completed SINGLE stage — what a
	 * downstream `sessionPolicy: "continue"` stage forks from (its predecessor's
	 * persisted child session). Rolls forward like `output`: set on every
	 * single-stage success (`recordStageSuccess`) and reconstructed by the resume
	 * fold from the last completed single-stage row. Loop UNITS never touch it
	 * (they take the unit branch of `recordStageSuccess` and fold via
	 * `foldUnitRow`), so a `continue` right after a loop forks the last single
	 * stage — the loop was a fan-out excursion with no single session to continue.
	 * Undefined at run start or when the predecessor persisted no session (an
	 * in-memory host); either degrades a `continue` stage to a fresh dispatch.
	 */
	lastSession?: SessionRef;

	/**
	 * Validation-retry gate memory — the digest captured the last time a
	 * schema-validated produces stage was dispatched, keyed with the stage name
	 * + `stagesCompleted` at capture. TRANSIENT: not persisted to JSONL (the
	 * resume fold reconstructs `RunState` from rows, not from a serialized
	 * blob), so operator resume starts with a fresh gate — matching the
	 * fresh-strike-budget policy. `undefined` until a qualifying stage is
	 * dispatched (the gate's no-regression short-circuit).
	 */
	lastGatedDispatch?: { stage: string; digest: string; stagesCompleted: number };

	// ── Telemetry (post-hoc only; not consulted by chain advancement) ──
	telemetry: {
		/**
		 * Run-wide cumulative count of backward jumps (decision-edge routes to
		 * an already-visited stage). Never reset. The halt decision reads the
		 * per-destination `RunContext.revisits` ledger, not this total.
		 */
		backwardJumps: number;
		/**
		 * Routing rows whose JSONL append failed mid-run. The chain advanced
		 * past them (routing rows are write-only telemetry, not
		 * reconstruction inputs), but the final result envelope surfaces this
		 * so post-hoc readers can distinguish "deterministic edge — no row
		 * written by design" from "decision made — write was dropped." Empty
		 * in the common case.
		 */
		droppedRoutingRows: Array<{ fromStageIndex: number; fromStage: string; decision: string }>;
		/**
		 * Stages whose terminal failure/aborted row failed to append. Unlike
		 * routing rows these ARE reconstruction inputs — a trail missing its
		 * failure row reads "completed" at the tail and a later resume would
		 * route onward past the stage that actually failed. Surfaced in
		 * `RunWorkflowResult.droppedFailureRows`; consumers holding entries
		 * must not resume the run from disk. Empty in the common case.
		 */
		droppedFailureRows: string[];
	};

	// ── Failure memos (consumed by chain advancement — next prompt) ─────
	/**
	 * Bounded log of stage/unit failures this run has already incurred,
	 * surfaced as an additive prompt suffix on every subsequently-built
	 * stage/unit session via `failureMemoSuffix`. Empty on a clean run ⇒ the
	 * suffix is `""` ⇒ byte-identical prompt. Capped at `MAX_FAILURE_MEMOS`
	 * (oldest dropped); each entry's `errMsg` is length-bounded. NOT telemetry:
	 * it is mutable bookkeeping the next agent's prompt reads, so it sits
	 * between the telemetry block and `termination`.
	 */
	failureMemos: FailureMemo[];

	// ── Termination (set once at end-of-run) ───────────────────────────
	/**
	 * How the run ended — `"running"` until the single end-of-run write via
	 * `terminate()` (audit.ts), the ONLY sanctioned mutator. Discriminated so
	 * every outcome is representable — cancellation is its own status, not
	 * smuggled through the error string — and so a halt site can't set half
	 * the shape.
	 */
	termination: RunTermination;
}

/**
 * Run-termination outcome — the discriminated form behind
 * `RunState.termination` and `RunWorkflowResult.termination`.
 *
 *  - `"running"`   — not terminated yet (also: the runner unwound without
 *                    reaching any terminal write — treated as failure).
 *  - `"completed"` — the chain reached `stop`.
 *  - `"failed"`    — a stage/preflight/routing halt; `error` carries the cause.
 *  - `"aborted"`   — cooperative cancellation via `RunWorkflowOptions.signal`,
 *                    or the model aborted the stage.
 *  - `"cancelled"` — the user dismissed the live session mid-stage. Recorded
 *    on disk as the legacy FROZEN `StageStatus: "skipped"` (state/state.ts),
 *    written solely by `recordCancellation` (audit.ts); the canonical name
 *    (`"cancelled"`) and the frozen row value (`"skipped"`) differ by design.
 */
export type RunTermination =
	| { status: "running"; error?: undefined }
	| { status: "completed"; error?: undefined }
	| { status: "failed"; error: string }
	| { status: "aborted"; error: string }
	| { status: "cancelled"; error: string };

/**
 * One entry in `RunState.failureMemos` — a bounded record of a stage/unit
 * failure this run has already incurred, surfaced to the next agent's prompt
 * as an additive suffix so the run does not repeat a dead end. `stage` is the
 * machine identity (a loop unit's parent, or the audit `stageName` for a
 * non-unit failure); `unitId` is set only for a loop-unit failure (the unit's
 * stable audit id). `ts` is an ISO-8601 timestamp.
 */
export interface FailureMemo {
	stage: string;
	unitId?: string;
	errMsg: string;
	ts: string;
}

// ---------------------------------------------------------------------------
// Public run envelope — options in, result out
// ---------------------------------------------------------------------------
// Lives here (the runtime-types leaf), NOT in runner/runner.ts: the result
// envelope is public surface consumed by events.ts (`onWorkflowEnd`) and
// every embedder — a base-layer module must not import the deepest engine
// module to name it.

export interface RunWorkflowOptions {
	/** Workflow to execute — caller resolves by name from `LoadedWorkflows`. */
	workflow: Workflow;
	/** Passed to the start stage as its argument. */
	input: string;
	/** Registry-level host — enumerated once for the skill-registration snapshot. */
	host?: WorkflowHost;
	/** Per-destination decision-edge re-entry cap. Defaults to MAX_BACKWARD_JUMPS. */
	maxBackwardJumps?: number;
	/** Run-wide safety cap on loop units (all kinds). Defaults to MAX_ITERATIONS. */
	maxIterations?: number;
	/**
	 * What triggered this run. `/wf` sets `{ kind: "command", name: "wf" }`;
	 * programmatic embedders default to `DEFAULT_TRIGGER`. Recorded in the
	 * JSONL header and surfaced on every lifecycle callback via
	 * `LifecycleContext.trigger`.
	 */
	trigger?: RunTrigger;
	/**
	 * Per-call lifecycle listener bundle. Fires AFTER every globally
	 * registered bundle (see `registerLifecycle`). Listener throws are
	 * caught + logged via `ctx.ui.notify(..., "warning")`; never halt the
	 * run.
	 */
	lifecycle?: LifecycleListeners;
	/**
	 * Cooperative cancellation. When the signal is aborted, the runner stops at
	 * the next between-stage seam — it records an `"aborted"` terminal row for
	 * the stage about to run and returns `{ success: false }` with an aborted
	 * error. It does NOT interrupt a stage already streaming (Pi owns the live
	 * session), so cancellation takes effect at the next stage boundary, not
	 * mid-stage.
	 */
	signal?: AbortSignal;
	/**
	 * Per-stage model-override resolver, injected by the embedder. Threaded onto
	 * `RunContext.resolveModel` → every `StageSessionContext.model`; the host applies it
	 * at child-session creation. Undefined ⇒ host default for every stage.
	 */
	resolveModel?: (id: { stage: string; skill: string }) => ModelSelection | undefined;
	/**
	 * Worktree-digest override for the validation-retry gate — threaded
	 * onto `RunContext.worktreeDigest` → every `StageSessionContext.worktreeDigest`.
	 * Undefined ⇒ the built-in `computeWorktreeDigest` (git + artifacts).
	 */
	worktreeDigest?: (cwd: string) => string | undefined;
	/**
	 * Human-readable alias for this run. Stored in the JSONL header and the
	 * sidecar names.json index. Rejected if already in use — the error
	 * identifies the conflicting runId.
	 */
	name?: string;
}

export interface RunWorkflowResult {
	/**
	 * The run's identity on disk — the `<run-id>` portion of
	 * `<cwd>/.rpiv/workflows/runs/<run-id>.jsonl`. Live consumers can hand
	 * this to `readLastStage` / `listArtifacts` / future inspect-past-run
	 * helpers without recomputing the slug.
	 *
	 * Undefined ONLY for pre-flight rejections (e.g. start stage not declared,
	 * name collision) where no JSONL file was created.
	 */
	runId?: string;
	stagesCompleted: number;
	success: boolean;
	/**
	 * Primary artifact at run termination, serialised to its handle's
	 * canonical string form (fs → path, url → href, opaque → id). Undefined
	 * if no produces stage produced one. Callers that need the full
	 * structured handle read `output.artifacts[0]` off the run's last
	 * recorded stage (via `readLastStage`).
	 */
	lastArtifact?: string;
	error?: string;
	/**
	 * Discriminated termination outcome — the full-fidelity form behind the
	 * `success`/`error` projections above (which can't represent "cancelled"
	 * vs "aborted" vs "failed"). `{ status: "running" }` means the runner
	 * unwound without reaching any terminal write — callers treat it as
	 * failure, same as the `success: false` projection does.
	 *
	 * Undefined ONLY for pre-flight rejections (no run was constructed) —
	 * same rule as `runId`.
	 */
	termination?: RunTermination;
	/**
	 * Routing decisions made in memory but whose JSONL audit row failed to
	 * persist. Empty in the common case. Surfaced so consumers reading the
	 * run's JSONL can disambiguate a missing routing row ("deterministic
	 * edge — never written") from a dropped one ("decision was made, write
	 * failed"). The run still succeeds — routing rows are telemetry, not
	 * reconstruction inputs.
	 */
	droppedRoutingRows?: Array<{ fromStageIndex: number; fromStage: string; decision: string }>;
	/**
	 * Stages whose terminal failure/aborted row failed to persist. Empty in
	 * the common case. Unlike routing rows, failure rows ARE reconstruction
	 * inputs: a trail missing its failure row reads as if the run stopped
	 * after its last successful stage, so a later resume would route onward
	 * past the stage that actually failed. Consumers holding this list should
	 * not resume the run from disk.
	 */
	droppedFailureRows?: string[];
}

/** Per-run context the chain carries from stage to stage. */
export interface RunContext {
	cwd: string;
	runId: string;
	workflow: Workflow;
	/**
	 * Count of stages reachable from `workflow.start`, computed once at run
	 * start. The actual stage count is path-dependent (a predicate edge may
	 * short-circuit); surfaced as run metadata through the lifecycle
	 * `LifecycleContext.totalStages`.
	 */
	totalStages: number;
	state: RunState;
	/**
	 * Stage names already executed in this run. A decision edge resolving to
	 * a visited stage is a backward jump; revise → implement loops
	 * legitimately revisit stages, but unbounded loops trip the cap.
	 */
	visited: Set<string>;
	/**
	 * Decision-edge re-entry count per destination stage — the backward-jump
	 * guard's ledger. Each stage may be re-entered at most `maxBackwardJumps`
	 * times; counting per destination (not as a shared streak) keeps the
	 * retry budget invariant to how many decision edges a fix cycle crosses
	 * per iteration, and gives unrelated loops independent budgets by
	 * construction.
	 */
	revisits: Map<string, number>;
	/**
	 * Set of bare skill names registered with Pi at workflow start (e.g.
	 * "research", "blueprint" — the `skill:` prefix is stripped). Snapshot
	 * is taken ONCE in `runWorkflow` before any `ctx.newSession()` runs,
	 * because Pi invalidates `WorkflowHost` handles after a session
	 * replacement. `ensureSkillRegistered` consults this set instead of
	 * calling `host.getCommands()` mid-run.
	 *
	 * Undefined when no host was passed to `runWorkflow` (programmatic
	 * embedders that opt out of the skill-registration preflight — same
	 * fail-soft posture as the rest of the host-optional surface).
	 */
	registeredSkills?: ReadonlySet<string>;
	/**
	 * Snapshot of the registered skill-contract registry, taken once in
	 * `buildRunContext` (mirrors `registeredSkills`). This is the
	 * registered (`declared`-source) registry — NOT the harvested-merged
	 * `LoadedWorkflows.skillContracts` — because both runtime uses only add
	 * value over a declared contract:
	 *   - `ensureContractInputValid` mirrors a declared `consumes.data` that
	 *     lacks a stage `inputSchema` (a harvested `consumes.data` is the
	 *     stage's own `inputSchema` re-derived, already covered by
	 *     `ensureInputValid`);
	 *   - `effectiveOutputSchema` (threaded onto `StageSessionContext`) sources a
	 *     declared `produces.data` as the output schema when the stage carries
	 *     no `outputSchema` of its own.
	 * Fail-soft: both degrade (no validation, never throw) when absent.
	 */
	skillContracts?: SkillContractMap;
	/**
	 * Resolve a per-stage model override, injected by the embedder (rpiv-pi maps
	 * each `{ stage, skill }` to its model/effort override). The runner threads
	 * the result onto every `StageSessionContext.model`; the host applies it at child
	 * creation (NOT via global mutation). Undefined ⇒ host default.
	 */
	resolveModel?: (id: { stage: string; skill: string }) => ModelSelection | undefined;
	/**
	 * Host-injected reader that re-opens a persisted child-session JSONL and
	 * returns its branch (`SessionManager.open(file).getBranch()` on the rpiv-pi
	 * side, narrowed to `BranchEntry[]`). Consumed by the death-scene artifact
	 * writer at failure time (death-scene.ts) — the ONLY reader. Undefined for
	 * programmatic embedders / no provider, in which case the writer degrades
	 * silently (no artifact, no warning). Threaded provider → executor →
	 * `RunContext` → `SessionContext` → `AuditContext` → `auditFor`.
	 */
	readSessionBranch?: (file: string) => BranchEntry[] | undefined;
	/**
	 * Worktree-digest resolver injected by the embedder (tests / programmatic
	 * embedders that want to stub the filesystem). Threaded onto every
	 * `StageSessionContext.worktreeDigest` and read by the validation-retry gate
	 * (`packages/rpiv-workflow/sessions/extraction.ts` mechanism-1 +
	 * `packages/rpiv-workflow/runner/run-stage.ts` mechanism-2) via
	 * `resolveDigest` (`worktree-digest.ts`). Undefined ⇒ the built-in
	 * `computeWorktreeDigest` (git + `.rpiv/artifacts/` recipe).
	 */
	worktreeDigest?: (cwd: string) => string | undefined;
	maxBackwardJumps: number;
	/**
	 * Run-wide safety cap on loop units — clamps the effective cap of EVERY
	 * loop kind (`min(loop.max, run.maxIterations)`), the backstop for a
	 * source that never terminates (a pull generator that never returns
	 * `null`, an assess `done` that never trips). What happens at the cap is
	 * the loop's `CapPolicy`. Defaults to `MAX_ITERATIONS`.
	 */
	maxIterations: number;
	/** What triggered the run; defaulted at `runWorkflow` entry. */
	trigger: RunTrigger;
	/** Lifecycle event dispatcher — see `events.ts`. Threaded by reference. */
	lifecycle: LifecycleDispatcher;
	/**
	 * Optional cooperative-cancellation signal from `RunWorkflowOptions.signal`.
	 * Checked at the between-stage seam (top of `dispatchStageOrRecordFailure`, before
	 * the start stage and before every routed next stage). An aborted signal
	 * records an `"aborted"` terminal row and unwinds — it does NOT interrupt a
	 * stage already streaming (Pi owns the live session).
	 */
	signal?: AbortSignal;
}

/**
 * Per-stage / per-unit common base. Extended by `StageSessionContext` (loop units
 * thread their identity through `StageSessionContext.unit`); consumed in pick form by
 * `AuditContext` (audit.ts) so the audit layer pins its dependency on this shape
 * structurally instead of duplicating the field list.
 *
 * `stageName` is the workflow stage's record key — the value that lands
 * in `WorkflowStage.stage`. `skill` is the Pi skill body the runner
 * dispatches (`/skill:<skill>`). They're equal in the common case but
 * diverge for aliased stages (`stages: { "implement-after-revise":
 * acts({ skill: "implement" }) }` → stageName="implement-after-revise",
 * skill="implement").
 */
export interface SessionContext {
	cwd: string;
	runId: string;
	state: RunState;
	/** `/skill:<name> <args>`. */
	prompt: string;
	/** Workflow stage record key — JSONL `WorkflowStage.stage` value. */
	stageName: string;
	/** Pi skill body — `/skill:<skill>` dispatch + status-line label + JSONL `WorkflowStage.skill`. */
	skill: string;
	/** Shared lifecycle dispatcher. Threaded from `RunContext` so the audit layer can fire `onStageEnd` / `onStageError` / `onUnitEnd` without re-importing it. */
	lifecycle: LifecycleDispatcher;
	/**
	 * Read-only run identity passed to lifecycle callbacks. Captured at
	 * session construction (cwd + runId + workflow name + totalStages +
	 * trigger). Built once per run, reused.
	 */
	runIdentity: {
		workflow: string;
		totalStages: number;
		trigger: RunTrigger;
	};
	/**
	 * The activation's allocated JSONL stage number. Assigned ONCE (via
	 * `allocateStageNumber`) when output production begins, BEFORE the output
	 * envelope is built — the envelope's `meta.stageNumber`, the audit row
	 * (success or failure), and every lifecycle ref for this activation then
	 * agree on one explicit value. Undefined until the activation reaches
	 * output production; pre-output halts allocate at record time instead.
	 */
	allocatedStageNumber?: number;
	/**
	 * Host-injected persisted-session branch reader, threaded from
	 * `RunContext.readSessionBranch`. Read by the death-scene artifact writer
	 * (`writeDeathSceneArtifact`) via `AuditContext`; absent for programmatic
	 * embedders (the writer degrades silently). Travels FURTHER than
	 * `resolveModel` — into `SessionContext` → `AuditContext` → `auditFor` —
	 * because the writer reads it from `AuditContext` at failure time.
	 */
	readSessionBranch?: (file: string) => BranchEntry[] | undefined;
}

/**
 * Unit identity threaded onto a loop unit's session. Source of the
 * structured JSONL row fields (`unitRowFields`, audit.ts) and the public
 * `UnitEvent` lifecycle payload. `parent` is the loop stage's record key —
 * the value resume dispatch and the fold key on; `label` feeds the decorated
 * display string, the status line, and the per-unit toast.
 */
export interface UnitRef {
	parent: string;
	role: import("./api.js").UnitRole;
	/** 0-based generation cursor (== the round index for assess loops). */
	index: number;
	/** Stable audit identity (`unit.id ?? unit.label` for fanout/iterate; undefined for assess). */
	id?: string;
	/** Display tag. */
	label: string;
}

export interface StageSessionContext extends SessionContext {
	stage: StageDef;
	/**
	 * Registered skill-contract registry, threaded from
	 * `RunContext.skillContracts` at session construction. Lets output
	 * validation fall back to the dispatched skill's `produces.data` when the
	 * stage carries no `outputSchema` of its own. Fail-soft: absent for
	 * programmatic embedders that opt out of contract registration.
	 */
	skillContracts?: SkillContractMap;
	/** 0-based stage index within this run — for status display + JSONL stage number. */
	stageIndex: number;
	/** Pre-stage snapshot value (undefined if the stage's `outcome` has no `snapshot`). */
	snapshot: unknown;
	/**
	 * Resolved per-unit model override (from `RunContext.resolveModel`), applied
	 * by the host at child-session creation — NOT via global mutation. Undefined
	 * ⇒ host default.
	 */
	model?: ModelSelection;
	/**
	 * Worktree-digest resolver threaded from `RunContext.worktreeDigest` — read
	 * by the validation-retry mechanism-1 gate in `packages/rpiv-workflow/sessions/extraction.ts`
	 * (`resolveDigest(s.worktreeDigest, s.cwd)`). Undefined ⇒ built-in git +
	 * artifacts recipe.
	 */
	worktreeDigest?: (cwd: string) => string | undefined;
	/**
	 * Per-child cooperative-abort signal. Threaded from `RunContext.signal` (the
	 * fanout dispatcher narrows it to a per-generation controller) so
	 * an aborted run interrupts an in-flight child, not just the between-stage
	 * seam.
	 */
	signal?: AbortSignal;
	/**
	 * When true (a collect-all fanout unit), a SEMANTIC unit failure
	 * (extraction/validation/timeout/length) soft-halts THIS unit (non-terminal
	 * failed-output sentinel handed to `onSuccess`) instead of terminating the
	 * whole run. An infra-death stop (error/noResponse/toolUse — the session
	 * never delivered a complete pass) hard-fails even here, so resume
	 * re-dispatches the dead unit instead of permanently collecting it (see
	 * `isInfraDeath`, sessions/halt-routing.ts). Set by `buildUnitSession` for
	 * non-fail-fast fanout; the routing lives in `haltStageOrSoftHalt`.
	 */
	collectAll?: boolean;
	/**
	 * The per-unit lane key for rpiv-pi's lane dock/viewer — set ONLY for fan-out
	 * units (`e.loop.kind === "fanout"`), to the unit's declared `index`. Undefined for
	 * sequential loop units (iterate/assess) and single stages, which collapse onto the
	 * host's reserved single-unit slot so the lane (parent) row keeps showing the one
	 * live session. Distinct from `unit.index` (the audit identity threaded for every
	 * loop unit): this field exists purely so the host can decide which spawns become
	 * individually-addressable concurrent sub-lanes. `openChild` threads it into
	 * `spawnChild`'s `unitIndex`; inert on a non-lane host.
	 */
	laneUnitIndex?: number;
	/** Only set for continue stages — branch slice offset. */
	branchOffset?: number;
	/**
	 * Per-activation bash-overrun strike-ceiling override (testability) —
	 * `undefined` ⇒ the `BASH_TIMEOUT_STRIKES` module default. Pin to `0` in a
	 * watchdog-contract test to force immediate exhaustion; pin to `N` to drive
	 * a multi-strike recovery without mutating env. Now the SOLE strike surface
	 * on `StageSessionContext`: the mutable accounting (used counter + reasons
	 * accumulator) lives in the private `StrikeBudget` value object held in
	 * `sessions/bash-strikes.ts`, keyed off this session (read once at first
	 * consume to resolve the budget's ceiling). Immutable per-activation.
	 */
	bashTimeoutStrikes?: number;
	/**
	 * Present iff this session IS one loop unit. Pre-decorated at session
	 * construction by the driver (`stageName` carries the DISPLAY decoration;
	 * this field carries the machine identity). Drives: structured row fields,
	 * `onUnitEnd` instead of `onStageEnd`, the labeled per-unit toast, and
	 * unit-attributed failure rows.
	 */
	unit?: UnitRef;
	onFailure?: (ctx: WorkflowHostContext) => void;
	/**
	 * Receives the stage's VALIDATED Output envelope (not just
	 * `artifacts[0]`) — loop continuations thread it into `accumulated` /
	 * `feedForward` directly, with no `run.state.output!` back-read.
	 *
	 * Return type is `Promise<unknown>` (not `void`) so the chain walk's
	 * `ChainOutcome`-returning continuations plug in directly; the session
	 * layer only awaits settlement.
	 */
	onSuccess: (ctx: WorkflowHostContext, output: Output) => Promise<unknown>;
}
