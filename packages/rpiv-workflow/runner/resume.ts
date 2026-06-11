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
import { applyCompletedStage, stageEntryArgs } from "../chain-state.js";
import { effectiveLoopOf } from "../control-flow.js";
import type { Artifact } from "../handle.js";
import { formatError } from "../internal-utils.js";
import { advanceCursor, freshCursor, judgeStageDef, type LoopCursor, projectResult, unitTagOf } from "../loop.js";
import { ERR_RESUME_LOOP_MISMATCH } from "../messages.js";
import type { Output } from "../output.js";
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
		// Unknown key refuses — including LEGACY decorated rows (pre-redesign
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

/** Normal-stage fold — unchanged semantics from today. */
function foldKnownStage(acc: FoldAcc, def: StageDef, row: WorkflowStage): void {
	acc.visited.add(row.stage);
	acc.lastStageNumber = Math.max(acc.lastStageNumber, row.stageNumber);
	if (row.status !== "completed") return;
	acc.state.stagesCompleted++;
	if (!row.output) return;
	acc.state.output = row.output;
	applyCompletedStage(acc.state, def, row.stage, row.output);
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

	if (row.status !== "completed") return undefined; // pending unit — cursor stays (resume re-runs it)
	acc.state.stagesCompleted++;
	if (!row.output) return undefined; // defensive — completed unit rows always carry output
	acc.state.output = row.output;

	if (row.role === "judge" || row.role === "verify") {
		// Apply-then-project: the verdict rolls the pair TRANSIENTLY (exactly
		// like the live judge unit); projection at generation close restores.
		// Replaces the old never-apply mirror + manual named push.
		applyCompletedStage(
			acc.state,
			judgeStageDef((gen.loop as Extract<LoopDef, { kind: "assess" }>).judge),
			row.stage,
			row.output,
		);
		// `guardRow` already verified `row.unitIndex === cursor.index` (drift
		// otherwise), so the shared transition lands the same cursor the live
		// driver had.
		advanceCursor(gen.cursor, row.role, row.output, gen.loop.kind);
		return undefined;
	}

	// produce row — fanout/iterate units and assess producers alike
	applyCompletedStage(acc.state, gen.def, row.stage, row.output);
	advanceCursor(gen.cursor, "produce", row.output, gen.loop.kind);
	gen.expected = undefined; // consumed
	return undefined;
}

/**
 * The full-row determinism guard — every unit row is checked against the
 * recomputed expectation at its boundary (the replayed state IS what the live
 * driver saw). Drift marks `acc.drift` and stops guarding; applying continues
 * so the failure can be recorded against complete state.
 */
async function guardRow(acc: FoldAcc, gen: OpenGeneration, row: WorkflowStage): Promise<void> {
	const judgeRole = gen.def.verify ? "verify" : "judge";
	const expectRole = gen.loop.kind === "assess" ? (gen.cursor.phase === "judge" ? judgeRole : "produce") : "produce";
	if (row.role !== expectRole || row.unitIndex !== gen.cursor.index) return setDrift(acc, gen.parent);

	if (gen.loop.kind === "fanout") {
		if (!gen.units || gen.cursor.index >= gen.units.length) return setDrift(acc, gen.parent);
		if (unitTagOf(gen.units[gen.cursor.index]!) !== row.unitId) return setDrift(acc, gen.parent);
		return;
	}

	if (gen.loop.kind === "iterate") {
		if (!gen.expected || gen.expected.index !== gen.cursor.index) {
			const u = await guarded(acc, gen.parent, () =>
				(gen.loop as Extract<LoopDef, { kind: "iterate" }>).next({
					cwd: acc.cwd,
					artifact: gen.entryArtifact,
					state: acc.state,
					accumulated: gen.cursor.accumulated,
					index: gen.cursor.index,
				}),
			);
			if (acc.drift) return;
			gen.expected = { index: gen.cursor.index, tag: u ? unitTagOf(u) : undefined };
		}
		// `tag: undefined` = the generator now terminates here, but a row exists — drift.
		if (gen.expected.tag !== row.unitId) return setDrift(acc, gen.parent);
		return;
	}

	// assess: (role, unitIndex) arithmetic already matched above. Full-check
	// extra: a produce row for round n>0 implies done(verdict n-1) was false
	// on the live run — a now-true done means the predicate drifted.
	if (row.role === "produce" && gen.cursor.lastVerdict !== undefined) {
		const loop = gen.loop as Extract<LoopDef, { kind: "assess" }>;
		const done = await guarded(acc, gen.parent, () => loop.done(gen.cursor.lastVerdict!));
		if (!acc.drift && done) setDrift(acc, gen.parent);
	}
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
