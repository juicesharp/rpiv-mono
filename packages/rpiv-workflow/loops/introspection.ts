/**
 * Loop introspection — pure-data projections of a stage's control flow + edge
 * shape. Skill-agnostic: a workflow's structure is read entirely from attached
 * data (no probing), so an analyzing/suggesting agent can render or reason about
 * a flow without running it.
 *
 * The spec is the source of truth in the constructor — the `LoopDef` IS data
 * with function-valued fields — so `loopSpecOf` can never lag a new loop kind.
 * Runner-free — safe on `registration`.
 */

import {
	type CapPolicy,
	type EdgeFn,
	type LoopDef,
	type ResultProjection,
	STOP,
	type UnitSelector,
	type Workflow,
} from "../api.js";
import {
	type AnyJudge,
	type CanonicalFoldName,
	canonicalFoldName,
	isPanel,
	type Judge,
	type PanelJudge,
} from "../judge.js";
import { readName, readsAll } from "../stage-def.js";

// ===========================================================================
// Introspection — per-stage control-flow + edge shape
// ===========================================================================

/**
 * Per-stage control-flow + edge shape, read entirely from attached data — no
 * probing. The control-flow analogue of `legalNextSkills`: what an
 * analyzing/suggesting agent consumes to render or reason about a flow's
 * structure. `control.mode` covers assess.
 */
export interface StageShape {
	stage: string;
	skill?: string;
	control: { mode: "single" | LoopDef["kind"]; spec?: LoopSpec };
	/**
	 * Present iff the stage carries a `verify` post-condition. `control.mode`
	 * stays `"single"` for verify stages — verify is a stage property in the
	 * introspection model, not a loop kind (the desugar is a runtime concern).
	 * A `panel()` post-condition projects a `PanelJudgeSpec` here (still + `max`).
	 */
	verify?: AnyJudgeSpec & { max: number };
	/**
	 * Present iff the stage declares `reads:`. One entry per read, in declared
	 * order, carrying the normalized channel `name` and `all` (true ⇒ a
	 * `fanin()` read that consumes EVERY accumulated entry — the fan-in barrier;
	 * false ⇒ latest-wins). Pure data — the preview layer renders the marker.
	 */
	reads?: ReadonlyArray<{ name: string; all: boolean }>;
	/**
	 * Outgoing-edge shape. `mode: "terminal"` is the GRAPH-SINK sense (a stage
	 * with no outgoing edge OR an explicit `STOP`) — unrelated to the `terminal()`
	 * stage factory (stage-def.ts) and to "terminal failure" run-outcome prose
	 * (audit.ts). See the glossary on `stage-def.ts`'s `terminal` export.
	 */
	edge: { mode: "linear" | "route" | "terminal"; targets?: readonly string[] };
}

/** Describe a workflow's structure stage-by-stage from attached metadata alone. */
export function describeFlow(w: Workflow): StageShape[] {
	return Object.entries(w.stages).map(([name, stage]) => {
		const control: StageShape["control"] = stage.loop
			? { mode: stage.loop.kind, spec: loopSpecOf(stage.loop) }
			: { mode: "single" };

		const target = w.edges[name];
		let edge: StageShape["edge"];
		if (target === undefined || target === STOP) {
			// Graph-sink sense (no edge OR explicit STOP) — see `StageShape.edge`.
			edge = { mode: "terminal" };
		} else if (typeof target === "string") {
			edge = { mode: "linear", targets: [target] };
		} else {
			edge = { mode: "route", targets: (target as EdgeFn).targets };
		}

		const reads = stage.reads?.map((r) => ({ name: readName(r), all: readsAll(r) }));
		return {
			stage: name,
			skill: stage.skill,
			control,
			...(stage.verify ? { verify: { ...judgeSlotSpecOf(stage.verify.judge), max: stage.verify.max ?? 1 } } : {}),
			...(reads?.length ? { reads } : {}),
			edge,
		};
	});
}

// ===========================================================================
// Introspection — one channel for all loop kinds
// ===========================================================================

/**
 * Pure-data projection of a LoopDef — what `describeFlow`, `preview`, and the
 * `checkFanoutSource` lint consume. `judge` summarises the dispatch without
 * exposing functions: `prompt: true` means a prompt judge (the text/closure
 * itself stays opaque).
 */
/** Pure-data judge summary — `prompt: true` means a prompt judge (the text/closure stays opaque). */
export interface JudgeSpec {
	skill?: string;
	prompt: boolean;
	outcome: string;
}

/**
 * Pure-data summary of an N-member panel — the introspection twin of
 * `PanelJudge`. `panel` carries one `JudgeSpec` per member; `fold` is the sugar
 * name (`majority`/`all`/`any`) for a canonical fold, `"custom"` for a raw
 * author fold; `outcome` is the custom verdict channel, or `""` when the panel
 * uses the canonical `<stage>-panel` default. Discriminated from `JudgeSpec` by
 * the presence of `panel`.
 */
export interface PanelJudgeSpec {
	panel: JudgeSpec[];
	fold: CanonicalFoldName | "custom";
	outcome: string;
}

/** Pure-data summary of a judge SLOT — a single judge or a panel (the introspection twin of `AnyJudge`). */
export type AnyJudgeSpec = JudgeSpec | PanelJudgeSpec;

/**
 * Project the introspectable facet off a Judge — shared by `loopSpecOf` and the
 * `StageShape.verify` projection so the two can't drift. Defensive on `outcome`:
 * `validateWorkflow`'s lints run this over UNVALIDATED configs (a malformed
 * member can lack `outcome` entirely), so a projection must never throw.
 */
export function judgeSpecOf(judge: Judge): JudgeSpec {
	return { skill: judge.skill, prompt: judge.prompt !== undefined, outcome: judge.outcome?.name ?? "" };
}

/**
 * Project the introspectable facet off a panel — member summaries + fold flavor
 * + verdict channel. Defensive (like `judgeSpecOf`): a hand-rolled panel reaching
 * a load-time lint may carry a non-array `members` or non-function `fold`.
 */
export function panelSpecOf(p: PanelJudge): PanelJudgeSpec {
	const members = Array.isArray(p.members) ? p.members : [];
	return {
		panel: members.map(judgeSpecOf),
		fold: typeof p.fold === "function" ? (canonicalFoldName(p.fold) ?? "custom") : "custom",
		outcome: p.outcome?.name ?? "",
	};
}

/** Project the introspectable facet off a judge SLOT — a panel through `panelSpecOf`, a single judge through `judgeSpecOf`. */
export function judgeSlotSpecOf(slot: AnyJudge): AnyJudgeSpec {
	return isPanel(slot) ? panelSpecOf(slot) : judgeSpecOf(slot);
}

export interface LoopSpec {
	kind: LoopDef["kind"];
	source?: string;
	unit?: UnitSelector;
	max?: number;
	onCap: CapPolicy;
	result: ResultProjection;
	judge?: AnyJudgeSpec;
}

/** Project the introspectable facet off a stage's loop, or undefined for non-loop stages. */
export function loopSpecOf(loop: LoopDef | undefined): LoopSpec | undefined {
	if (!loop) return undefined;
	const base: LoopSpec = {
		kind: loop.kind,
		source: loop.source,
		unit: loop.unit,
		max: loop.max,
		onCap: loop.onCap,
		result: loop.result,
	};
	if (loop.kind === "assess") base.judge = judgeSlotSpecOf(loop.judge);
	return base;
}
