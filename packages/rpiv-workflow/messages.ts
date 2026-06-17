/**
 * User-facing message constants.
 * - `STATUS_*` via `ctx.ui.setStatus` — persists across `newSession`.
 * - `MSG_*` / `ERR_*` via `ctx.ui.notify` — one-shot; may be repainted by
 *   Pi's session transition (the status line is the durable channel).
 * - `FAIL_*` — structured terminal-failure descriptors (see `FailureText`).
 *
 * Audience split: this module is the UI/runtime constants. The
 * model-facing validation-retry prompt lives beside its only consumer
 * (sessions/extraction.ts); legacy-migration notices live in load/legacy.ts;
 * `/wf` usage strings live in command.ts / preview.ts.
 */

export const STATUS_KEY = "rpiv-workflow";

/**
 * One structured descriptor per terminal-failure kind — the `toast` (the
 * one-shot `ctx.ui.notify` line) and the `error` (what lands in
 * `state.termination.error` + the JSONL row's `errMsg`) rendered from ONE
 * factory so the two channels can never drift again (the old MSG_/ERR_
 * twin constants had already diverged in content). Halt sites hand the
 * descriptor to `failedArgs`/`abortedArgs` (audit.ts) or spread it into
 * `StagePreflightError`.
 */
export interface FailureText {
	toast: string;
	error: string;
}

export const STATUS_STAGE = (stage: number, total: number, skill: string) => `rpiv: stage ${stage}/${total} — ${skill}`;

export const MSG_STAGE_COMPLETE = (skill: string) => `✓ ${skill} completed`;
export const MSG_STAGE_FAILED = (skill: string) => `✗ ${skill} failed — stopping workflow`;

export const FAIL_STAGE_ABORTED = (skill: string): FailureText => ({
	toast: `⏸ ${skill} aborted (ESC) — stopping workflow`,
	error: `${skill} aborted by user (ESC)`,
});
export const FAIL_STAGE_TRUNCATED = (skill: string): FailureText => ({
	toast: `✗ ${skill} truncated — model hit output cap mid-reply, stopping workflow`,
	error: `${skill} truncated — model hit output-length cap mid-reply`,
});
export const FAIL_STAGE_TOOL_STALLED = (skill: string): FailureText => ({
	toast: `✗ ${skill} tool loop did not settle — stopping workflow`,
	error: `${skill} tool loop did not settle before the orchestrator inspected the branch`,
});
export const FAIL_STAGE_NO_RESPONSE = (skill: string): FailureText => ({
	toast: `✗ ${skill} produced no response — stopping workflow`,
	error: `${skill} produced no assistant message`,
});

export const MSG_WORKFLOW_COMPLETE = (stages: number) => `rpiv: workflow complete (${stages} stages)`;
export const MSG_WORKFLOW_CANCELLED = "rpiv: workflow cancelled";

// Programmatic abort via RunWorkflowOptions.signal — checked between stages.
export const FAIL_WORKFLOW_ABORTED = (stage: string): FailureText => ({
	toast: "rpiv: workflow aborted",
	error: `workflow aborted before stage "${stage}" (signal)`,
});

export const MSG_VALIDATION_RETRY = (skill: string, attempt: number) =>
	`rpiv: ${skill} output validation failed — asking agent to fix (attempt ${attempt})`;
export const FAIL_VALIDATION_EXHAUSTED = (skill: string, failures: string): FailureText => ({
	toast: `rpiv: ${skill} output validation exhausted retries`,
	error: `${skill} output validation failed after retries: ${failures}`,
});

export const FAIL_INPUT_VALIDATION = (currentSkill: string, prevSkill: string, failures: string): FailureText => ({
	toast: `✗ ${currentSkill} input validation failed — upstream ${prevSkill} produced invalid data`,
	error: `Input validation failed for '${currentSkill}': upstream '${prevSkill}' produced invalid data: ${failures}`,
});

/**
 * Bound on a single schema-validate call. Sync schemas resolve in one
 * microtask and never trip this; async schemas (filesystem probes, registry
 * lookups, async-by-default libs) that fail to settle within
 * `validateTimeoutMs` halt the stage rather than hang it. Skill
 * attribution is added by the caller's fatal-extraction wrapper, so the
 * factory itself doesn't repeat the skill prefix.
 */
export const ERR_SCHEMA_TIMEOUT = (slot: "outputSchema" | "inputSchema", ms: number) =>
	`${slot} validation exceeded ${ms}ms — schema's ~standard.validate did not settle`;

export const FAIL_MISSING_ARTIFACT = (currentSkill: string, stageNumber: number): FailureText => ({
	toast: `✗ ${currentSkill} has no upstream artifact to consume — stopping workflow`,
	error: `Stage ${stageNumber} (${currentSkill}) has no upstream artifactPath; only stage 1 may consume the user's original input`,
});

/**
 * A stage declares `reads: [..., name, ...]` but `state.named[name]` is
 * empty at preflight time. Either the producing stage hasn't run yet on
 * this path (workflow-load reachability catches the impossible case;
 * this surfaces the "haven't reached the producer" runtime case), or
 * the producer was authored with no outcome and a name that doesn't
 * match any stage record key.
 */
export const FAIL_MISSING_NAMED_READ = (currentSkill: string, name: string, stageNumber: number): FailureText => ({
	toast: `✗ ${currentSkill} reads "${name}" but no upstream produces stage has published it yet — stopping workflow`,
	error: `Stage ${stageNumber} (${currentSkill}) reads "${name}" but state.named["${name}"] is empty; check that an upstream produces stage publishes this name`,
});

export const FAIL_BACKWARD_JUMP_EXHAUSTED = (jumps: number, max: number): FailureText => ({
	toast: `rpiv: backward-jump limit exceeded (${jumps}/${max}) — stopping workflow to prevent infinite loop`,
	error: `Backward-jump limit exceeded: ${jumps} backward jumps (max ${max})`,
});

/**
 * Status line for one loop unit. `skill` is the unit's dispatched skill body
 * (the judge's skill — or the synthetic `<parent>-judge` label — on a judge
 * unit); `label` is the unit's display tag (`"phase 2/5"`, `"r0·judge"`).
 * One template for all three loop kinds — the retired fanout/iterate
 * templates were byte-identical; assess threads its round/phase cursor as
 * the label.
 */
export const STATUS_LOOP_UNIT = (stage: number, total: number, skill: string, label: string) =>
	`rpiv: stage ${stage}/${total} — ${skill} (${label})`;

/**
 * Per-unit completion toast — labeled so eight units of one fanout read as
 * eight distinct completions, not eight copies of the stage banner (the loop
 * end still owns MSG_STAGE_COMPLETE).
 */
export const MSG_UNIT_COMPLETE = (skill: string, label: string) => `✓ ${skill} (${label})`;

/**
 * Per-unit SOFT-halt toast — a collect-all fanout unit failed but the run
 * survives (a `failedOutput` sentinel fills its slot; synthesis skips it).
 * Warns (not errors): the run is not terminating.
 */
export const MSG_UNIT_FAILED = (skill: string, label: string) => `rpiv: ${skill} unit "${label}" failed (collected)`;

/** Rollup status under concurrency — N units in flight on one status line. */
export const STATUS_FANOUT_ROLLUP = (
	stage: number,
	total: number,
	skill: string,
	active: number,
	done: number,
	count: number,
) => `rpiv: stage ${stage}/${total} — ${skill} (${active} running, ${done}/${count} done)`;

/**
 * A loop produced zero units (push: empty array handled upstream as
 * single-stage fall-through, so this fires only for a pull loop whose FIRST
 * call returned null). Not an error — nothing published, the primary stays at
 * the entry pair; warn so the author notices the empty input.
 */
export const MSG_LOOP_ZERO_UNITS = (skill: string) =>
	`rpiv: ${skill} iterate loop produced zero units — nothing published, advancing`;

/**
 * A loop hit its effective cap (`min(loop.max, run.maxIterations)`) under
 * `onCap: "halt"` — terminal failure, mirroring the backward-jump guard.
 */
export const FAIL_LOOP_CAP_HALT = (count: number, max: number): FailureText => ({
	toast: `rpiv: loop cap exceeded (${count}/${max}) — stopping workflow to prevent an unbounded loop`,
	error: `Loop cap exceeded: ${count} units (max ${max})`,
});

/**
 * A loop hit its effective cap under `onCap: "advance"` — soft-stop: warn,
 * land the {type:"loop-cap"} telemetry row, keep the projected result,
 * advance. Deliberately no ERR_ twin (not a failure).
 */
export const MSG_LOOP_CAP_ADVANCE = (skill: string, max: number) =>
	`rpiv: ${skill} loop reached its cap (${max}) — projecting the configured result and advancing`;

/**
 * A verify-bearing stage exhausted its attempt budget without a passing
 * verdict (the synthesized loop's `onCap: "halt"` tripped). Verify-worded —
 * the author declared a post-condition, not a loop, so the loop-cap pair
 * would misattribute the failure. A pass on the final attempt never reaches
 * this (`done` wins over the cap).
 */
export const FAIL_VERIFY_FAILED = (stage: string, attempts: number): FailureText => ({
	toast: `✗ ${stage} verification failed after ${attempts} attempt${attempts === 1 ? "" : "s"} — stopping workflow`,
	error: `Verification failed for "${stage}": the judge's verdict did not satisfy \`pass\` after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
});

export const FAIL_AUDIT_WRITE = (skill: string): FailureText => ({
	toast: `✗ ${skill} completed but audit row could not be written — stopping workflow`,
	error: `${skill} completed but the JSONL audit row could not be appended; halting to keep in-memory state aligned with disk`,
});

/**
 * Notified when a TERMINAL failure/aborted row could not be appended. Unlike
 * routing rows this is a reconstruction input: without it the trail's last
 * row reads "completed" and a later resume would route onward past the stage
 * that actually failed. The run is already halting — the user (and the
 * result envelope's `droppedFailureRows`) must know the trail is unsafe to
 * resume from.
 */
export const MSG_FAILURE_ROW_DROPPED = (stage: string) =>
	`⚠ rpiv: failure row for ${stage} not persisted to audit trail — do not resume this run from disk`;

export const MSG_CHAIN_ADVANCE_FAILED = (fromStage: string, reason: string) =>
	`✗ chain advance after ${fromStage} failed: ${reason} — stopping workflow`;

/**
 * Stage threw before it could record its own audit row — covers
 * `enforceSessionInvariants` violations, session-machinery errors, and any
 * other path that escapes `runStage` directly. Distinguished from
 * `MSG_CHAIN_ADVANCE_FAILED` (which is about an edge throwing AFTER a stage
 * succeeded) — the user needs to see *which* stage failed, not which one
 * preceded the failure. Wording is deliberately neutral ("failed", not
 * "failed to start"): throws from mid-stage machinery land here too.
 */
export const MSG_STAGE_THREW = (skill: string, reason: string) =>
	`✗ stage ${skill} failed: ${reason} — stopping workflow`;

/**
 * Loop cursor reached a state its state machine forbids (e.g. a judge step
 * with no completed produce behind it). `advanceCursor` makes these states
 * unreachable and the resume fold's shape guards refuse corrupted trails, so
 * a throw here is an internal bug surfaced with stage attribution instead of
 * a bare `TypeError`.
 */
export const MSG_LOOP_CURSOR_CORRUPT = (stage: string, detail: string) =>
	`✗ loop stage ${stage}: cursor invariant violated — ${detail}`;

/**
 * Collector/parser throws — `collect`/`parse` are the PRIMARY user extension
 * points, so a throw is attributed to the throwing half (not folded into the
 * generic stage-machinery wording). Lands in `state.termination.error` via
 * the extraction fatal arm.
 */
export const ERR_COLLECTOR_THREW = (skill: string, reason: string) => `${skill}: outcome collector threw: ${reason}`;
export const ERR_PARSER_THREW = (skill: string, reason: string) => `${skill}: outcome parser threw: ${reason}`;

/**
 * Stage references a Pi skill that isn't registered with the running Pi
 * instance. Surfaced loudly here instead of letting the `/skill:<name>` text
 * leak verbatim into the LLM context — `rpiv-args` is the only expander on
 * the programmatic dispatch path (`expandPromptTemplates: false`), so an
 * unknown skill name would otherwise reach the model as a bare user-message
 * imperative outside the `<skill>...</skill>` contract.
 */
export const FAIL_SKILL_NOT_REGISTERED = (skill: string, stageNumber: number): FailureText => ({
	toast: `✗ ${skill} is not a registered Pi skill — stopping workflow`,
	error: `Stage ${stageNumber} requires Pi skill "${skill}" but no skill by that name is registered with Pi (check installed sibling packages and \`pi.skills\` manifest entries)`,
});

/**
 * Notified live when a routing-decision row could not be appended. The chain
 * continues (the decision has already been made), but the user must know the
 * audit trail for this run has a gap — otherwise an absent row reads as
 * "no decision was made" rather than "decision made, write dropped."
 */
export const MSG_ROUTING_AUDIT_DROPPED = (fromStage: string, decision: string) =>
	`⚠ rpiv: routing decision ${fromStage} → ${decision} not persisted to audit trail (continuing run)`;

/** Recap surfaced on stage failure — pre-joined bullet list of artifact paths. */
export const MSG_PARTIAL_ARTIFACTS = (artifactList: string) => `Artifacts produced before failure:\n${artifactList}`;

/** Lifecycle listener threw — warning so the user sees it but the run never halts. */
export const MSG_LIFECYCLE_THREW = (event: string, reason: string) =>
	`⚠ rpiv: lifecycle listener (${event}) threw: ${reason}`;

/**
 * Outcome snapshot hook threw — the stage still runs (snapshot is best-effort)
 * but diff-based collectors will see `snapshot: undefined`. Warned once per
 * run so a consistently-throwing custom snapshot can't silently disable
 * diffing for every stage.
 */
export const MSG_SNAPSHOT_FAILED = (stage: string, reason: string) =>
	`⚠ rpiv: outcome snapshot for ${stage} threw (${reason}) — pre-stage diff degraded for this stage`;

/**
 * Script stage's `run()` body threw. Distinct from `MSG_STAGE_THREW`
 * (which covers session-machinery and preflight throws) so users see
 * the failure surface attributed to the script function rather than to
 * the runner.
 */
export const FAIL_SCRIPT_THREW = (stage: string, reason: string): FailureText => ({
	toast: `✗ ${stage} script threw — stopping workflow: ${reason}`,
	error: `${stage} script threw: ${reason}`,
});

// ---------------------------------------------------------------------------
// Resume-refusal messages — reconstruct refusals returned in the
// RunWorkflowResult envelope (the caller notifies; no-JSONL → no machinery row)
// ---------------------------------------------------------------------------

export const ERR_RESUME_NO_ROWS = (runId: string) => `rpiv: run ${runId} has no recorded stages — nothing to resume`;
/**
 * A stage-shaped row failed the deep shape guard. Resume REFUSES rather than
 * skip: the fold replays the trail as its system of record, and a silently
 * dropped row would replay a hole ("this stage never ran") and route onward
 * past it.
 */
export const ERR_RESUME_MALFORMED_ROW = (detail: string) =>
	`rpiv: cannot resume — the run's trail contains a malformed stage row (${detail}); ` +
	`resume refuses rather than replay an incomplete history`;
/**
 * The run's header carries a schema version this build doesn't write —
 * resume refuses rather than fold rows whose shapes it may misread.
 * Absent `v` is version 1 (back-compat), so this only fires on a real bump.
 */
export const ERR_RESUME_VERSION_MISMATCH = (detail: string, expected: number) =>
	`rpiv: cannot resume — ${detail}, but this build reads schema v${expected}; ` +
	`resume refuses rather than misread the trail`;
export const ERR_RESUME_STAGE_GONE = (stage: string, workflow: string) =>
	`rpiv: cannot resume — stage "${stage}" from the run no longer exists in workflow "${workflow}" ` +
	`(renamed or removed)`;
/**
 * Resume drift refusal — one pair for all loop kinds. The unit source
 * recomputed a different unit than the run recorded at a folded boundary
 * (the determinism contract: deterministic w.r.t. the fold-replayed RunState
 * + accumulated outputs). Resume refuses rather than re-run the wrong units.
 */
export const ERR_RESUME_LOOP_MISMATCH = (stage: string) =>
	`rpiv: cannot resume — loop stage "${stage}" recomputed a different unit than the run recorded ` +
	`(the unit source must be deterministic w.r.t. the replayed run state + accumulated outputs; ` +
	`resume refuses rather than re-run the wrong units)`;
export const MSG_RESUME_LOOP_MISMATCH = (stage: string) =>
	`rpiv: loop "${stage}" changed on resume — cannot safely continue`;

// ---------------------------------------------------------------------------
// Session-backed resume (promotion + reattach) — notify-only progress toasts
// + the fallback-ladder notice, plus the one model-facing reattach prompt
// ---------------------------------------------------------------------------

export const MSG_RESUME_PROMOTED = (skill: string) =>
	`✓ ${skill}: interrupted session already produced the artifact — stage promoted to completed`;

export const MSG_RESUME_REATTACHED = (skill: string) => `↻ ${skill}: reattached to interrupted session`;

/**
 * One ladder-rung notice before a session-backed resume degrades to today's
 * cold re-run. `why` is a short human clause — "session file not found",
 * "host cannot switch sessions" — not a dispatch key (nothing parses it).
 */
export const MSG_RESUME_SESSION_FALLBACK = (skill: string, why: string) =>
	`rpiv: ${skill} — ${why}; re-running the stage from scratch`;

/**
 * Sent to the AGENT when a stage reattaches to its interrupted session
 * (model-facing prompt text — promotion already missed, so the artifact
 * was not announced or not written).
 */
export const REATTACH_PROMPT = (skill: string) =>
	`The previous run of /skill:${skill} in this session was interrupted. ` +
	"Review the conversation above. If the work is already complete, announce the artifact path. " +
	"Otherwise finish the remaining work and announce the artifact path when done.";

// ---------------------------------------------------------------------------
// Resume-refusal messages — resumeWorkflowByRef pre-resume guards (resolve →
// load-gate → find); returned in the envelope before resumeWorkflow is reached
// ---------------------------------------------------------------------------

export const MSG_RESUME_USAGE = "rpiv: usage — /wf @<run-id | name | path-to.jsonl>";
export const MSG_RUN_NOT_FOUND = (ref: string) => `rpiv: no run found for "${ref}"`;
export const MSG_RESUME_WORKFLOW_GONE = (workflow: string, ref: string) =>
	`rpiv: run "${ref}" used workflow "${workflow}", which is no longer registered`;

// ---------------------------------------------------------------------------
// /wf command shell — notify-only (never lands in state.error; ERR_ reserved)
// ---------------------------------------------------------------------------

export const MSG_INTERACTIVE_ONLY = "/wf requires interactive mode";

export const MSG_WORKFLOW_THREW = (reason: string) => `/wf: workflow runner failed unexpectedly: ${reason}`;

export const MSG_NAME_INVALID = (name: string) =>
	`rpiv: invalid name "${name}" — must be 1-64 chars, start with a letter or underscore, only letters, digits, hyphens, underscores`;

export const MSG_NAME_COLLISION = (name: string, runId: string) => `name '${name}' already used by run ${runId}`;

export const MSG_NAME_INDEX_WRITE_FAILED = (name: string) =>
	`/wf: could not persist name "${name}" to the names index — run aborted (no run started). Check filesystem permissions for .rpiv/workflows/runs/`;

export const MSG_HEADER_WRITE_FAILED = (runId: string) =>
	`rpiv: could not write the run header for ${runId} — run aborted (no stage executed). Check filesystem permissions for .rpiv/workflows/runs/`;

export const MSG_NAME_IGNORED_ON_RESUME =
	"/wf: --name has no effect on @resume (the ref already identifies the run) — ignoring it";

export const MSG_NAME_FLAG_MID_INPUT =
	"/wf: --name is only honored as the first or last token — a mid-input --name is treated as workflow input text";

export const MSG_LOAD_ABORTED = (count: number) =>
	`/wf: ${count} ${count === 1 ? "config error" : "config errors"} — see warnings above (fix and re-run)`;

export const MSG_WORKFLOW_NOT_FOUND = (name: string) => `/wf: workflow "${name}" not found`;

/**
 * No layer (built-in / user / project) contributed a workflow. Surfaced
 * instead of trying to run with an undefined default — without rpiv-pi
 * installed and no user overlay, the merged registry is genuinely empty
 * and the user needs to install a sibling that bundles workflows or
 * author one in `.rpiv/workflows/config.ts`.
 */
export const MSG_NO_WORKFLOWS_REGISTERED =
	"/wf: no workflows registered — install a sibling that bundles workflows or author one in `.rpiv/workflows/config.ts`";
