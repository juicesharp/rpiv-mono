/**
 * loop-kinds.ts — the per-loop-kind vocabulary and strategy table.
 *
 * Everything that varies BY KIND across the loop machinery lives here, in
 * one `Record<LoopDef["kind"], LoopKindStrategy>`:
 *   - `pull`             — the live driver's next-step rule (loop.ts `step`);
 *   - `guardExpectation` — the resume fold's per-row determinism re-check
 *                          (runner/resume.ts `guardRow`);
 *   - `hasPending`       — the resume re-entry announce probe
 *                          (runner/resume-loop.ts).
 * A new loop kind (`panel` is hinted) extends the `LoopDef` union and this
 * table — the `Record` shape makes a missing strategy a compile error — and
 * touches nothing else: dispatch, persistence, cap policy, projection, and
 * completion are kind-agnostic in loop.ts.
 *
 * Also home to the kind-agnostic cursor vocabulary the live driver and the
 * fold share: `LoopCursor`, `advanceCursor` (THE cursor state machine),
 * `unitTagOf`, `judgeStageDef`, `LoopEntry`, `NextStep`.
 */

import type { AssessLoop, IterateLoop, LoopDef, StageDef, Unit, UnitRole } from "./api.js";
import { resolveStagePrompt } from "./chain-state.js";
import { type Artifact, handleToString } from "./handle.js";
import { type Judge, resolveJudgePrompt } from "./judge.js";
import type { Output } from "./output.js";
import type { RunContext, RunState } from "./types.js";

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
	/** Units dispatched by THIS driver invocation — the resume silence rule. */
	ranThisInvocation: number;
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
 */
export function advanceCursor(cursor: LoopCursor, role: UnitRole, output: Output, loopKind: LoopDef["kind"]): void {
	if (role === "produce") {
		cursor.accumulated.push(output);
		cursor.lastProduce = { output, artifact: output.artifacts[0] };
		if (loopKind === "assess") cursor.phase = "judge";
		else cursor.index++;
	} else {
		cursor.lastVerdict = output;
		cursor.phase = "produce";
		cursor.index++;
	}
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
 * the generator); the strategy owns the field.
 */
export interface GenerationGuardCtx {
	loop: LoopDef;
	entryArtifact: Artifact | undefined;
	cursor: LoopCursor;
	units?: readonly Unit[];
	expected?: { index: number; tag: string | undefined };
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

export interface LoopKindStrategy {
	/**
	 * The live driver's next-step rule. Cap-check positions preserve pinned
	 * semantics: iterate checks POST-pull (the null terminator wins; the
	 * generator gets one extra discarded call), assess checks pre-round,
	 * fanout checks pre-index. For assess, a `done` verdict wins over the cap
	 * (a done loop is a normal completion, never a cap event).
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

const fanoutStrategy: LoopKindStrategy = {
	async pull(e, cursor, cap) {
		const units = e.units!; // runLoopStage computed it (empty list never reaches the driver)
		if (cursor.index >= units.length) return { kind: "complete" };
		if (cursor.index >= cap) return { kind: "cap", count: cursor.index };
		const u = units[cursor.index]!;
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
	async guardExpectation(gen, row) {
		if (!gen.units || gen.cursor.index >= gen.units.length) return false;
		return unitTagOf(gen.units[gen.cursor.index]!) === row.unitId;
	},
	async hasPending(_loop, probe) {
		return probe.cursor.index < (probe.units?.length ?? 0);
	},
};

const iterateStrategy: LoopKindStrategy = {
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

const assessStrategy: LoopKindStrategy = {
	// Including a synthesized verify loop. Verify-ness is derived from the
	// parent def (`e.def.verify`), never from the loop object: the synthesis
	// carries no marker, so live and resume can't disagree about flavoring.
	async pull(e, cursor, cap, run) {
		const loop = e.loop as AssessLoop;
		const isVerify = e.def.verify !== undefined;
		if (cursor.phase === "judge") {
			const lp = cursor.lastProduce!; // a judge step always follows a completed produce
			const judge = loop.judge;
			const judgeSkill = judge.skill ?? (isVerify ? `${e.name}-verify` : `${e.name}-judge`);
			const prompt =
				judge.skill !== undefined
					? `/skill:${judge.skill} ${handleToString(lp.artifact!.handle)}`
					: await resolveJudgePrompt(judge.prompt!, {
							cwd: run.cwd,
							output: lp.output,
							entryArtifact: e.entryArtifact,
							state: run.state,
							round: cursor.index,
						});
			const label = isVerify ? `a${cursor.index}·verify` : `r${cursor.index}·judge`;
			return {
				kind: "unit",
				role: isVerify ? "verify" : "judge",
				tag: label,
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
						output: cursor.lastProduce!.output,
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
	// caller. Full-check extra: a produce row for round n>0 implies
	// done(verdict n-1) was false on the live run — a now-true done means the
	// predicate drifted.
	async guardExpectation(gen, row) {
		if (row.role === "produce" && gen.cursor.lastVerdict !== undefined) {
			return !(gen.loop as AssessLoop).done(gen.cursor.lastVerdict);
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
 * forgot the strategy" into a compile error. (`FanoutLoop` has no
 * strategy-specific fields beyond `units`, read off `LoopEntry`.)
 */
export const LOOP_STRATEGIES: Record<LoopDef["kind"], LoopKindStrategy> = {
	fanout: fanoutStrategy,
	iterate: iterateStrategy,
	assess: assessStrategy,
};

export const loopStrategyOf = (kind: LoopDef["kind"]): LoopKindStrategy => LOOP_STRATEGIES[kind];
