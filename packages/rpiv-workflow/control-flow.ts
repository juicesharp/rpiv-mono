/**
 * Control-flow as data — `fanout`/`iterate` made inspectable.
 *
 * `fanout`/`iterate` are first-class at RUNTIME (the runner drives them) but
 * opaque to INTROSPECTION: they're raw functions on `StageDef`, and the pattern
 * (what they split over, the cardinality bound, parallel-vs-sequential) lives
 * inside a closure. This module makes that pattern inspectable-as-data by
 * attaching a declarative `.spec` to the function — the exact mechanism
 * `defineRoute`/`gate` use to attach `.targets` (`api.ts`) so reachability checks
 * read every branch without executing the predicate.
 *
 * `fanoutOver(spec)` / `iterateOver(spec)` return the SAME `FanoutFn`/`IterateFn`
 * the runner already consumes (zero runner change), carrying a `FanoutSpec`/
 * `IterateSpec`. Introspectors read the spec; the runner calls the function.
 * A raw `FanoutFn` with no `.spec` stays valid and reads as opaque — same
 * degrade posture as a Zod schema being opaque to `extractJsonSchema`, or a
 * predicate edge being skipped by edge-compat.
 *
 * Skill-agnostic: this module ships the spec VOCABULARY (data) only. The actual
 * unit detector (e.g. "parse the plan's `phases:` frontmatter") is the consumer-
 * supplied `run` function — `rpiv-workflow` ships no conventions.
 */

import type { EdgeFn, FanoutFn, IterateFn, Workflow } from "./api.js";
import { STOP } from "./api.js";

/**
 * How a stage's work is split into units, AS DATA. `by` names the convention
 * ("frontmatter-array" | "markdown-heading" | "glob" | "json-path" | a consumer
 * tag); `pattern` is its opaque parameter; `meta` carries any extra domain hints.
 * The framework never interprets `by`/`pattern` for execution (the `run` fn does)
 * — it only surfaces them so an agent can read or emit the pattern. Open + opaque,
 * mirroring the contract `meta` bag.
 */
export interface UnitSelector {
	by: string;
	pattern?: string;
	meta?: Record<string, unknown>;
}

/** Common shape of both control-flow specs — the introspectable facet. */
interface ControlFlowSpecBase {
	/** The channel / artifact-kind the units are split FROM (a `consumes` signal). */
	source?: string;
	/** How units are detected (opaque convention). */
	unit?: UnitSelector;
	/** Cardinality ceiling, surfaced from what used to be a private constant. */
	max?: number;
}

/** Parallel map: all units computed up front, run independent of one another. */
export interface FanoutSpec extends ControlFlowSpecBase {
	kind: "fanout";
}

/** Sequential fold: one unit per call, each seeing the prior units' outputs. */
export interface IterateSpec extends ControlFlowSpecBase {
	kind: "iterate";
	/** `iterate`'s defining trait — each unit builds on `accumulated`. Always `true`. */
	dependsOnPrior: true;
}

export type ControlFlowSpec = FanoutSpec | IterateSpec;

/** A `FanoutFn`/`IterateFn` carrying its introspectable spec (cf. `EdgeFn.targets`). */
export type SpeccedFanoutFn = FanoutFn & { spec: FanoutSpec };
export type SpeccedIterateFn = IterateFn & { spec: IterateSpec };

/**
 * Build a fanout that is BOTH executable (the runner calls it) and describable
 * (introspectors read `.spec`) — the `defineRoute` pattern for control flow. The
 * `run` fn is the consumer-supplied detector; `rpiv-workflow` ships none.
 */
export function fanoutOver(spec: Omit<FanoutSpec, "kind"> & { run: FanoutFn }): SpeccedFanoutFn {
	const { run, ...rest } = spec;
	const fn = run as SpeccedFanoutFn;
	fn.spec = { kind: "fanout", ...rest };
	return fn;
}

/** Sequential-fold counterpart. `dependsOnPrior` is implied + fixed to `true`. */
export function iterateOver(spec: Omit<IterateSpec, "kind" | "dependsOnPrior"> & { run: IterateFn }): SpeccedIterateFn {
	const { run, ...rest } = spec;
	const fn = run as SpeccedIterateFn;
	fn.spec = { kind: "iterate", dependsOnPrior: true, ...rest };
	return fn;
}

/** Read a fanout spec off a stage's fanout fn, or `undefined` if raw/opaque. */
export function fanoutSpecOf(fn: FanoutFn | undefined): FanoutSpec | undefined {
	return typeof fn === "function" && "spec" in fn ? (fn as SpeccedFanoutFn).spec : undefined;
}

/** Read an iterate spec off a stage's iterate fn, or `undefined` if raw/opaque. */
export function iterateSpecOf(fn: IterateFn | undefined): IterateSpec | undefined {
	return typeof fn === "function" && "spec" in fn ? (fn as SpeccedIterateFn).spec : undefined;
}

/**
 * Per-stage control-flow + edge shape, read entirely from data already attached
 * (`.spec`, `.targets`) — no probing. The control-flow analogue of
 * `legalNextSkills`: what an analyzing/suggesting agent consumes to render or
 * reason about a flow's structure.
 */
export interface StageShape {
	stage: string;
	skill?: string;
	control: { mode: "single" | "fanout" | "iterate"; spec?: ControlFlowSpec };
	edge: { mode: "linear" | "route" | "terminal"; targets?: readonly string[] };
}

/** Describe a workflow's structure stage-by-stage from attached metadata alone. */
export function describeFlow(w: Workflow): StageShape[] {
	return Object.entries(w.stages).map(([name, stage]) => {
		const fanoutSpec = fanoutSpecOf(stage.fanout);
		const iterateSpec = iterateSpecOf(stage.iterate);
		const control: StageShape["control"] = stage.fanout
			? { mode: "fanout", spec: fanoutSpec }
			: stage.iterate
				? { mode: "iterate", spec: iterateSpec }
				: { mode: "single" };

		const target = w.edges[name];
		let edge: StageShape["edge"];
		if (target === undefined || target === STOP) {
			edge = { mode: "terminal" };
		} else if (typeof target === "string") {
			edge = { mode: "linear", targets: [target] };
		} else {
			edge = { mode: "route", targets: (target as EdgeFn).targets };
		}

		return { stage: name, skill: stage.skill, control, edge };
	});
}
