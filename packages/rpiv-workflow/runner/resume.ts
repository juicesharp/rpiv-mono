/**
 * State reconstruction for resuming a run. ONE async fold over the JSONL
 * trail: rows with `parent` set are loop-unit rows (the structured machine
 * channel — the decorated `stage` string is never parsed); everything else
 * folds as a normal stage.
 *
 * THE REPLAY CONTRACT: a loop's unit source must be deterministic w.r.t. the
 * fold-replayed `RunState` at the unit boundary + this generation's
 * accumulated outputs. Because the fold replays rows in trail order, at row
 * *i* the state is byte-identical to what the live driver saw — so the fold
 * verifies EVERY unit row against the recomputed expectation (strictly
 * stronger than the old per-primitive half-guards). Drift (or a generator
 * throw) does not refuse outright: the fold finishes applying so state is
 * complete, and returns `drift` — `resumeWorkflow`'s entry thunk records the
 * terminal failure with full lifecycle bracketing and zero dispatch.
 *
 * Generations: contiguous unit rows sharing a `parent`. A generation opens by
 * freezing the entry pair from the replayed state (and, for fanout,
 * recomputing the unit list ONCE against it); it closes when a non-unit row
 * (or a different parent) appears — `projectResult` (the driver's own
 * function) lands the declared result, exactly like the live loop advance.
 * The TRAILING open generation is returned un-projected as a
 * `LoopResumePoint` whose `cursor` is the driver's own `LoopCursor` —
 * re-entry hands it straight back to `runLoop`.
 */

import type { LoopDef, StageDef, Unit, Workflow } from "../api.js";
import { applyStageSuccess } from "../audit-rows.js";
import { stageEntryArgs } from "../chain-state.js";
import type { Artifact } from "../handle.js";
import { formatError } from "../internal-utils.js";
import { panelMembers } from "../judge.js";
import { projectResult, publishPanelVerdict } from "../loop.js";
import { effectiveLoopOf } from "../loop-constructors.js";
import {
	advanceCursor,
	foldFanoutCompletion,
	freshCursor,
	judgeStageDef,
	type LoopCursor,
	loopStrategyOf,
	unitTagOf,
} from "../loop-kinds.js";
import { ERR_RESUME_LOOP_MISMATCH } from "../messages.js";
import { failedOutput, type Output } from "../output.js";
import {
	readAllStagesForResume,
	STATE_SCHEMA_VERSION,
	type WorkflowHeader,
	type WorkflowStage,
} from "../state/index.js";
import type { RunState } from "../types.js";
import { freshRunState } from "./run-context.js";

/** Trailing open generation — everything `resume-loop.ts` needs to re-enter `runLoop`. */
export interface LoopResumePoint {
	parent: string;
	entryArtifact: Artifact | undefined;
	entryPair: { output: Output | undefined; primaryArtifact: Artifact | undefined };
	/**
	 * Round-0 producer arg, FROZEN at generation open (assess-kind loops only;
	 * `""` otherwise). `undefined` = the trail no longer carries the rows that
	 * published this stage's inputs (truncated/corrupted) — re-entry records a
	 * refusal instead of dispatching with a wrong arg.
	 */
	entryArgs: string | undefined;
	/** The driver's own cursor, reconstructed: next (role, index), accumulated, lastProduce, lastVerdict. */
	cursor: LoopCursor;
	/** Fanout: the recomputed-and-verified unit list (re-entry reuses it — no second compute). */
	units?: readonly Unit[];
}

export type ReconstructResult =
	| {
			ok: true;
			state: RunState;
			lastStageNumber: number;
			/**
			 * 0-based chain index of the trail's LAST activation — the fold's
			 * reconstruction of the `idx` the live chain was at (one activation per
			 * top-level stage row or loop generation; a resume re-run of a failed
			 * stage keeps its index). NOT `stageNumber - 1`: the allocator counts
			 * every row including loop units, so the two diverge past any loop.
			 */
			lastChainIndex: number;
			visited: Set<string>;
			rows: WorkflowStage[];
			/** Open generation at trail end, un-projected (the driver projects at its advance). */
			trailing?: LoopResumePoint;
			/** Guard tripped mid-fold — the resume entry records this as a terminal failure. */
			drift?: { parent: string; errMsg: string };
	  }
	| { ok: false; reason: "no-rows" | "stage-gone" | "malformed-row" | "version-mismatch"; detail: string };

export async function reconstructState(
	cwd: string,
	workflow: Workflow,
	header: WorkflowHeader,
): Promise<ReconstructResult> {
	// Version gate first: the fold replays rows under the CURRENT shapes, so a
	// file written under a different schema version must refuse cleanly rather
	// than mis-replay. Absent `v` = version 1 (pre-field files) — see
	// STATE_SCHEMA_VERSION's back-compat rule.
	const v = header.v ?? 1;
	if (v !== STATE_SCHEMA_VERSION) {
		return { ok: false, reason: "version-mismatch", detail: `run ${header.runId} was written under schema v${v}` };
	}
	// Strict reader: a stage-shaped row failing the deep guard REFUSES here —
	// the fold replays the trail as its system of record, so a silently
	// skipped row would replay a hole and route onward past it.
	const read = readAllStagesForResume(cwd, header.runId);
	if (!read.ok) return { ok: false, reason: "malformed-row", detail: read.detail };
	const rows = read.rows;
	if (rows.length === 0) return { ok: false, reason: "no-rows", detail: header.runId };

	const acc: FoldAcc = {
		cwd,
		runId: header.runId,
		state: freshRunState(header.input),
		visited: new Set<string>(),
		lastStageNumber: 0,
		chainIndex: -1,
		prevNode: undefined,
		gen: undefined,
		drift: undefined,
	};

	for (const row of rows) {
		if (row.parent !== undefined) {
			const refusal = await foldUnitRow(acc, workflow, row);
			if (refusal) return refusal;
			continue;
		}
		closeGeneration(acc);
		const def = workflow.stages[row.stage];
		// Unknown key refuses — including LEGACY decorated rows (older
		// runs carry no `parent`, so their unit rows land here): stage-gone.
		if (!def) return { ok: false, reason: "stage-gone", detail: row.stage };
		noteChainNode(acc, row.stage, row.status !== "completed");
		foldKnownStage(acc, def, row);
	}

	acc.state.lastAllocatedStageNumber = acc.lastStageNumber; // allocator continues monotonically

	return {
		ok: true,
		state: acc.state,
		lastStageNumber: acc.lastStageNumber,
		lastChainIndex: acc.chainIndex,
		visited: acc.visited,
		rows,
		trailing: acc.gen ? toPoint(acc.gen) : undefined,
		drift: acc.drift,
	};
}

// ---------------------------------------------------------------------------
// Fold internals
// ---------------------------------------------------------------------------

interface OpenGeneration {
	parent: string;
	loop: LoopDef;
	/** Parent stage def — produce-row apply (judge rows apply via judgeStageDef). */
	def: StageDef;
	entryArtifact: Artifact | undefined;
	entryPair: { output: Output | undefined; primaryArtifact: Artifact | undefined };
	/** Frozen at generation open — see LoopResumePoint.entryArgs. */
	entryArgs: string | undefined;
	cursor: LoopCursor;
	units?: readonly Unit[];
	/**
	 * Cached expected unit for the cursor's CURRENT index (iterate pulls once
	 * per index — a failed row followed by its resumed re-run row re-checks
	 * the same expectation without double-pulling the generator).
	 */
	expected?: { index: number; tag: string | undefined };
}

interface FoldAcc {
	cwd: string;
	/** Header runId — the rebuilt `failedOutput` sentinel's meta.runId,
	 *  byte-identical to the live `outputMetaFor`'s `s.runId`. RunState carries no id. */
	runId: string;
	state: RunState;
	visited: Set<string>;
	lastStageNumber: number;
	/** 0-based index of the current activation — see `ReconstructResult.lastChainIndex`. */
	chainIndex: number;
	/**
	 * Last chain-node activation. `reentrant` = a following row of the SAME
	 * stage continues this activation instead of opening a new one: a
	 * failed/aborted/skipped row (resume re-runs it at the same index) or a
	 * loop generation (its halt row and any resume re-entry belong to it).
	 */
	prevNode: { stage: string; reentrant: boolean } | undefined;
	gen: OpenGeneration | undefined;
	drift: { parent: string; errMsg: string } | undefined;
}

/** Advance the chain index for one activation — unless the row continues the previous one. */
function noteChainNode(acc: FoldAcc, stage: string, reentrant: boolean): void {
	if (!(acc.prevNode?.stage === stage && acc.prevNode.reentrant)) acc.chainIndex++;
	acc.prevNode = { stage, reentrant };
}

/**
 * Normal-stage fold. A completed row replays through `applyStageSuccess` —
 * the same apply the live success persistence runs, minus the I/O (the row
 * is already on disk).
 */
function foldKnownStage(acc: FoldAcc, def: StageDef, row: WorkflowStage): void {
	acc.visited.add(row.stage);
	acc.lastStageNumber = Math.max(acc.lastStageNumber, row.stageNumber);
	if (row.status !== "completed") return;
	applyStageSuccess(acc.state, def, row.stage, row.output);
	// Roll the predecessor session forward, mirroring the live `recordStageSuccess`
	// single-stage branch — so a post-resume cold dispatch of a `continue` stage
	// forks the same predecessor the live run would have. Single-stage rows only
	// (unit rows fold via `foldUnitRow`, which never touches this slot).
	//
	// GUARD on a real session: the live writer runs ONLY for the skill/prompt
	// single-stage success path (a non-null `SessionRef`). Script stages persist
	// `session: null` via `persistStageSuccess` and never touch `lastSession`, so a
	// `null` row here must LEAVE it untouched — clobbering it to `undefined` would
	// degrade a `continue`-after-script to a fresh dispatch on resume while live
	// forked the predecessor (a replay-parity breach).
	if (row.session !== null) acc.state.lastSession = row.session;
}

/** Close the open generation: project the declared result — the live loop-advance, replayed. */
function closeGeneration(acc: FoldAcc): void {
	if (!acc.gen) return;
	projectResult(acc.gen.loop, acc.gen.entryPair, acc.gen.cursor, acc.state);
	acc.gen = undefined;
}

async function foldUnitRow(
	acc: FoldAcc,
	workflow: Workflow,
	row: WorkflowStage,
): Promise<Extract<ReconstructResult, { ok: false }> | undefined> {
	// New generation: different parent (or first unit row / after a non-unit row).
	if (!acc.gen || acc.gen.parent !== row.parent) {
		closeGeneration(acc);
		const def = workflow.stages[row.parent!];
		// `effectiveLoopOf` — a verify stage's unit rows recover their synthesized
		// loop here; without it every verify-stage trailer would refuse stage-gone.
		const loop = def ? effectiveLoopOf(def) : undefined;
		if (!def || !loop) return { ok: false, reason: "stage-gone", detail: row.stage };
		// One generation = one chain-node activation. Always reentrant: a halt
		// row for the parent or a resumed re-entry continues this activation.
		noteChainNode(acc, row.parent!, true);
		acc.gen = {
			parent: row.parent!,
			loop,
			def,
			entryArtifact: acc.state.primaryArtifact,
			entryPair: { output: acc.state.output, primaryArtifact: acc.state.primaryArtifact },
			// Frozen HERE: replayed state at generation open is byte-identical to
			// what the live driver saw at loop entry (THE REPLAY CONTRACT) — the
			// only safe place to derive the round-0 arg. `reads` projections in
			// particular must NOT be re-derived post-fold, where the generation's
			// own appends have moved the `.at(-1)` cursors.
			entryArgs: loop.kind === "assess" ? stageEntryArgs(def, row.parent!, workflow.start, acc.state) : "",
			cursor: freshCursor(),
			units: undefined,
		};
		if (loop.kind === "fanout") {
			acc.gen.units = await guarded(acc, acc.gen.parent, () =>
				(loop as Extract<LoopDef, { kind: "fanout" }>).units({
					cwd: acc.cwd,
					artifact: acc.state.primaryArtifact,
					state: acc.state,
				}),
			);
		}
	}

	const gen = acc.gen;
	acc.visited.add(gen.parent);
	acc.lastStageNumber = Math.max(acc.lastStageNumber, row.stageNumber);

	if (!acc.drift) await guardRow(acc, gen, row);

	// Fanout: place-by-`unitIndex` (NOT trail order) so declared order survives a
	// completion-ordered / out-of-order trail. A slot is FILLED — and so NOT
	// re-dispatched on resume — only when the row is a COMPLETED unit or a
	// COLLECTED soft-halt:
	//   • completed → `applyStageSuccess` (bookkeeping + state.output, mirroring the
	//     live `recordStageSuccess`) THEN the channel-owning `foldFanoutCompletion`;
	//   • collected (`status:"failed"` + `collected:true`) → rebuild the `failedOutput`
	//     sentinel from `errMsg` and place it via `foldFanoutCompletion` ONLY (the live
	//     `softHaltUnit` runs no `applyStageSuccess` — the fold owns the single channel
	//     write). The rebuilt meta is byte-identical to the live sentinel's (see
	//     `outputMetaFor`): decorated `row.stage`, `row.skill`, `row.stageNumber`.
	// A hard `status:"failed"` row (no `collected`) or a genuinely pending row — and
	// an aborted in-flight unit, which wrote NO row at all — leaves the slot
	// unfilled so resume re-dispatches that unit. `gen.units` is absent only when the
	// units generator threw at open (already drift); fall through to the produce arm's
	// `advanceCursor` so the refused fold still applies bookkeeping.
	if (gen.loop.kind === "fanout" && gen.units) {
		if (row.status === "completed" && row.output) {
			applyStageSuccess(acc.state, gen.def, row.stage, row.output);
			foldFanoutCompletion(acc.state, gen.cursor, gen.def, gen.parent, row.unitIndex!, gen.units.length, row.output);
		} else if (row.collected && row.errMsg !== undefined) {
			const sentinel = failedOutput(
				{ stage: row.stage, skill: row.skill, stageNumber: row.stageNumber, ts: row.ts, runId: acc.runId },
				row.errMsg,
			);
			foldFanoutCompletion(acc.state, gen.cursor, gen.def, gen.parent, row.unitIndex!, gen.units.length, sentinel);
		}
		gen.expected = undefined; // consumed
		return undefined; // pending / hard-failed slots stay unfilled — resume re-dispatches them
	}

	if (row.status !== "completed") return undefined; // pending unit — cursor stays (resume re-runs it)

	if (row.role === "judge" || row.role === "verify") {
		// Apply-then-project: each member verdict rolls the pair TRANSIENTLY
		// (exactly like the live judge unit); projection at generation close
		// restores. The member this row graded is the one the rebuilt sub-state
		// currently points at — `cursor.panel.memberIndex` BEFORE `advanceCursor`
		// bumps it (0 for a single judge, the panel of one). Using that member's
		// own def publishes the verdict to the member's OWN channel, matching the
		// live session path (`judgeStageDef(member)`) per member — `[0]` for every
		// member would have mis-filed members 1..N-1 onto member 0's channel.
		const judgeSlot = (gen.loop as Extract<LoopDef, { kind: "assess" }>).judge;
		const memberIndex = gen.cursor.panel?.memberIndex ?? 0;
		applyStageSuccess(acc.state, judgeStageDef(panelMembers(judgeSlot)[memberIndex]!), row.stage, row.output);
		const role = row.role; // narrowed to "judge" | "verify" — captured for the closure below
		const verdict = row.output;
		if (!verdict) return undefined; // defensive — completed unit rows always carry output
		// `guardRow` already verified `row.unitIndex === cursor.index` (drift
		// otherwise), so the shared transition lands the same cursor the live
		// driver had — and, on the last member, the same folded verdict.
		//
		// `advanceCursor` runs the author fold on the LAST member (`panel.fold`,
		// which a sugar fold's per-member `pred` reaches too), and
		// `publishPanelVerdict` lands it — BOTH behind `guarded()`. A fold/pred
		// throw must become drift (a recorded terminal failure), NOT an unguarded
		// rejection: this fold runs in `reconstructState`, which `resumeWorkflow`
		// awaits BEFORE `executeRun` brackets the lifecycle — an escape here yields
		// no JSONL failure row and no `onWorkflowEnd`. The live driver's same
		// `advanceCursor`+`publishPanelVerdict` pair runs under
		// `runStageOrRecordFailure`'s catch (loop.ts `dispatchUnit`); this is its
		// resume-side error boundary.
		await guarded(acc, gen.parent, () => {
			advanceCursor(gen.cursor, role, verdict, gen.loop);
			// Panel-close publish — the SAME call the live driver makes after the
			// last member's advance, so the folded verdict lands byte-identically.
			publishPanelVerdict(gen.loop, gen.parent, gen.cursor, acc.state);
		});
		return undefined;
	}

	// produce row — iterate units and assess producers (fanout is placed by index
	// above; a fanout row only reaches here when `gen.units` is absent because the
	// units generator threw at open — already drift — so `advanceCursor` keeps the
	// refused fold applying bookkeeping without a `length`-of-undefined).
	applyStageSuccess(acc.state, gen.def, row.stage, row.output);
	if (!row.output) return undefined; // defensive — completed unit rows always carry output
	advanceCursor(gen.cursor, "produce", row.output, gen.loop);
	gen.expected = undefined; // consumed
	return undefined;
}

/**
 * The full-row determinism guard — every unit row is checked against the
 * recomputed expectation at its boundary (the replayed state IS what the live
 * driver saw). The kind-agnostic (role, unitIndex) arithmetic lives here; the
 * per-kind re-check delegates to the strategy table (loop-kinds.ts). Drift
 * marks `acc.drift` and stops guarding; applying continues so the failure can
 * be recorded against complete state.
 */
async function guardRow(acc: FoldAcc, gen: OpenGeneration, row: WorkflowStage): Promise<void> {
	// Fanout no longer asserts trail order: parallel completion + resume re-dispatch
	// produce out-of-order trails, and the fanout cursor tracks `filledCount` (a
	// count, not a trail position), so a sequential `unitIndex === cursor.index`
	// check would falsely drift. The `unitId` is a PLACEMENT key — verify it
	// identifies the unit declared at `row.unitIndex`.
	if (gen.loop.kind === "fanout") {
		const i = row.unitIndex ?? -1;
		const ok = i >= 0 && i < (gen.units?.length ?? 0) && unitTagOf(gen.units![i]!) === row.unitId;
		if (!ok) setDrift(acc, gen.parent);
		return;
	}
	const judgeRole = gen.def.verify ? "verify" : "judge";
	const expectRole = gen.loop.kind === "assess" ? (gen.cursor.phase === "judge" ? judgeRole : "produce") : "produce";
	if (row.role !== expectRole || row.unitIndex !== gen.cursor.index) return setDrift(acc, gen.parent);

	const matches = await guarded(acc, gen.parent, () =>
		loopStrategyOf(gen.loop.kind).guardExpectation(gen, row, acc.cwd, acc.state),
	);
	if (acc.drift) return;
	if (!matches) setDrift(acc, gen.parent);
}

function setDrift(acc: FoldAcc, parent: string): void {
	acc.drift = { parent, errMsg: ERR_RESUME_LOOP_MISMATCH(parent) };
}

/** Run a user fn during the fold; a throw becomes drift with the thrown reason. */
async function guarded<T>(acc: FoldAcc, parent: string, fn: () => T | Promise<T>): Promise<T | undefined> {
	try {
		return await fn();
	} catch (e) {
		acc.drift = { parent, errMsg: formatError(e) };
		return undefined;
	}
}

function toPoint(gen: OpenGeneration): LoopResumePoint {
	return {
		parent: gen.parent,
		entryArtifact: gen.entryArtifact,
		entryPair: gen.entryPair,
		entryArgs: gen.entryArgs,
		cursor: gen.cursor,
		units: gen.units,
	};
}
