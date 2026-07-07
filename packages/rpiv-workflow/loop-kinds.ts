/**
 * loop-kinds.ts — the per-loop-kind vocabulary and strategy table.
 *
 * Everything that varies BY KIND across the loop machinery lives here, in one
 * `Record<LoopDef["kind"], LoopKindStrategy>`. The contract is split by
 * parallelizability: the base `LoopKindStrategy` carries only `parallelizable`,
 * and the SEQUENTIAL kinds (iterate/assess) add — via `SequentialStrategy` —
 * the three methods only their path reaches:
 *   - `pull`             — the live driver's next-step rule (loop.ts `step`);
 *   - `guardExpectation` — the resume fold's per-row determinism re-check
 *                          (runner/resume.ts `guardRow`);
 *   - `hasPending`       — the resume re-entry announce probe
 *                          (runner/resume-loop.ts).
 * Fanout (parallelizable) implements NONE of those — its live entry, resume
 * re-dispatch, and pending probe are index-addressed and reached first; the
 * sequential callers go through `sequentialStrategyOf`. A new loop kind extends
 * the `LoopDef` union and this table — the `Record`/`satisfies` shape makes a
 * missing strategy a compile error — and touches nothing else: dispatch,
 * persistence, cap policy, projection, and completion are kind-agnostic in loop.ts.
 *
 * Also home to the kind-agnostic cursor vocabulary the live driver and the
 * fold share: `LoopCursor`, `advanceCursor` (THE cursor state machine),
 * `unitTagOf`, `judgeStageDef`, `LoopEntry`, `NextStep`.
 */

import type { AssessLoop, IterateLoop, LoopDef, StageDef, Unit, UnitRole } from "./api.js";
import { decorateStage, runIdentityOf } from "./audit.js";
// Fanout completion is INDEX-ADDRESSED (place-by-unitIndex), the
// shared authority for the live parallel fold AND the resume fold so the two
// reconstruct byte-identical declared-order state regardless of
// completion/resume order. iterate/assess keep advanceCursor (sequential).
import { placeFanoutOutput, resolveStagePrompt } from "./chain-state.js";
import { type Artifact, handleToString } from "./handle.js";
import { isPanel, type Judge, type PanelJudge, panelMembers, resolveJudgePrompt } from "./judge.js";
import { MSG_LOOP_CURSOR_CORRUPT } from "./messages.js";
import { finalizeOutput, isFailedOutput, type Output, type OutputMeta } from "./output.js";
import { invariantPreflight } from "./stage-errors.js";
import type { RunContext, RunState, StageSession, UnitRef, WorkflowHostContext } from "./types.js";

// ---------------------------------------------------------------------------
// Cursor + entry vocabulary (kind-agnostic, shared live + fold)
// ---------------------------------------------------------------------------

/**
 * Frozen per-invocation loop identity, built by the caller (`runLoopStage`
 * live; `resume-loop` on resume). `entryArtifact`/`entryArgs`/`entryPair`
 * are captured BEFORE unit 1 and never change.
 */
export interface LoopEntry {
	stageIdx: number;
	/** Loop stage record key (routing + row `parent` + event refs). */
	name: string;
	/** Parent stage's resolved skill body (produce units dispatch it). */
	skill: string;
	/** Parent stage def — produce units run with its knobs. */
	def: StageDef;
	loop: LoopDef;
	/** Stage-entry primary, FROZEN (IterateContext.artifact / JudgeContext.entryArtifact). */
	entryArtifact: Artifact | undefined;
	/**
	 * Round-0 producer arg (assess) — precomputed via `inputForStage`. `""` for
	 * a prompt-dispatch stage (its round-0 message is the stage's own resolved
	 * `prompt`, re-resolved at dispatch time — never frozen here).
	 */
	entryArgs: string;
	/** {output, primaryArtifact} captured at loop entry — the "entry" projection. */
	entryPair: { output: Output | undefined; primaryArtifact: Artifact | undefined };
	/** Precomputed unit list — fanout only (computed by runLoopStage / verified by the resume fold). */
	units?: readonly Unit[];
}

/**
 * Assemble a `LoopEntry` from its stage identity + the frozen per-invocation
 * inputs. THE single construction site for both the live entry (`runLoopStage`,
 * which derives the frozen inputs from current `RunState`) and the resume
 * re-entry (`resumeLoopStage`, which replays them off the `LoopResumePoint`) —
 * so a new `LoopEntry` field is added once here instead of being rebuilt by hand
 * in both. The two paths legitimately differ ONLY in how they obtain `frozen`
 * (compute vs replay); the envelope shape is shared.
 */
export function buildLoopEntry(
	id: Pick<LoopEntry, "stageIdx" | "name" | "skill" | "def" | "loop">,
	frozen: Pick<LoopEntry, "entryArtifact" | "entryArgs" | "entryPair" | "units">,
): LoopEntry {
	return { ...id, ...frozen };
}

/**
 * The dependency-injection contract every loop driver runs against — the engine
 * primitives (`runner/run-stage.ts` `buildLoopDeps`) handed to the sequential
 * (`loop.ts`), parallel (`loop-parallel.ts`), and resume (`runner/resume-loop.ts`)
 * paths so none of them imports the engine back (cycle-free). Homed HERE beside
 * `LoopEntry` — the type it references — so it is a leaf shared by all consumers
 * with no module owning a back-edge to declare it.
 */
export interface LoopDeps {
	/** Dispatch one unit through the standard stage-session path. */
	runStageSession: (ctx: WorkflowHostContext, s: StageSession) => Promise<void>;
	/**
	 * Resume the chain after the loop finishes — receives the loop node's REAL
	 * name. `Promise<unknown>` so the walk's `ChainOutcome`-returning composed
	 * advance plugs in directly (the driver only awaits settlement).
	 */
	advanceAfter: (
		curCtx: WorkflowHostContext,
		completedName: string,
		completedIdx: number,
		run: RunContext,
	) => Promise<unknown>;
	/** Re-capture the outcome's pre-stage snapshot per unit (ctx + stage name for the fail-soft warning). */
	captureSnapshot: (
		curCtx: WorkflowHostContext,
		stageName: string,
		def: StageDef,
		idx: number,
		run: RunContext,
	) => Promise<unknown>;
	/** Record the terminal failure when `onCap: "halt"` trips — verify-worded for verify stages. */
	haltLoop: (
		curCtx: WorkflowHostContext,
		run: RunContext,
		e: Pick<LoopEntry, "name" | "def">,
		count: number,
		cap: number,
	) => Promise<void>;
	/** Record a mid-flight run abort at the loop seam (FAIL_WORKFLOW_ABORTED).
	 *  Keeps the drivers free of engine imports; wired to `recordAbortedAtSeam`. */
	recordAborted: (curCtx: WorkflowHostContext, name: string, run: RunContext) => Promise<void>;
	/** Funnel an UNEXPECTED worker rejection (not a workflow halt) to a
	 *  terminal-failure row + onStageError, terminating state WITHOUT re-throwing,
	 *  so entry() resolves and onWorkflowEnd still fires. Wraps recordEntryThrow.
	 *  The unit's identity (`unit` + its `skill`) lands as STRUCTURED row fields —
	 *  the row's `stage` stays the parent graph identity. */
	recordWorkerThrow: (
		curCtx: WorkflowHostContext,
		unit: UnitRef,
		skill: string,
		run: RunContext,
		err: unknown,
	) => Promise<void>;
}

/** Mutable generation cursor threaded through the continuation self-calls. */
export interface LoopCursor {
	/** 0-based index of the NEXT unit (== the round for assess). */
	index: number;
	/** This generation's completed produce Outputs, in order (the iterate pull prefix). */
	accumulated: Output[];
	/** Last completed produce unit's pair — "last" projection + judge input. */
	lastProduce?: { output: Output; artifact: Artifact | undefined };
	/** Last judge verdict — feedForward input + done fast-path. */
	lastVerdict?: Output;
	/** Which assess sub-step is next ("produce" for non-assess loops). */
	phase: "produce" | "judge";
	/**
	 * Mid-flight panel sub-state — present ONLY while a multi-member judge phase
	 * is in progress (a single judge never sets it; a panel clears it the moment
	 * its last member folds). `memberIndex` is the NEXT member to dispatch;
	 * `verdicts` accumulates the graded member Outputs the fold reduces. Both the
	 * live driver and the resume fold rebuild it through `advanceCursor`, so the
	 * two paths fold byte-identically (THE REPLAY CONTRACT).
	 */
	panel?: { memberIndex: number; verdicts: Output[] };
	/** Units dispatched by THIS driver invocation — the resume silence rule. */
	ranThisInvocation: number;
	/** Fanout only — declared-index slot array (length = units.length). A unit's
	 *  output lands at slots[unitIndex]; `undefined` = still pending. */
	slots?: (Output | undefined)[];
	/** Fanout only — count of filled slots (completion bookkeeping), derived from
	 *  `slots` by `foldFanoutCompletion`. Distinct from `index` (the next-unit
	 *  pointer): parallel completion fills slots out of order, so this count is NOT
	 *  a position. `undefined` until the first unit folds. */
	filledCount?: number;
}

/** Pristine cursor for a live (non-resume) loop entry. */
export function freshCursor(): LoopCursor {
	return { index: 0, accumulated: [], phase: "produce", ranThisInvocation: 0 };
}

/** Stable unit identity — `row.unitId`, the display tag, and the resume guard's join key. */
export const unitTagOf = (u: Unit): string => u.id ?? u.label;

/**
 * THE cursor state machine — the ONE place a completed unit's output advances
 * a `LoopCursor`. Shared by the live driver (`dispatchUnit.onSuccess`) and the
 * resume fold (`foldUnitRow`); THE REPLAY CONTRACT requires the two paths to
 * advance byte-identically, so neither may hand-roll the transition again.
 * `ranThisInvocation` is deliberately NOT advanced here: it is live-dispatch
 * accounting (the resume silence rule), not replayed state.
 *
 * Takes the whole `LoopDef` (not just its `kind`) so the judge arm can read the
 * assess loop's judge SLOT: a single judge sets `lastVerdict` directly (today's
 * transition, byte-for-byte); a panel accumulates each member verdict and, on
 * the LAST member, folds the N verdicts into the one decision the produce phase
 * reads. The fold + `finalizeOutput` are pure, so live and resume — both of which
 * call this from the durable member rows — manufacture an identical verdict.
 */
export function advanceCursor(cursor: LoopCursor, role: UnitRole, output: Output, loop: LoopDef): void {
	if (role === "produce") {
		advanceProduce(cursor, output, loop);
		return;
	}
	advanceJudge(cursor, output, loop);
}

/**
 * Produce arm of `advanceCursor`. A failed sentinel advances the index but is
 * NOT the "last" produce, so `result:"last"` projects the last SUCCESSFUL
 * output. DEFENSIVE only: ALL fanout (the sole producer of `failedOutput`)
 * routes through `foldFanoutCompletion`, never `advanceCursor`, at every
 * concurrency including 1 and on both live + resume; iterate/assess (which DO
 * use advanceCursor) never collect-all. Keeps a future collect-all iterate kind
 * from silently corrupting `lastProduce`.
 */
function advanceProduce(cursor: LoopCursor, output: Output, loop: LoopDef): void {
	cursor.accumulated.push(output);
	if (!isFailedOutput(output)) cursor.lastProduce = { output, artifact: output.artifacts[0] };
	if (loop.kind === "assess") cursor.phase = "judge";
	else cursor.index++;
}

/** Judge/verify arm of `advanceCursor` — assess loops only (the only kind with a judge phase). */
function advanceJudge(cursor: LoopCursor, output: Output, loop: LoopDef): void {
	const slot = (loop as AssessLoop).judge;
	if (isPanel(slot)) {
		const verdicts = cursor.panel?.verdicts ?? [];
		verdicts.push(output);
		const memberIndex = cursor.panel?.memberIndex ?? 0;
		if (memberIndex + 1 < slot.members.length) {
			advancePanelMember(cursor, verdicts, memberIndex);
			return;
		}
		foldPanelClose(cursor, slot, verdicts, output);
	} else {
		cursor.lastVerdict = output;
	}
	cursor.phase = "produce";
	cursor.index++;
}

/** More members to grade — stay in the judge phase, advance the member, keep the round (`index`) + `lastVerdict` untouched. */
function advancePanelMember(cursor: LoopCursor, verdicts: Output[], memberIndex: number): void {
	cursor.panel = { memberIndex: memberIndex + 1, verdicts };
}

/**
 * Last panel member — fold the N verdicts to the panel's decision (pure) and
 * clear the sub-state. The folded verdict is what the produce phase's `done`
 * reads, exactly where a single judge's verdict would sit.
 */
function foldPanelClose(cursor: LoopCursor, slot: PanelJudge, verdicts: readonly Output[], output: Output): void {
	cursor.lastVerdict = foldPanelVerdict(slot, verdicts, output.meta);
	cursor.panel = undefined;
}

/** Manufactured `Output.kind` for a panel's folded verdict — data-only, no artifact. */
const PANEL_VERDICT_KIND = "panel-verdict";

/**
 * Reduce a panel's N member verdicts to the single decision the produce phase
 * reads. PURE (the author fold + `finalizeOutput` are pure) and DETERMINISTIC:
 * reusing the last member's `meta` keeps the manufactured verdict byte-identical
 * across live + resume (the member rows are the durable, replayed trail; a fresh
 * `nowIso()` would break the replay contract). The folded Output carries NO
 * artifact — it is routable decision DATA, not a file the loop projects (the
 * fold publishes data, member reasoning lives on member channels).
 */
function foldPanelVerdict(panel: PanelJudge, verdicts: readonly Output[], meta: OutputMeta): Output {
	return finalizeOutput({ kind: PANEL_VERDICT_KIND, artifacts: [], data: panel.fold(verdicts) }, meta);
}

/**
 * Defensive read of `cursor.lastProduce` for cursor states that PROVE a
 * completed produce precedes them (`phase === "judge"`, or `lastVerdict` set —
 * both only reachable through `advanceCursor`, which assigns `lastProduce`
 * first). The resume fold's deep shape guards (`readAllStagesForResume`,
 * `guardRow`) refuse corrupted trails before they can rebuild such a cursor,
 * so a miss here is an internal bug — surfaced as the runner's typed
 * preflight error (stage-attributed JSONL row) instead of a bare `TypeError`.
 */
function lastProduceOf(cursor: LoopCursor, stage: string): NonNullable<LoopCursor["lastProduce"]> {
	const lp = cursor.lastProduce;
	if (!lp) {
		const msg = MSG_LOOP_CURSOR_CORRUPT(stage, "no completed produce on the cursor");
		throw invariantPreflight(stage, msg);
	}
	return lp;
}

/**
 * Synthetic `produces` def a judge unit runs on: the verdict is validated +
 * published by `judge.outcome`; `sessionPolicy: "fresh"` so it never replays
 * the producer's branch. Parent validation knobs are DELIBERATELY not copied
 * (judge sessions use framework defaults; a skill judge still picks up its
 * own declared contract via `effectiveOutputSchema`). The ONE construction
 * site — the resume fold reuses it for verdict publishing.
 */
export function judgeStageDef(judge: Judge): StageDef {
	return { kind: "produces", outcome: judge.outcome, sessionPolicy: "fresh" };
}

/**
 * Judge-unit display label + identity tag. A single judge keeps the bare
 * `r{round}·judge` / `a{round}·verify` form (its identity is `(role, round)`, no
 * `unitId`); a panel member appends `#{memberIndex}` so each member row is
 * identity-bearing — the `(round, memberIndex)` key the resume drift join reads
 * to tell members of the same round apart. The ONE construction site for both
 * the live dispatch tag and the resume guard's expectation, so they can't drift.
 */
export function judgeUnitLabel(round: number, isVerify: boolean, memberIndex: number | undefined): string {
	const base = isVerify ? `a${round}·verify` : `r${round}·judge`;
	return memberIndex === undefined ? base : `${base}#${memberIndex}`;
}

/**
 * The kind a loop PRESENTS to listeners and wording — `"verify"` for a
 * verify-bearing stage (the author declared a post-condition, not a loop),
 * the loop's own kind otherwise. Derived from the parent def, never from the
 * loop object (the verify synthesis carries no marker), so live and resume
 * can't disagree about flavoring.
 */
export const presentedKindOf = (def: StageDef, loop: LoopDef): "verify" | LoopDef["kind"] =>
	def.verify ? "verify" : loop.kind;

// ---------------------------------------------------------------------------
// Strategy table
// ---------------------------------------------------------------------------

/** What the driver does next — produced by a strategy's `pull`. */
export type NextStep =
	| { kind: "complete" }
	| { kind: "cap"; count: number }
	| {
			kind: "unit";
			role: UnitRole;
			/** Display + identity tag (`unitId` for fanout/iterate; `r{n}·{phase}` display-only for assess). */
			tag: string;
			id?: string;
			label: string;
			skill: string;
			prompt: string;
			def: StageDef;
	  };

/**
 * The slice of the fold's open generation a guard strategy reads — the
 * fold's `OpenGeneration` satisfies it structurally. `expected` is the
 * iterate strategy's pull-once-per-index cache (a failed row followed by its
 * resumed re-run row re-checks the same expectation without double-pulling
 * the generator); the strategy owns the field. `memberIndex` extends the join
 * key to `(index, memberIndex)` for assess panels — within one round all member
 * rows share `index`, so the member dimension is what tells them apart.
 */
export interface GenerationGuardCtx {
	loop: LoopDef;
	entryArtifact: Artifact | undefined;
	cursor: LoopCursor;
	units?: readonly Unit[];
	expected?: { index: number; memberIndex?: number; tag: string | undefined };
}

/** The unit-row facts a guard strategy compares against (a `WorkflowStage` row satisfies it). */
export interface UnitRowFacts {
	role?: UnitRole;
	unitId?: string;
}

/** The resume point facts the announce probe reads (a `LoopResumePoint` satisfies it). */
export interface ResumeProbe {
	cursor: LoopCursor;
	entryArtifact: Artifact | undefined;
	units?: readonly Unit[];
}

/**
 * The kind-invariant constants every loop strategy carries. Parallelizable
 * kinds (fanout) implement ONLY this — their live entry, resume re-dispatch,
 * and pending probe are all index-addressed (`runFanoutParallel` /
 * `runFanoutResume` / `pendingFanoutIndices`), reached BEFORE any sequential
 * method. The `SequentialStrategy` methods below are reached only on the
 * non-parallelizable path, so giving fanout dead stubs for them "to keep the
 * Record total" was an LSP/ISP smell — the split deletes the stubs and lets the
 * compiler refuse `pull`/`guardExpectation`/`hasPending` on a parallel kind.
 */
export interface LoopKindStrategy {
	/** Whether this kind's units are mutually independent and may be dispatched
	 *  in bounded parallel (fanout only — iterate/assess consume the prior). When
	 *  true, the kind routes through the index-addressed parallel path and NONE of
	 *  the `SequentialStrategy` methods apply. */
	parallelizable: boolean;
}

/**
 * The sequential (one-unit-per-pull) loop kinds — iterate and assess. They own
 * the live next-step rule, the resume determinism re-check, and the resume
 * announce probe; all three are entered only after fanout has routed to the
 * parallel dispatcher (`step`, `guardRow`, and the announce all narrow fanout
 * away first), so they live on this narrower contract, not on the base.
 */
export interface SequentialStrategy extends LoopKindStrategy {
	parallelizable: false;
	/**
	 * The live driver's next-step rule. Cap-check positions preserve pinned
	 * semantics: iterate checks POST-pull (the null terminator wins; the
	 * generator gets one extra discarded call), assess checks pre-round. For
	 * assess, a `done` verdict wins over the cap (a done loop is a normal
	 * completion, never a cap event).
	 */
	pull(e: LoopEntry, cursor: LoopCursor, cap: number, run: RunContext): Promise<NextStep>;
	/**
	 * The resume fold's per-row determinism re-check, AFTER the kind-agnostic
	 * (role, unitIndex) arithmetic matched. Returns false on drift. May invoke
	 * user fns — a throw becomes drift in the caller (`guarded`).
	 */
	guardExpectation(gen: GenerationGuardCtx, row: UnitRowFacts, cwd: string, state: RunState): Promise<boolean>;
	/**
	 * Resume re-entry pending-work probe — never dispatches; gates the
	 * announce only. The iterate arm re-pulls `next()` at the cursor (the
	 * driver pulls the same index again right after) — the harmless
	 * double-pull is safe because the resume contract requires generators to
	 * be deterministic.
	 */
	hasPending(loop: LoopDef, probe: ResumeProbe, run: RunContext): Promise<boolean>;
}

/** Place a fanout unit's output at its DECLARED index in both the cursor and the
 *  named channel. `cursor.filledCount` becomes the filled-slot count (completion);
 *  `cursor.index` is left untouched — it stays the next-unit pointer. `lastProduce`
 *  is the highest-index non-failed slot (deterministic — order-free, so live +
 *  resume + re-dispatch agree). */
export function foldFanoutCompletion(
	state: RunState,
	cursor: LoopCursor,
	def: StageDef,
	stageName: string,
	index: number,
	total: number,
	output: Output,
): void {
	if (!cursor.slots) cursor.slots = new Array<Output | undefined>(total);
	cursor.slots[index] = output;
	cursor.filledCount = cursor.slots.reduce<number>((n, s) => (s !== undefined ? n + 1 : n), 0);
	cursor.lastProduce = lastNonFailedSlot(cursor.slots);
	placeFanoutOutput(state, def, stageName, index, total, output);
}

/** Highest-index non-failed slot — the deterministic `result:"last"` source. */
function lastNonFailedSlot(slots: readonly (Output | undefined)[]): LoopCursor["lastProduce"] {
	for (let i = slots.length - 1; i >= 0; i--) {
		const o = slots[i];
		if (o && !isFailedOutput(o)) return { output: o, artifact: o.artifacts[0] };
	}
	return undefined;
}

/** THE fanout fail-fast narrow — `true` when a fanout loop opted out of the
 *  default collect-all via `fanout({ failFast: true })`. The ONE spelling of the
 *  kind+field guard the dispatcher (sibling-cancel) and `buildUnitSession`
 *  (`collectAll`) both read, so the narrow can't drift across its read sites. */
export const isFailFast = (loop: LoopDef): boolean => loop.kind === "fanout" && loop.failFast === true;

/** fanout units collect-all by default (opt out via fanout({ failFast: true }));
 *  the `kind === "fanout"` guard is LOAD-BEARING: iterate/assess units MUST NOT
 *  collect-all — they advance the cursor (advanceCursor), so a soft-halt sentinel
 *  would land in `accumulated` AND diverge live/resume (the resume fold skips the
 *  collected:true row). See `advanceProduce`'s defensive invariant. */
const shouldCollectAll = (loop: LoopDef): boolean => loop.kind === "fanout" && !isFailFast(loop);

/** Only fan-out units become individually-addressable lane sub-rows. A
 *  sequential loop unit (iterate/assess) leaves this undefined, so the host keys
 *  its live session on the single-unit slot — the lane (parent) row keeps showing
 *  it, exactly as the pre-change single slot did. `index` is the unit's declared
 *  fan-out index (the same value `unit.index` carries). */
const laneIndexFor = (loop: LoopDef, index: number): number | undefined => (loop.kind === "fanout" ? index : undefined);

/** Factored unit StageSession — shared by the sequential `dispatchUnit` (loop.ts)
 *  and the parallel `dispatchUnitDetached` (loop-parallel.ts); differs only in
 *  `onSuccess` and the threaded `signal`. Populates the per-child execution
 *  controls (lane/model/signal). The sequential path passes `run.signal`
 *  (run-level abort only); the detached path passes the per-generation
 *  `genAbort.signal` (run-level abort OR fail-fast sibling cancel). */
export function buildUnitSession(
	e: LoopEntry,
	u: Extract<NextStep, { kind: "unit" }>,
	index: number,
	run: RunContext,
	snapshot: unknown,
	signal: AbortSignal | undefined,
	onSuccess: StageSession["onSuccess"],
): StageSession {
	return {
		cwd: run.cwd,
		runId: run.runId,
		state: run.state,
		prompt: u.prompt,
		stageName: decorateStage(e.name, u.tag), // DISPLAY only — machine identity is `unit`
		skill: u.skill,
		lifecycle: run.lifecycle,
		runIdentity: runIdentityOf(run),
		stage: u.def,
		skillContracts: run.skillContracts,
		stageIndex: e.stageIdx,
		snapshot,
		branchOffset: undefined,
		unit: { parent: e.name, role: u.role, index, id: u.id, label: u.label },
		model: run.resolveModel?.({ stage: e.name, skill: u.skill }),
		signal,
		collectAll: shouldCollectAll(e.loop),
		laneUnitIndex: laneIndexFor(e.loop, index),
		onFailure: undefined,
		onSuccess,
	};
}

/** The fanout unit descriptor at `index` — the shape the parallel dispatcher builds.
 *  `promptSuffix` is the resolved dep-artifact injection (`depArtifactSuffix`), appended
 *  to the unit prompt; "" for a deps-free unit or a fanout with no `depArtifactFlag`. */
export function fanoutUnitAt(e: LoopEntry, index: number, promptSuffix = ""): Extract<NextStep, { kind: "unit" }> {
	const u = e.units![index]!;
	const tag = unitTagOf(u);
	return {
		kind: "unit",
		role: "produce",
		tag,
		id: tag,
		label: u.label,
		skill: e.skill,
		// `promptSuffix` is produced by `depArtifactSuffix` (loop-parallel.ts:187) and
		// appends `<depArtifactFlag> <dep-artifact-path>` for a deps-bearing fanout unit
		// ("" otherwise). The flag itself is double-gated upstream: `checkedDepArtifactFlag`
		// at construction (loop-constructors.ts:293) and `loop-dep-flag-invalid` at load
		// (validate/stage-rules.ts:85, defined validate/issue.ts:121).
		prompt: `/skill:${e.skill} ${u.prompt}${promptSuffix}`,
		def: e.def,
	};
}

// Fanout carries ONLY `parallelizable`: its live entry (`runFanoutParallel`),
// resume re-dispatch (`runFanoutResume`), and pending probe
// (`pendingFanoutIndices`) are all index-addressed and reached before any
// sequential method — `step`/`guardRow`/the resume announce each route fanout to
// the parallel path first. The former `pull`/`guardExpectation`/`hasPending`
// stubs were dead at runtime; they're gone with the interface split.
const fanoutStrategy: LoopKindStrategy = {
	parallelizable: true,
};

const iterateStrategy: SequentialStrategy = {
	parallelizable: false,
	async pull(e, cursor, cap, run) {
		const loop = e.loop as IterateLoop;
		const u = await loop.next({
			cwd: run.cwd,
			artifact: e.entryArtifact,
			state: run.state,
			accumulated: cursor.accumulated,
			index: cursor.index,
		});
		if (!u) return { kind: "complete" };
		if (cursor.accumulated.length >= cap) return { kind: "cap", count: cursor.accumulated.length };
		const tag = unitTagOf(u);
		return {
			kind: "unit",
			role: "produce",
			tag,
			id: tag,
			label: u.label,
			skill: e.skill,
			prompt: `/skill:${e.skill} ${u.prompt}`,
			def: e.def,
		};
	},
	async guardExpectation(gen, row, cwd, state) {
		if (!gen.expected || gen.expected.index !== gen.cursor.index) {
			const u = await (gen.loop as IterateLoop).next({
				cwd,
				artifact: gen.entryArtifact,
				state,
				accumulated: gen.cursor.accumulated,
				index: gen.cursor.index,
			});
			gen.expected = { index: gen.cursor.index, tag: u ? unitTagOf(u) : undefined };
		}
		// `tag: undefined` = the generator now terminates here, but a row exists — drift.
		return gen.expected.tag === row.unitId;
	},
	async hasPending(loop, probe, run) {
		const u = await (loop as IterateLoop).next({
			cwd: run.cwd,
			artifact: probe.entryArtifact,
			state: run.state,
			accumulated: probe.cursor.accumulated,
			index: probe.cursor.index,
		});
		return u !== null && u !== undefined;
	},
};

const assessStrategy: SequentialStrategy = {
	parallelizable: false,
	// Including a synthesized verify loop. Verify-ness is derived from the
	// parent def (`e.def.verify`), never from the loop object: the synthesis
	// carries no marker, so live and resume can't disagree about flavoring.
	async pull(e, cursor, cap, run) {
		const loop = e.loop as AssessLoop;
		const isVerify = e.def.verify !== undefined;
		if (cursor.phase === "judge") {
			const lp = lastProduceOf(cursor, e.name); // a judge step always follows a completed produce
			// Expand the judge slot to its members and dispatch the member the
			// panel sub-state points at. A single judge is the panel of one
			// (`memberIndex` undefined, member 0 the only member), so its transition
			// is byte-identical to today; a panel walks member 0..N-1 across
			// successive judge-phase pulls, `advanceCursor` bumping
			// `cursor.panel.memberIndex` between them.
			const memberIndex = isPanel(loop.judge) ? (cursor.panel?.memberIndex ?? 0) : undefined;
			const judge = panelMembers(loop.judge)[memberIndex ?? 0]!;
			const judgeSkill = judge.skill ?? (isVerify ? `${e.name}-verify` : `${e.name}-judge`);
			let prompt: string;
			if (judge.skill !== undefined) {
				// produces-validation guarantees the producer emitted an artifact —
				// a miss is the same corrupted-cursor class as a missing produce.
				if (!lp.artifact) {
					const msg = MSG_LOOP_CURSOR_CORRUPT(e.name, "judge skill dispatch found no produced artifact");
					throw invariantPreflight(e.name, msg);
				}
				prompt = `/skill:${judge.skill} ${handleToString(lp.artifact.handle)}`;
			} else {
				prompt = await resolveJudgePrompt(judge.prompt!, {
					cwd: run.cwd,
					output: lp.output,
					entryArtifact: e.entryArtifact,
					state: run.state,
					round: cursor.index,
				});
			}
			const label = judgeUnitLabel(cursor.index, isVerify, memberIndex);
			return {
				kind: "unit",
				role: isVerify ? "verify" : "judge",
				tag: label,
				// Panel member rows carry an `id` so they are identity-bearing for the
				// resume join (`unitId` = the `#{memberIndex}` tag); a single judge keeps
				// identity `(role, round)` with no `id`, exactly as before.
				id: memberIndex === undefined ? undefined : label,
				label,
				skill: judgeSkill,
				prompt,
				def: judgeStageDef(judge),
			};
		}

		// produce — done wins over cap (one code path for live + resume fast-advance)
		if (cursor.lastVerdict !== undefined && loop.done(cursor.lastVerdict)) return { kind: "complete" };
		if (cursor.index >= cap) return { kind: "cap", count: cursor.index };
		// Producer dispatch is skill XOR prompt (the judge arm's posture). For
		// prompt dispatch the message is sent raw: round 0 resolves the stage's own
		// `prompt` at dispatch time (re-resolved on resume — the PromptFn joins the
		// loop determinism contract), and retry rounds send feedForward's output as
		// the COMPLETE message (there is no skill to prefix an arg onto).
		const isPrompt = e.def.prompt !== undefined;
		// `lastVerdict` is only set by a completed judge, which also bumps `index` —
		// so `index - 1 ≥ 0` whenever feedForward runs (round 0 takes entryArgs).
		const arg =
			cursor.lastVerdict !== undefined
				? loop.feedForward({
						cwd: run.cwd,
						output: lastProduceOf(cursor, e.name).output,
						verdict: cursor.lastVerdict,
						round: cursor.index - 1,
						state: run.state,
					})
				: isPrompt
					? await resolveStagePrompt(e.def.prompt!, run.cwd, run.state)
					: e.entryArgs;
		const label = isVerify ? `a${cursor.index}·attempt` : `r${cursor.index}·produce`;
		return {
			kind: "unit",
			role: "produce",
			tag: label,
			label,
			skill: e.skill,
			prompt: isPrompt ? arg : `/skill:${e.skill} ${arg}`,
			def: e.def,
		};
	},
	// The kind-agnostic (role, unitIndex) arithmetic already matched in the
	// caller. Full-check extras:
	//  - a produce row for round n>0 implies done(verdict n-1) was false on the
	//    live run — a now-true done means the predicate drifted;
	//  - a PANEL judge/verify row carries its member index in `unitId`, the
	//    dimension the (role, unitIndex) check can't see — verify it matches the
	//    member the rebuilt sub-state expects, so a missing/reordered member row
	//    is drift, not a silently mis-folded verdict.
	async guardExpectation(gen, row) {
		const loop = gen.loop as AssessLoop; // assessStrategy ⇒ gen.loop is the assess arm by construction
		if (row.role === "produce" && gen.cursor.lastVerdict !== undefined) {
			return !loop.done(gen.cursor.lastVerdict);
		}
		const slot = loop.judge;
		if ((row.role === "judge" || row.role === "verify") && isPanel(slot)) {
			const memberIndex = gen.cursor.panel?.memberIndex ?? 0;
			gen.expected = {
				index: gen.cursor.index,
				memberIndex,
				tag: judgeUnitLabel(gen.cursor.index, row.role === "verify", memberIndex),
			};
			return gen.expected.tag === row.unitId;
		}
		return true;
	},
	// A pending judge always runs; a pending produce runs unless the
	// recovered verdict is done (the driver's fast-advance path).
	async hasPending(loop, probe) {
		if (probe.cursor.phase === "judge") return true;
		return !(probe.cursor.lastVerdict !== undefined && (loop as AssessLoop).done(probe.cursor.lastVerdict));
	},
};

/**
 * One strategy per kind — the `Record` shape turns "added a `LoopDef` arm,
 * forgot the strategy" into a compile error. Keyed value types are preserved
 * (fanout: base `LoopKindStrategy`; iterate/assess: `SequentialStrategy`) so
 * `sequentialStrategyOf` hands back the narrower contract.
 */
export const LOOP_STRATEGIES = {
	fanout: fanoutStrategy,
	iterate: iterateStrategy,
	assess: assessStrategy,
} satisfies Record<LoopDef["kind"], LoopKindStrategy>;

/** Base-contract accessor — all `parallelizable` reads (loop.ts route choice). */
export const loopStrategyOf = (kind: LoopDef["kind"]): LoopKindStrategy => LOOP_STRATEGIES[kind];

/**
 * Sequential-contract accessor for the live `step()` next-step rule, the resume
 * `guardRow` re-check, and the resume announce probe — paths reached ONLY after
 * fanout has routed to the index-addressed parallel dispatcher. The runtime
 * guard makes a future routing regression fail loudly here instead of silently
 * mis-typing a parallelizable strategy; the cast is the one place the
 * never-fanout invariant is asserted (replacing the dead per-method stubs).
 */
export function sequentialStrategyOf(kind: LoopDef["kind"]): SequentialStrategy {
	const s = LOOP_STRATEGIES[kind];
	if (s.parallelizable) {
		const msg = MSG_LOOP_CURSOR_CORRUPT(kind, `sequential driver entered for parallelizable kind "${kind}"`);
		throw invariantPreflight(kind, msg);
	}
	return s as SequentialStrategy;
}
