/**
 * Fail-soft JSONL readers. Shape-filtered, never positional — the same
 * file can carry a header, stage rows, and routing rows, and readers
 * pluck whichever rows match their predicate.
 *
 * Per-line parse: each `JSON.parse` runs in its own try/catch — a single
 * truncated trailing line (process killed mid-append, ENOSPC, network
 * FS hiccup) MUST NOT erase prior rows.
 *
 * Public surface:
 *
 *   - Per-row readers (`readLastStage`, `readAllStages`,
 *     `readRoutingDecisions`) — open ONE run's JSONL and project rows
 *     of the matching shape.
 *   - Past-runs API (`readHeader`, `listRuns`, `listArtifacts`) —
 *     header-only or projection-only reads sized for inspect UIs.
 */

import { existsSync, readFileSync } from "node:fs";
import { type Artifact, handleToString } from "../handle.js";
import { formatError } from "../internal-utils.js";
import { stateFilePath } from "./paths.js";
import { enumerateRunIds, readFirstJsonlLine } from "./raw.js";
import type {
	LoopCapRow,
	RoutingDecision,
	RunRecap,
	RunSummary,
	StageStatus,
	WorkflowHeader,
	WorkflowStage,
} from "./state.js";

/**
 * Reads every line, filters by shape (not position). Header has no
 * `stageNumber`; routing rows carry `type: "routing"`; stage rows have
 * `stageNumber: number` and no `type`. Starting at line 0 keeps the first
 * stage row recoverable even if a transient appendHeader failure left the
 * file without its header.
 *
 * Each line's `JSON.parse` runs in its own try/catch — a truncated trailing
 * line (process killed mid-`appendFileSync`, ENOSPC, network FS hiccup)
 * MUST NOT erase prior rows. Malformed lines emit a one-shot warn and are
 * skipped; readers see every well-formed row that landed on disk.
 */
function readJsonlRows<T>(cwd: string, runId: string, match: (row: unknown) => row is T): T[] {
	const rows: T[] = [];
	for (const parsed of readParsedRows(cwd, runId)) {
		if (match(parsed)) rows.push(parsed);
	}
	return rows;
}

/** Every well-formed JSON row, unfiltered — the shared base under `readJsonlRows` + the strict resume reader. */
function readParsedRows(cwd: string, runId: string): unknown[] {
	let lines: string[];
	try {
		const filePath = stateFilePath(cwd, runId);
		if (!existsSync(filePath)) return [];
		const content = readFileSync(filePath, "utf-8").trim();
		if (!content) return [];
		lines = content.split("\n");
	} catch (e) {
		console.warn(`[rpiv-workflow] workflow state: ${formatError(e)}`);
		return [];
	}

	const rows: unknown[] = [];
	for (const line of lines) {
		try {
			rows.push(JSON.parse(line));
		} catch (e) {
			console.warn(`[rpiv-workflow] workflow state: skipping malformed JSONL row — ${formatError(e)}`);
		}
	}
	return rows;
}

const STAGE_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "skipped", "aborted"]);

/**
 * Stage-SHAPED: carries a numeric `stageNumber` (no other row kind does).
 * Pre-filter for the strict resume reader — a stage-shaped row failing the
 * deep `isWorkflowStage` guard is a MALFORMED stage row, not a foreign kind.
 */
const isStageShaped = (row: unknown): row is { stageNumber: number; stage?: unknown } =>
	!!row && typeof (row as { stageNumber?: unknown }).stageNumber === "number";

/**
 * Deep guard for the fields downstream consumers actually depend on —
 * not just "has a stageNumber": `status` must be a member of the enum
 * (the resume fold branches on it), `output.artifacts` must be an array
 * when `output` is present (`applyCompletedStage` indexes it), and a
 * loop-unit row (`parent` set) must carry a numeric `unitIndex` (the
 * resume drift guard compares it).
 */
const isWorkflowStage = (row: unknown): row is WorkflowStage => {
	const r = row as Partial<WorkflowStage> | null;
	if (!r || typeof r.stageNumber !== "number" || typeof r.stage !== "string") return false;
	if (typeof r.status !== "string" || !STAGE_STATUSES.has(r.status)) return false;
	if (r.output !== undefined && !Array.isArray((r.output as { artifacts?: unknown } | null)?.artifacts)) return false;
	if (r.parent !== undefined && typeof r.unitIndex !== "number") return false;
	return true;
};

/**
 * Resume-only `session` guard: the key must be PRESENT and be either `null`
 * (explicit "no session involved") or an object carrying `id: string`.
 * Lives apart from `isWorkflowStage` so DISPLAY readers stay lenient —
 * pre-feature rows (no `session` key) still render in lists/inspect UIs;
 * only the resume fold refuses them (`malformed-row`; the dev remedy is
 * wiping `.rpiv/workflows/runs/` — v1 never shipped).
 */
const hasValidSessionRef = (row: object): boolean => {
	if (!("session" in row)) return false;
	const s = (row as { session: unknown }).session;
	if (s === null) return true;
	return typeof s === "object" && typeof (s as { id?: unknown }).id === "string";
};

const isRoutingDecision = (row: unknown): row is RoutingDecision =>
	!!row && (row as { type?: unknown }).type === "routing";

/** Shape guard for loop-cap telemetry rows. */
const isLoopCapRow = (r: unknown): r is LoopCapRow => (r as { type?: unknown } | undefined)?.type === "loop-cap";

const isWorkflowHeader = (row: unknown): row is WorkflowHeader =>
	!!row &&
	typeof (row as { runId?: unknown }).runId === "string" &&
	typeof (row as { workflow?: unknown }).workflow === "string" &&
	typeof (row as { input?: unknown }).input === "string" &&
	typeof (row as { ts?: unknown }).ts === "string";

// ---------------------------------------------------------------------------
// Per-run readers
// ---------------------------------------------------------------------------

export function readLastStage(cwd: string, runId: string): WorkflowStage | undefined {
	const stages = readJsonlRows(cwd, runId, isWorkflowStage);
	return stages.length ? stages[stages.length - 1] : undefined;
}

export function readAllStages(cwd: string, runId: string): WorkflowStage[] {
	return readJsonlRows(cwd, runId, isWorkflowStage);
}

/**
 * Resume-grade reader: same projection as `readAllStages`, but a row that is
 * stage-SHAPED while failing the deep stage guard REFUSES instead of being
 * skipped. Display readers may shrug off a malformed row; the resume fold
 * replays the trail as its system of record, and silently dropping a row
 * would replay a hole ("this stage never ran") — e.g. route onward past a
 * stage whose failure row lost its `status`.
 */
export function readAllStagesForResume(
	cwd: string,
	runId: string,
): { ok: true; rows: WorkflowStage[] } | { ok: false; detail: string } {
	const rows: WorkflowStage[] = [];
	for (const parsed of readParsedRows(cwd, runId)) {
		if (isWorkflowStage(parsed) && hasValidSessionRef(parsed)) {
			rows.push(parsed);
			continue;
		}
		if (isStageShaped(parsed)) {
			const label = typeof parsed.stage === "string" ? ` ("${parsed.stage}")` : "";
			return { ok: false, detail: `stage row ${parsed.stageNumber}${label} failed the shape guard` };
		}
	}
	return { ok: true, rows };
}

export function readRoutingDecisions(cwd: string, runId: string): RoutingDecision[] {
	return readJsonlRows(cwd, runId, isRoutingDecision);
}

/** All loop-cap telemetry rows for a run, in trail order. */
export function readLoopCaps(cwd: string, runId: string): LoopCapRow[] {
	return readJsonlRows(cwd, runId, isLoopCapRow);
}

export function listArtifacts(
	cwd: string,
	runId: string,
): Array<{ stage: string; skill?: string; artifact: Artifact }> {
	return stagesToArtifacts(readAllStages(cwd, runId));
}

/**
 * The single stage→artifacts iteration, shared by `listArtifacts` and
 * `summarizeRun`'s artifact projection. One entry per artifact in trail order;
 * stages with multi-artifact collectors expand to N entries. Rows without an
 * `output`, or with an empty artifacts list, contribute nothing.
 */
function stagesToArtifacts(stages: WorkflowStage[]): Array<{ stage: string; skill?: string; artifact: Artifact }> {
	const out: Array<{ stage: string; skill?: string; artifact: Artifact }> = [];
	for (const s of stages) {
		const artifacts = s.output?.artifacts;
		if (!artifacts) continue;
		for (const artifact of artifacts) out.push({ stage: s.stage, skill: s.skill, artifact });
	}
	return out;
}

/**
 * On-disk `StageStatus` → recap outcome. The lone translation is
 * `"skipped"`→`"cancelled"`: `"skipped"` is the FROZEN on-disk marker a
 * `recordCancellation` row carries (see `StageStatus`), while the recap reads
 * the canonical in-memory outcome. The other three statuses pass through
 * unchanged. Frozen + exhaustive over `StageStatus`, so a new status breaks
 * the record at compile time.
 *
 * Applied AFTER the `collected:true` filter — `recapOutcomeOf` checks that
 * marker first and short-circuits to `"completed"` (see its doc).
 */
const STAGE_TO_RECAP_OUTCOME: Readonly<Record<StageStatus, RunRecap["outcome"]>> = {
	completed: "completed",
	failed: "failed",
	skipped: "cancelled",
	aborted: "aborted",
};

/**
 * Terminal outcome for the LAST stage row of a run. A `collected:true` marker
 * distinguishes a NON-terminal collect-all fanout unit halt: the run survived
 * the halted unit (its output was rebuilt into a `failedOutput` sentinel), so
 * the recap reads `"completed"` rather than the halted unit's on-disk terminal
 * status. Every other row falls through to `STAGE_TO_RECAP_OUTCOME`.
 */
function recapOutcomeOf(last: WorkflowStage): RunRecap["outcome"] {
	if (last.collected === true) return "completed";
	return STAGE_TO_RECAP_OUTCOME[last.status];
}

/**
 * The trail's routed-stop terminator, when present: the LAST well-formed row is
 * a `RoutingDecision` with `decision: "stop"` (the literal mirrors routing-dsl's
 * `STOP` — not imported so state/ stays a leaf). Only a routed stop leaves the
 * routing row as the trail's tail: static string edges never audit, a natural
 * chain end appends its terminal stage row after any routing row, and a resume
 * appends new stage rows behind a prior stop. Fail-soft via `readParsedRows`.
 */
function trailingRoutingStop(cwd: string, runId: string): RoutingDecision | undefined {
	const rows = readParsedRows(cwd, runId);
	const last = rows[rows.length - 1];
	return isRoutingDecision(last) && last.decision === "stop" ? last : undefined;
}

/**
 * Terminal-state projection of one run's JSONL trail — the post-mortem recap a lane
 * renders on end-of-run. Returns `undefined` when no stage row exists (no terminal row
 * ⇒ outcome unrecoverable from the trail). `failureReason` is set only for a
 * non-completed outcome with a present `last.errMsg`, so a collected halt's errMsg
 * never leaks into a completed recap. Fail-soft by inheritance — never throws.
 *
 * A run whose trail ENDS with a routed `stop` (see `trailingRoutingStop`) is
 * refined from `"completed"` to `"stopped"`: the runner reports a gate-routed
 * stop as ordinary completion, but a stop-on-fail gate firing before the
 * chain's natural end is not a success reading. The reason is the stopping
 * edge's persisted `note` when it attached one (`gate`/`match` no-match
 * diagnostics, `setRouteNote` on bespoke gates), else the bare stage name — a
 * note-less trail still names WHERE the run stopped. The refinement only
 * applies over a completed last stage row: a failed/aborted/cancelled tail
 * keeps its own outcome + errMsg (and by write order such a tail follows any
 * routing row anyway).
 */
export function summarizeRun(cwd: string, runId: string): RunRecap | undefined {
	const stages = readAllStages(cwd, runId);
	if (stages.length === 0) return undefined;
	const last = stages[stages.length - 1];
	const outcome = recapOutcomeOf(last);
	const header = readHeader(cwd, runId);
	const recap: RunRecap = {
		outcome,
		artifacts: stagesToArtifacts(stages).map(({ artifact }) => handleToString(artifact.handle)),
		workflow: header?.workflow,
	};
	if (outcome !== "completed" && last.errMsg !== undefined) recap.failureReason = last.errMsg;
	if (outcome === "completed") {
		const stop = trailingRoutingStop(cwd, runId);
		if (stop) {
			recap.outcome = "stopped";
			recap.failureReason =
				stop.note !== undefined ? `stopped at ${stop.fromStage}: ${stop.note}` : `stopped at ${stop.fromStage}`;
		}
	}
	return recap;
}

// ---------------------------------------------------------------------------
// Past-runs enumeration (header-only)
// ---------------------------------------------------------------------------

/**
 * Read only the first JSONL line (a BOUNDED prefix read via
 * `readFirstJsonlLine` — the file's stage rows are never loaded) and parse
 * it as a `WorkflowHeader`. Used by `listRuns` so enumerating N past runs
 * costs N small reads. Returns undefined when the file is missing, empty,
 * or the first line doesn't match the header shape.
 *
 * Fail-soft like every other reader — never throws.
 *
 * Takes a concrete `runId`. For a user-supplied reference that may later need
 * symbolic resolution (`@latest`, relative), call `resolveRun` (resolve.ts)
 * instead.
 */
export function readHeader(cwd: string, runId: string): WorkflowHeader | undefined {
	const parsed = readFirstJsonlLine(cwd, runId);
	return parsed !== undefined && isWorkflowHeader(parsed) ? parsed : undefined;
}

/**
 * Enumerate every `<cwd>/.rpiv/workflows/runs/<run-id>.jsonl` and return its
 * header projected as a `RunSummary`. Empty array when the runs
 * directory doesn't exist (no runs yet). Files without a valid header
 * are skipped silently (corrupt / mid-write).
 *
 * Header-only reads — full stage rows aren't parsed (see `readHeader`'s
 * doc). Past-runs UIs page through the summary; opening a specific run
 * for inspection still calls `readAllStages` / `listArtifacts`.
 *
 * Sort is filesystem-order — callers that want chronological order can
 * sort by `ts` (run-id slug already encodes time, so a string sort on
 * `runId` is monotonic for runs created on the same host).
 */
export function listRuns(cwd: string): RunSummary[] {
	const summaries: RunSummary[] = [];
	for (const runId of enumerateRunIds(cwd)) {
		const header = readHeader(cwd, runId);
		if (header)
			summaries.push({
				runId: header.runId,
				workflow: header.workflow,
				input: header.input,
				ts: header.ts,
				trigger: header.trigger,
				name: header.name,
			});
	}
	return summaries;
}
