/**
 * User-facing message constants.
 * - `STATUS_*` via `ctx.ui.setStatus` — persists across `newSession`.
 * - `MSG_*` / `ERR_*` via `ctx.ui.notify` — one-shot; may be repainted by
 *   Pi's session transition (the status line is the durable channel).
 */

import { join } from "node:path";

export const STATUS_KEY = "rpiv-workflow";

export const STATUS_STAGE = (stage: number, total: number, skill: string) => `rpiv: stage ${stage}/${total} — ${skill}`;

export const MSG_STAGE_COMPLETE = (skill: string) => `✓ ${skill} completed`;
export const MSG_STAGE_FAILED = (skill: string) => `✗ ${skill} failed — stopping workflow`;
export const MSG_STAGE_ABORTED = (skill: string) => `⏸ ${skill} aborted (ESC) — stopping workflow`;
export const MSG_STAGE_TRUNCATED = (skill: string) =>
	`✗ ${skill} truncated — model hit output cap mid-reply, stopping workflow`;
export const MSG_STAGE_TOOL_STALLED = (skill: string) => `✗ ${skill} tool loop did not settle — stopping workflow`;
export const MSG_STAGE_NO_RESPONSE = (skill: string) => `✗ ${skill} produced no response — stopping workflow`;

export const ERR_STAGE_ABORTED = (skill: string) => `${skill} aborted by user (ESC)`;
export const ERR_STAGE_TRUNCATED = (skill: string) => `${skill} truncated — model hit output-length cap mid-reply`;
export const ERR_STAGE_TOOL_STALLED = (skill: string) =>
	`${skill} tool loop did not settle before the orchestrator inspected the branch`;
export const ERR_STAGE_NO_RESPONSE = (skill: string) => `${skill} produced no assistant message`;

export const MSG_WORKFLOW_COMPLETE = (stages: number) => `rpiv: workflow complete (${stages} stages)`;
export const MSG_WORKFLOW_CANCELLED = "rpiv: workflow cancelled";

// Programmatic abort via RunWorkflowOptions.signal — checked between stages.
export const MSG_WORKFLOW_ABORTED = "rpiv: workflow aborted";
export const ERR_WORKFLOW_ABORTED = (stage: string) => `workflow aborted before stage "${stage}" (signal)`;

export const MSG_VALIDATION_RETRY = (skill: string, attempt: number) =>
	`rpiv: ${skill} output validation failed — asking agent to fix (attempt ${attempt})`;
export const MSG_VALIDATION_EXHAUSTED = (skill: string) => `rpiv: ${skill} output validation exhausted retries`;
export const ERR_VALIDATION_FAILED = (skill: string, failures: string) =>
	`${skill} output validation failed after retries: ${failures}`;

/**
 * Sent to the agent as a follow-up message when an output-schema validation
 * fails — instructs the agent to re-write the artifact at the same path with
 * a corrected frontmatter. `errorLines` is a pre-joined bullet list (one
 * line per failure) so the factory stays single-arg-typed.
 */
export const MSG_VALIDATION_RETRY_PROMPT = (skill: string, errorLines: string) =>
	`The ${skill} artifact's frontmatter doesn't satisfy the expected output schema. ` +
	"Fix only the fields listed below, then re-write the artifact at the same path (don't move it):\n\n" +
	`${errorLines}`;

export const MSG_INPUT_VALIDATION_FAILED = (currentSkill: string, prevSkill: string) =>
	`✗ ${currentSkill} input validation failed — upstream ${prevSkill} produced invalid data`;
export const ERR_INPUT_VALIDATION_FAILED = (currentSkill: string, prevSkill: string, failures: string) =>
	`Input validation failed for '${currentSkill}': upstream '${prevSkill}' produced invalid data: ${failures}`;

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

export const MSG_MISSING_ARTIFACT = (currentSkill: string) =>
	`✗ ${currentSkill} has no upstream artifact to consume — stopping workflow`;
export const ERR_MISSING_ARTIFACT = (currentSkill: string, stageNumber: number) =>
	`Stage ${stageNumber} (${currentSkill}) has no upstream artifactPath; only stage 1 may consume the user's original input`;

/**
 * A stage declares `reads: [..., name, ...]` but `state.named[name]` is
 * empty at preflight time. Either the producing stage hasn't run yet on
 * this path (workflow-load reachability catches the impossible case;
 * this surfaces the "haven't reached the producer" runtime case), or
 * the producer was authored with no outcome and a name that doesn't
 * match any stage record key.
 */
export const MSG_MISSING_NAMED_READ = (currentSkill: string, name: string) =>
	`✗ ${currentSkill} reads "${name}" but no upstream produces stage has published it yet — stopping workflow`;
export const ERR_MISSING_NAMED_READ = (currentSkill: string, name: string, stageNumber: number) =>
	`Stage ${stageNumber} (${currentSkill}) reads "${name}" but state.named["${name}"] is empty; check that an upstream produces stage publishes this name`;

export const MSG_BACKWARD_JUMP_EXHAUSTED = (jumps: number, max: number) =>
	`rpiv: backward-jump limit exceeded (${jumps}/${max}) — stopping workflow to prevent infinite loop`;

export const ERR_BACKWARD_JUMP_EXHAUSTED = (jumps: number, max: number) =>
	`Backward-jump limit exceeded: ${jumps} backward jumps (max ${max})`;

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
export const MSG_LOOP_CAP_HALT = (count: number, max: number) =>
	`rpiv: loop cap exceeded (${count}/${max}) — stopping workflow to prevent an unbounded loop`;
export const ERR_LOOP_CAP_HALT = (count: number, max: number) => `Loop cap exceeded: ${count} units (max ${max})`;

/**
 * A loop hit its effective cap under `onCap: "advance"` — soft-stop: warn,
 * land the {type:"loop-cap"} telemetry row, keep the projected result,
 * advance. Deliberately no ERR_ twin (not a failure).
 */
export const MSG_LOOP_CAP_ADVANCE = (skill: string, max: number) =>
	`rpiv: ${skill} loop reached its cap (${max}) — projecting the configured result and advancing`;

export const MSG_AUDIT_WRITE_FAILED = (skill: string) =>
	`✗ ${skill} completed but audit row could not be written — stopping workflow`;
export const ERR_AUDIT_WRITE_FAILED = (skill: string) =>
	`${skill} completed but the JSONL audit row could not be appended; halting to keep in-memory state aligned with disk`;

export const MSG_CHAIN_ADVANCE_FAILED = (fromStage: string, reason: string) =>
	`✗ chain advance after ${fromStage} failed: ${reason} — stopping workflow`;

/**
 * Stage threw before it could record its own audit row — covers
 * `enforceSessionInvariants` violations, session-machinery errors, and any
 * other path that escapes `runStage` directly. Distinguished from
 * `MSG_CHAIN_ADVANCE_FAILED` (which is about an edge throwing AFTER a stage
 * succeeded) — the user needs to see *which* stage failed to start, not
 * which one preceded the failure.
 */
export const MSG_STAGE_THREW = (skill: string, reason: string) =>
	`✗ stage ${skill} failed to start: ${reason} — stopping workflow`;

/**
 * Stage references a Pi skill that isn't registered with the running Pi
 * instance. Surfaced loudly here instead of letting the `/skill:<name>` text
 * leak verbatim into the LLM context — `rpiv-args` is the only expander on
 * the programmatic dispatch path (`expandPromptTemplates: false`), so an
 * unknown skill name would otherwise reach the model as a bare user-message
 * imperative outside the `<skill>...</skill>` contract.
 */
export const MSG_SKILL_NOT_REGISTERED = (skill: string) =>
	`✗ ${skill} is not a registered Pi skill — stopping workflow`;
export const ERR_SKILL_NOT_REGISTERED = (skill: string, stageNumber: number) =>
	`Stage ${stageNumber} requires Pi skill "${skill}" but no skill by that name is registered with Pi (check installed sibling packages and \`pi.skills\` manifest entries)`;

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
 * Script stage's `run()` body threw. Distinct from `MSG_STAGE_THREW`
 * (which covers session-machinery and preflight throws) so users see
 * the failure surface attributed to the script function rather than to
 * the runner.
 */
export const MSG_SCRIPT_THREW = (stage: string, reason: string) =>
	`✗ ${stage} script threw — stopping workflow: ${reason}`;
export const ERR_SCRIPT_THREW = (stage: string, reason: string) => `${stage} script threw: ${reason}`;

// ---------------------------------------------------------------------------
// Resume-refusal messages — reconstruct refusals returned in the
// RunWorkflowResult envelope (the caller notifies; no-JSONL → no machinery row)
// ---------------------------------------------------------------------------

export const ERR_RESUME_NO_ROWS = (runId: string) => `rpiv: run ${runId} has no recorded stages — nothing to resume`;
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

export const MSG_NAME_IGNORED_ON_RESUME =
	"/wf: --name has no effect on @resume (the ref already identifies the run) — ignoring it";

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

/**
 * Legacy `.rpiv-workflow/` overlay directory detected at load time. The
 * package moved project config under the unified `.rpiv/workflows/` tree
 * (config.ts + packs/) alongside run state. The old directory is NO LONGER
 * read — this notice points the user at the new location and the one-line
 * `mv` migration. Emitted as a load WARNING (advisory, non-blocking).
 *
 * The embedded shell is `;`-sequenced (not `&&`-chained) and each move is
 * guarded (`[ -f … ]` for the config, `find … 2>/dev/null` for the packs) so
 * the terminal `rm -rf` ALWAYS runs — a config-only legacy dir (no `workflows/`
 * subdir) no longer halts the chain and re-fires this warning forever.
 */
export const LEGACY_OVERLAY_NOTICE = (cwd: string): string =>
	`rpiv-workflow: detected legacy \`${join(cwd, ".rpiv-workflow")}\` — project config now lives at ` +
	"`.rpiv/workflows/config.ts` + `.rpiv/workflows/packs/` and is the only location read. " +
	"Move it: `mkdir -p .rpiv/workflows/packs; " +
	"[ -f .rpiv-workflow/workflows.config.ts ] && mv .rpiv-workflow/workflows.config.ts .rpiv/workflows/config.ts; " +
	"find .rpiv-workflow/workflows -name '*.ts' -exec mv {} .rpiv/workflows/packs/ \\; 2>/dev/null; " +
	"rm -rf .rpiv-workflow` " +
	"(the old directory is ignored). " +
	"Note: `.rpiv/workflows/` is commonly gitignored (it holds run state), so the moved " +
	"`config.ts` + `packs/` may be silently uncommittable — add `!.rpiv/workflows/config.ts` and " +
	"`!.rpiv/workflows/packs/` to your `.gitignore` to version-control team workflow config.";

/**
 * Orphaned run JSONLs detected directly under `.rpiv/workflows/` at load time.
 * Run state moved one level down into `.rpiv/workflows/runs/`; files written by
 * an older version still sit at the parent and are no longer enumerated by
 * `listRuns` (so `/wf` past-run inspection silently can't see them). Emitted as
 * a load WARNING (advisory, non-blocking) — the files are orphaned, not deleted.
 */
export const LEGACY_RUNS_NOTICE = (cwd: string): string =>
	`rpiv-workflow: detected legacy run files directly under \`${join(cwd, ".rpiv", "workflows")}\` — ` +
	"run state now lives in `.rpiv/workflows/runs/` and these top-level `*.jsonl` files are no longer " +
	"read by `/wf`. Move them: `mkdir -p .rpiv/workflows/runs && mv .rpiv/workflows/*.jsonl .rpiv/workflows/runs/`.";

/**
 * Legacy user-layer config filename (`workflows.config.ts`) detected at load
 * time. The user overlay's inner name was aligned with the project layer
 * (`config.ts`) and is the ONLY name read — a stale `workflows.config.ts` would
 * otherwise silently stop contributing its aliases / default / overlay
 * workflows. Mirrors `LEGACY_OVERLAY_NOTICE` at the user layer. Load WARNING.
 */
export const LEGACY_USER_CONFIG_NOTICE = (dir: string): string =>
	`rpiv-workflow: detected legacy \`${join(dir, "workflows.config.ts")}\` — the user-layer config now lives at ` +
	`\`${join(dir, "config.ts")}\` and is the only name read. ` +
	`Move it: \`mv ${join(dir, "workflows.config.ts")} ${join(dir, "config.ts")}\` (the old name is ignored).`;

/** Pi command registry — displayed by Pi's `/?` / command list. */
export const CMD_DESCRIPTION = "Run a skill workflow: /wf [workflow] [description]";

/** No-args listing footer — generic usage hint. */
export const CMD_USAGE_LIST = "Usage: /wf [workflow] <description>";

/** No-args listing footer — preview-mode hint paired with CMD_USAGE_LIST. */
export const CMD_USAGE_PREVIEW = "/wf <workflow>             — preview stages";

/** Per-workflow details footer — narrowed to the workflow the user previewed. */
export const CMD_USAGE_RUN = (name: string) => `Usage: /wf ${name} <description>`;
