/**
 * Built-in predicate factories for DAG edge routing (Phase 6).
 *
 * Predicates are pure functions that inspect the manifest and return a target
 * node id. They are declared on predicate edges in the DAG and evaluated
 * by resolveNextStageId.
 */

import type { Manifest } from "./manifest.js";
import type { RunState } from "./types.js";

/** Context passed to edge predicates. */
export interface PredicateContext {
	manifest: Manifest | undefined;
	state: Readonly<RunState>;
}

/** A predicate function returns the target node id. */
export type EdgePredicate = (ctx: PredicateContext) => string;

/**
 * Route based on whether a manifest field equals a specific value.
 * Returns ifTrue when the field equals the target, ifFalse otherwise.
 */
export const predicateOnField =
	<T>(field: string, equals: T, ifTrue: string, ifFalse: string): EdgePredicate =>
	({ manifest }) => {
		const value = (manifest?.data as Record<string, unknown>)?.[field];
		return value === equals ? ifTrue : ifFalse;
	};

/**
 * Route based on whether a numeric manifest field exceeds a threshold.
 * Returns ifAbove when value > threshold, ifBelow otherwise.
 */
export const predicateThreshold =
	(field: string, threshold: number, ifAbove: string, ifBelow: string): EdgePredicate =>
	({ manifest }) => {
		const value = Number((manifest?.data as Record<string, unknown>)?.[field] ?? 0);
		return value > threshold ? ifAbove : ifBelow;
	};
