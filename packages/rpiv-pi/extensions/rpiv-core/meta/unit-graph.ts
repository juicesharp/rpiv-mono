/**
 * unit-graph — the META authoring layer (`/wf meta`) over the rpiv-workflow engine: a workflow
 * is an ordered list of UNITS, and every unit is one self-correcting loop.
 *
 *     produce ─► checks (code) ─► graders (LLM lenses, parallel) ─► gate
 *        ▲                                                         │
 *        └──────── fix (scoped return: unit, verdict, reason, ─────┘
 *                  evidence, scope) while rounds < maxRounds
 *
 * The loop lives INSIDE a unit; the graph lives BETWEEN units. The compiler
 * expands each unit into engine stages (`<u>`, `<u>-fix`, `<u>-check`,
 * `<u>-grade`, `<u>-gate`) and wires the routes, so a whole pipeline is a
 * short declarative list instead of a hand-wired stage graph.
 *
 * Rules the expansion encodes (each one earned by the build corpus — see
 * meta/README.md):
 * - Deterministic checks run FIRST and short-circuit: a red check never pays
 *   for an LLM grader.
 * - A grader failure routes straight to the corrector. No confirm, no demote.
 * - The correction carries a return record (unit, verdict, reason, evidence,
 *   scope) and is told to touch ONLY what the evidence cites.
 * - A failure signature identical to the previous round's stops the loop
 *   early: the same finding surviving a correction means the corrector cannot
 *   reach it, so spending the remaining rounds is waste.
 * - An exhausted unit either halts, advances, or ESCALATES to an upstream unit
 *   (the plan is wrong, not the unit), carrying its failures as the brief.
 * - `research` is the only mandatory unit and must come first.
 */

import {
	acts,
	defineRoute,
	defineWorkflow,
	directoryPathCollector,
	type EdgeFn,
	fanout,
	gitCommitOutcome,
	handleToString,
	jsonBodyParser,
	type LoopDef,
	type Outcome,
	type Output,
	type PromptFn,
	produces,
	type RunView,
	type ScriptContext,
	type StageDef,
	setRouteNote,
	type Workflow,
} from "@juicesharp/rpiv-workflow/registration";
import { rpivBucketOutcome } from "../artifact-collector.js";
import { COMMIT_BASELINE_PROMPT, latestFsArtifact } from "../built-ins/index.js";
import { lessonsBlock, recordLessons } from "./lessons.js";
import { captureGoalKeepingWip, wipIntact, wipNotice } from "./wip-guard.js";

// ---------------------------------------------------------------------------
// Public vocabulary
// ---------------------------------------------------------------------------

/** One failed item from a check or a grader — the unit of a scoped return. */
export interface Failure {
	/** Which check or lens raised it. */
	source: string;
	/** One-line reason. Its text is the persistence signature, so keep it stable. */
	reason: string;
	/** file:line, command output tail, or other concrete evidence. */
	evidence?: string;
	/** Not correctable: the run stops at once (e.g. the user's pre-existing work was lost). */
	fatal?: boolean;
}

export interface CheckContext extends ScriptContext {
	unit: string;
	round: number;
	/** The unit's latest artifact path (produces units), if any. */
	artifactPath?: string;
}

/** A deterministic grader: code with exactly one correct answer. No model. */
export interface Check {
	name: string;
	run: (ctx: CheckContext) => Failure[] | Promise<Failure[]>;
}

/** An LLM grader: one lens, run in its own fresh session, in parallel with its siblings. */
export interface Grader {
	lens: string;
	/** What this lens judges. A pass/fail question, never "does it look good". */
	rubric: string;
	/** Inputs besides the unit's own artifact (channel names: goal, research, acceptance, plans, ...). */
	context?: readonly string[];
}

/** Dispatch: a skill (args built from `reads`) XOR a raw prompt. */
export type Dispatch =
	| { skill: string; prompt?: never }
	| { prompt: string | ((ctx: UnitPromptContext) => string); skill?: never };

export interface UnitPromptContext {
	state: RunView;
	cwd: string;
	/** `--<channel> <path>` flags for the unit's `reads`. */
	flags: string;
	round: number;
}

export type UnitSpec = Dispatch & {
	/** Channels this unit consumes (the only real graph edges). */
	reads?: readonly string[];
	/**
	 * Bucket the unit's artifact lands in (`.rpiv/artifacts/<output>/`). Omit for
	 * a side-effect unit (implement, commit) whose work is the working tree.
	 */
	output?: string;
	/**
	 * Fan the producer out (e.g. one implement session per plan phase). A fanned
	 * unit cannot take feedback in its prompt, so its corrections run through
	 * `fix` — only the failing items go back, never the whole batch.
	 */
	loop?: LoopDef;
	/** Corrector for rounds ≥ 2. Default: re-run the producer with the return record. */
	fix?: Dispatch;
	checks?: readonly Check[];
	graders?: readonly Grader[];
	/** Producer attempts including the first. Default 3, capped at 4 (the engine's jump budget). */
	maxRounds?: number;
	/**
	 * When the rounds run out: `halt` (default), `advance` (accept as-is and note
	 * it), or the name of an EARLIER unit to re-open with these failures as its brief.
	 */
	onExhausted?: "halt" | "advance" | { escalateTo: string };
};

export interface UnitGraphSpec {
	name: string;
	description?: string;
	/** Ordered units. The first MUST be `research`; everything else is optional. */
	units: ReadonlyArray<readonly [string, UnitSpec]>;
	/** Append a commit stage after the last unit. Default true. */
	commit?: boolean;
}

// ---------------------------------------------------------------------------
// Channel/record helpers (pure folds over state — resume-safe)
// ---------------------------------------------------------------------------

export const VERDICT_DIR = ".rpiv/artifacts/verdicts/meta";
const MAX_ROUNDS_CEILING = 4;

interface GateRecord {
	unit: string;
	round: number;
	generation: number;
	pass: boolean;
	stage: "check" | "gate";
	failures: Failure[];
	/** Decided by the script that wrote the record — routes only read it (resume-safe). */
	decision: "pass" | "correct" | "stop" | "advance" | "escalate";
	note?: string;
	escalateTo?: string;
}

const gateRecords = (state: RunView, unit: string): GateRecord[] =>
	[...(state.named[`${unit}-check`] ?? []), ...(state.named[`${unit}-gate`] ?? [])]
		.map((o) => o.data as GateRecord)
		.filter((r) => r && typeof r.round === "number")
		.sort((a, b) => a.generation - b.generation || a.round - b.round || (a.stage === "check" ? -1 : 1));

/**
 * An escalation opens a new generation for BOTH ends — the upstream unit it
 * re-opens and the downstream unit that raised it — resetting their round counts.
 */
const generationOf = (state: RunView, unit: string): number =>
	Object.values(state.named)
		.flat()
		.map((o) => o.data as GateRecord | undefined)
		.filter((r) => r?.decision === "escalate" && (r.escalateTo === unit || r.unit === unit)).length;

/** The round the unit's latest producer/fix attempt belongs to (1-based). */
const currentRound = (state: RunView, unit: string): number => {
	const gen = generationOf(state, unit);
	const checks = (state.named[`${unit}-check`] ?? []).filter((o) => (o.data as GateRecord).generation === gen);
	return checks.length === 0 ? 1 : (checks.at(-1)!.data as GateRecord).round;
};

/** The latest red record for the unit in its current generation (what a correction answers). */
const latestRed = (state: RunView, unit: string): GateRecord | undefined => {
	const gen = generationOf(state, unit);
	const last = gateRecords(state, unit)
		.filter((r) => r.generation === gen)
		.at(-1);
	return last && !last.pass ? last : undefined;
};

/** Escalation records targeting this unit that it has not yet answered. */
const pendingEscalation = (state: RunView, unit: string): GateRecord | undefined =>
	Object.values(state.named)
		.flat()
		.map((o) => o.data as GateRecord | undefined)
		.filter((r): r is GateRecord => r?.decision === "escalate" && r.escalateTo === unit)
		.at(-1);

const flagsFor = (state: RunView, reads: readonly string[] | undefined): string =>
	(reads ?? [])
		.map((ch) => {
			const a = latestFsArtifact(state, ch);
			return a ? `--${ch} ${handleToString(a.handle)}` : "";
		})
		.filter(Boolean)
		.join(" ");

const signature = (fs: readonly Failure[]): string =>
	fs
		.map((f) => `${f.source}::${f.reason}`)
		.sort()
		.join("\n");

// ---------------------------------------------------------------------------
// The return record — what travels back on a correction edge
// ---------------------------------------------------------------------------

const returnBlock = (
	unit: string,
	rec: GateRecord,
	artifactPath: string | undefined,
	sideEffect: boolean,
	notice = "",
): string => {
	const lines = [
		"",
		"## Correction — return record",
		`UNIT      ${unit} (round ${rec.round} was red; this is round ${rec.round + 1})`,
		`VERDICT   red at ${rec.stage === "check" ? "deterministic check" : "grader panel"}`,
		"REASON / EVIDENCE:",
		...rec.failures.map(
			(f, i) => `  ${i + 1}. [${f.source}] ${f.reason}${f.evidence ? `\n     evidence: ${f.evidence}` : ""}`,
		),
		sideEffect
			? "SCOPE     fix ONLY the failures above, touching only the files the evidence names (or the minimum needed to make the cited command pass). Do not refactor, do not touch other phases or passing work."
			: `SCOPE     revise ${artifactPath ?? "your artifact"} IN PLACE, editing only the sections the failures cite. Passing sections stay byte-identical. Do not widen scope.`,
		...(notice ? [`GUARD     ${notice}`] : []),
	];
	return lines.join("\n");
};

const escalationBlock = (from: GateRecord): string =>
	[
		"",
		`## Escalation from downstream unit \`${from.unit}\``,
		`It exhausted ${from.round} correction rounds; the failures below survived every one, so the cause is upstream of it — in YOUR artifact.`,
		...from.failures.map((f, i) => `  ${i + 1}. [${f.source}] ${f.reason}${f.evidence ? ` — ${f.evidence}` : ""}`),
		"Revise your artifact so the downstream unit can succeed. Change only what these failures implicate.",
	].join("\n");

// ---------------------------------------------------------------------------
// The loop decision — computed once, in the script, and persisted on the record
// ---------------------------------------------------------------------------

function decide(state: RunView, unit: string, spec: UnitSpec, rec: Omit<GateRecord, "decision">): GateRecord {
	if (rec.pass) return { ...rec, decision: "pass" };
	const fatal = rec.failures.find((f) => f.fatal);
	if (fatal)
		return { ...rec, decision: "stop", note: `${unit} FATAL — ${fatal.reason}; ${fatal.evidence ?? ""}`.trim() };
	const maxRounds = Math.min(spec.maxRounds ?? 3, MAX_ROUNDS_CEILING);
	const prev = gateRecords(state, unit)
		.filter((r) => r.generation === rec.generation && !r.pass && r.round === rec.round - 1)
		.at(-1);
	const stuck = prev !== undefined && signature(prev.failures) === signature(rec.failures);
	if (rec.round < maxRounds && !stuck) return { ...rec, decision: "correct" };
	const why = stuck
		? `the same failures survived a correction (round ${rec.round})`
		: `${rec.round}/${maxRounds} rounds spent`;
	const head = `${rec.failures.length} failure(s), first: ${rec.failures[0]?.reason ?? "?"}`;
	const policy = spec.onExhausted ?? "halt";
	if (policy === "halt") return { ...rec, decision: "stop", note: `${unit} red — ${why}; ${head}` };
	if (policy === "advance")
		return { ...rec, decision: "advance", note: `${unit} accepted red by policy — ${why}; ${head}` };
	return {
		...rec,
		decision: "escalate",
		escalateTo: policy.escalateTo,
		note: `${unit} escalates to ${policy.escalateTo} — ${why}`,
	};
}

// ---------------------------------------------------------------------------
// Stage builders
// ---------------------------------------------------------------------------

const dispatchText = (d: Dispatch, ctx: UnitPromptContext): string =>
	d.skill !== undefined
		? `/skill:${d.skill} ${ctx.flags}`.trimEnd()
		: typeof d.prompt === "function"
			? d.prompt(ctx)
			: d.prompt;

function producerPrompt(unit: string, spec: UnitSpec, isFirst: boolean): PromptFn {
	return ({ state, cwd }) => {
		const round = latestRed(state, unit) ? currentRound(state, unit) + 1 : 1;
		const flags = isFirst ? state.originalInput : flagsFor(state, spec.reads);
		let text = dispatchText(spec, { state, cwd, flags, round });
		const lessons = lessonsBlock(cwd, unit);
		if (lessons) text += `\n${lessons}`;
		const esc = pendingEscalation(state, unit);
		if (esc && round === 1) text += escalationBlock(esc);
		const red = latestRed(state, unit);
		const artifact = spec.output ? latestFsArtifact(state, spec.output) : undefined;
		if (red) {
			const notice = spec.output ? "" : wipNotice(state, cwd);
			text += returnBlock(unit, red, artifact ? handleToString(artifact.handle) : undefined, !spec.output, notice);
		}
		return text;
	};
}

function fixPrompt(unit: string, spec: UnitSpec): PromptFn {
	return ({ state, cwd }) => {
		const red = latestRed(state, unit);
		const round = currentRound(state, unit) + 1;
		const flags = flagsFor(state, spec.reads);
		const base = spec.fix
			? dispatchText(spec.fix, { state, cwd, flags, round })
			: `Correct the work of unit \`${unit}\`. Inputs: ${flags}`;
		const artifact = spec.output ? latestFsArtifact(state, spec.output) : undefined;
		const notice = spec.output ? "" : wipNotice(state, cwd);
		return red
			? base + returnBlock(unit, red, artifact ? handleToString(artifact.handle) : undefined, !spec.output, notice)
			: base;
	};
}

function checkStage(unit: string, spec: UnitSpec): StageDef {
	return produces.script({
		run: async (ctx: ScriptContext): Promise<Omit<Output, "meta">> => {
			const generation = generationOf(ctx.state, unit);
			const prior = (ctx.state.named[`${unit}-check`] ?? []).filter(
				(o) => (o.data as GateRecord).generation === generation,
			);
			const round = prior.length + 1;
			const artifact = spec.output ? latestFsArtifact(ctx.state, spec.output) : undefined;
			const artifactPath = artifact?.handle.kind === "fs" ? artifact.handle.path : undefined;
			const failures: Failure[] = [];
			const checks = spec.output ? (spec.checks ?? []) : [wipIntact, ...(spec.checks ?? [])];
			for (const c of checks) {
				try {
					failures.push(...(await c.run({ ...ctx, unit, round, artifactPath })));
				} catch (err) {
					failures.push({
						source: c.name,
						reason: `check threw: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
			}
			const rec = decide(ctx.state, unit, spec, {
				unit,
				round,
				generation,
				pass: failures.length === 0,
				stage: "check",
				failures,
			});
			return { kind: "json", artifacts: [], data: rec };
		},
	});
}

function graderUnits(unit: string, spec: UnitSpec) {
	return fanout({
		source: spec.output,
		unit: { by: "lens" },
		max: Math.max(1, spec.graders?.length ?? 1),
		haltWhenAllFailed: true,
		retryHaltedUnits: 1,
		units: ({ state, cwd }) => {
			const round = currentRound(state, unit);
			const generation = generationOf(state, unit);
			const artifact = spec.output ? latestFsArtifact(state, spec.output) : undefined;
			const target = artifact
				? handleToString(artifact.handle)
				: "the working tree — ONLY the changes this run made (git diff HEAD + untracked, minus the pre-existing paths named in the rubric)";
			const guard = artifact ? "" : ` ${wipNotice(state, cwd)}`;
			return (spec.graders ?? []).map((g) => ({
				id: `${unit}-${g.lens}`,
				label: `${unit} · ${g.lens}`,
				prompt: [
					`--unit ${unit} --lens ${g.lens} --round ${round} --generation ${generation}`,
					`--target ${target}`,
					flagsFor(state, g.context),
					`--out ${VERDICT_DIR}`,
					`--rubric ${JSON.stringify(g.rubric + guard)}`,
				]
					.filter(Boolean)
					.join(" "),
			}));
		},
	});
}

const lensVerdictOutcome = (unit: string): Outcome => ({
	name: `${unit}-verdicts`,
	collector: directoryPathCollector({ dir: VERDICT_DIR, ext: "json" }),
	parser: jsonBodyParser,
});

interface LensVerdict {
	unit?: string;
	lens?: string;
	round?: number;
	generation?: number;
	pass?: boolean;
	severity?: string;
	findings?: Array<{ detail?: string; where?: string }>;
}

/** A lens blocks unless it passed or rated its findings low/none. Missing fields block (fail-safe). */
const lensBlocks = (v: LensVerdict): boolean => v.pass !== true && !(v.severity === "low" || v.severity === "none");

function gateStage(unit: string, spec: UnitSpec): StageDef {
	return produces.script({
		run: ({ state }): Omit<Output, "meta"> => {
			const round = currentRound(state, unit);
			const generation = generationOf(state, unit);
			const fresh = (state.named[`${unit}-verdicts`] ?? [])
				.map((o) => o.data as LensVerdict)
				.filter((v) => v && v.round === round && (v.generation ?? 0) === generation);
			const failures: Failure[] = [];
			for (const g of spec.graders ?? []) {
				const v = fresh.filter((x) => x.lens === g.lens).at(-1);
				if (!v) {
					failures.push({ source: g.lens, reason: "grader produced no verdict for this round" });
					continue;
				}
				if (!lensBlocks(v)) continue;
				const fs = v.findings?.length ? v.findings : [{ detail: `${g.lens} failed (${v.severity ?? "unrated"})` }];
				for (const f of fs) failures.push({ source: g.lens, reason: f.detail ?? "(no detail)", evidence: f.where });
			}
			const rec = decide(state, unit, spec, {
				unit,
				round,
				generation,
				pass: failures.length === 0,
				stage: "gate",
				failures,
			});
			return { kind: "json", artifacts: [], data: rec };
		},
	});
}

// ---------------------------------------------------------------------------
// Routing: pass → next; red → correct | stop-early | exhausted policy
// ---------------------------------------------------------------------------

function redRoute(spec: UnitSpec, channel: string, passTarget: string, correctTarget: string): EdgeFn {
	const policy = spec.onExhausted ?? "halt";
	const escalate = typeof policy === "object" ? [policy.escalateTo] : [];
	const route: EdgeFn = defineRoute(
		[...new Set([passTarget, correctTarget, "stop", ...escalate])],
		({ state }) => {
			const rec = state.named[channel]?.at(-1)?.data as GateRecord | undefined;
			switch (rec?.decision) {
				case "pass":
					return passTarget;
				case "correct":
					return correctTarget;
				case "advance":
					setRouteNote(route, rec.note ?? "advanced red by policy");
					return passTarget;
				case "escalate":
					setRouteNote(route, rec.note ?? "escalated");
					return rec.escalateTo ?? "stop";
				case "stop":
					setRouteNote(route, rec.note ?? "unit exhausted");
					return "stop";
				default:
					setRouteNote(route, `${channel}: no gate record — terminated (integrity stop)`);
					return "stop";
			}
		},
		{ readsData: false },
	);
	return route;
}

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

export function defineUnitGraph(g: UnitGraphSpec): Workflow {
	if (g.units.length === 0 || g.units[0]![0] !== "research") {
		throw new Error(`defineUnitGraph(${g.name}): the first unit must be "research" (the only mandatory unit)`);
	}
	const names = g.units.map(([n]) => n);
	for (const [n, spec] of g.units) {
		const esc = typeof spec.onExhausted === "object" ? spec.onExhausted.escalateTo : undefined;
		if (esc !== undefined && names.indexOf(esc) >= names.indexOf(n)) {
			throw new Error(`defineUnitGraph(${g.name}): unit "${n}" may only escalate to an EARLIER unit, not "${esc}"`);
		}
		if (spec.loop && spec.output) {
			throw new Error(
				`defineUnitGraph(${g.name}): unit "${n}": a fanned (loop) unit is side-effect only — drop \`output\``,
			);
		}
	}

	const stages: Record<string, StageDef> = { goal: produces.script({ run: captureGoalKeepingWip }) };
	const edges: Record<string, string | EdgeFn> = { goal: names[0]! };
	const commit = g.commit ?? true;

	g.units.forEach(([unit, spec], i) => {
		const next = names[i + 1] ?? (commit ? "commit" : "learn");
		const hasGraders = (spec.graders?.length ?? 0) > 0;
		const needsFix = spec.fix !== undefined || spec.loop !== undefined;
		const correctTarget = needsFix ? `${unit}-fix` : unit;

		// Producer
		if (spec.loop) {
			stages[unit] = acts({ skill: spec.skill, loop: spec.loop, reads: spec.reads ? [...spec.reads] : undefined });
		} else if (spec.output) {
			stages[unit] = produces.prompt({
				prompt: producerPrompt(unit, spec, i === 0),
				outcome: rpivBucketOutcome(spec.output),
			});
		} else {
			stages[unit] = acts.prompt({ prompt: producerPrompt(unit, spec, i === 0) });
		}
		edges[unit] = `${unit}-check`;

		// Corrector
		if (needsFix) {
			stages[`${unit}-fix`] = spec.output
				? produces.prompt({ prompt: fixPrompt(unit, spec), outcome: { ...rpivBucketOutcome(spec.output) } })
				: acts.prompt({ prompt: fixPrompt(unit, spec) });
			edges[`${unit}-fix`] = `${unit}-check`;
		}

		// Deterministic floor, then the lens panel
		stages[`${unit}-check`] = checkStage(unit, spec);
		if (hasGraders) {
			stages[`${unit}-grade`] = produces({
				skill: "lens-grade",
				loop: graderUnits(unit, spec),
				outcome: lensVerdictOutcome(unit),
			});
			stages[`${unit}-gate`] = gateStage(unit, spec);
			edges[`${unit}-check`] = redRoute(spec, `${unit}-check`, `${unit}-grade`, correctTarget);
			edges[`${unit}-grade`] = `${unit}-gate`;
			edges[`${unit}-gate`] = redRoute(spec, `${unit}-gate`, next, correctTarget);
		} else {
			edges[`${unit}-check`] = redRoute(spec, `${unit}-check`, next, correctTarget);
		}
	});

	if (commit) {
		stages.commit = acts({ prompt: COMMIT_BASELINE_PROMPT, outcome: gitCommitOutcome });
		edges.commit = "learn";
	}
	// The learning edge: every accepted run leaves its corrected failures behind as
	// standing constraints the next run's producers read (lessons.ts).
	stages.learn = acts.script({ run: (ctx) => recordLessons(ctx, names) });
	edges.learn = "stop";

	return defineWorkflow({
		name: g.name,
		description: g.description,
		start: "goal",
		stages,
		edges,
	});
}
