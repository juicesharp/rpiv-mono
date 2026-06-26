/**
 * loop-waves.ts — topological wave scheduling for dependency-bearing fanout units.
 *
 * A fanout unit may declare `Unit.deps` (the `id ?? label` identities of units it
 * depends on). `computeWaveLevels` assigns each unit a Kahn topological LEVEL over
 * those DIRECTED edges — level 0 = roots (no deps), level k = max(dep levels)+1 —
 * and groups unit INDICES by level. The wave dispatcher (loop-parallel.ts) runs one
 * bounded-parallel dispatch per level, so a dependent never opens before the units it
 * depends on have filled their slots. A deps-free fanout collapses to a single
 * level — byte-identical to the pre-wave flat dispatch.
 *
 * Ordering vs grouping: this is NOT clusterSliceDag (built-in-workflows.ts), which
 * is undirected union-find producing connected-component GROUPS for synth. Waves
 * need DIRECTED levels — different algorithms over the same edge data.
 *
 * Leaf: the identity join key (`unitTagOf`) is the SAME one the resume drift guard
 * and `fanoutUnitAt` read, so deps resolve against the exact ids the slots are keyed
 * by. Validation throws the runner's typed preflight (deps are runtime-computed, so
 * the static load gate can't see them — `stage-rules.ts` never inspects the unit list).
 */

import type { Unit } from "./loop-def.js";
import { unitTagOf } from "./loop-kinds.js";
import { invariantPreflight } from "./stage-errors.js";

/** Map each unit's `id ?? label` identity → its declared (slot) index. Built once;
 *  shared by level computation and the dispatcher's dep-artifact resolution so both
 *  resolve a dep id to the SAME index the cursor slots are keyed by. A duplicate
 *  identity keeps the FIRST index (dispatch + fold place by the first occurrence). */
export function unitIdIndex(units: readonly Unit[]): Map<string, number> {
	const m = new Map<string, number>();
	units.forEach((u, i) => {
		const id = unitTagOf(u);
		if (!m.has(id)) m.set(id, i);
	});
	return m;
}

/**
 * Kahn topological levels over `Unit.deps`, as unit INDICES grouped by level
 * (`levels[k]` = indices whose deepest dep is in level `k-1`). Roots (no deps, or
 * only dangling deps) land in level 0. `level[i]` is the longest-path-from-root
 * depth — a pure DAG function independent of iteration order — so the fixpoint loop
 * converges to the SAME level array every time, and indices stay ascending within a
 * level: live dispatch and resume re-wave produce identical waves. A residual
 * (unlevellable) node ⇒ a dependency cycle ⇒ `invariantPreflight`.
 *
 * Dangling deps (an id matching no unit) are SKIPPED here (treated as satisfied) so
 * a single missing id can't masquerade as a cycle; `validateUnitDeps` is the one that
 * reports dangling refs. At the live entry `validateUnitDeps` runs first, so a cycle
 * reaching here is post-validation/defensive; the throw still lands a clean halt.
 */
export function computeWaveLevels(units: readonly Unit[], stage: string): number[][] {
	if (units.length === 0) return [];
	const idToIndex = unitIdIndex(units);
	// Resolve each unit's deps to indices ONCE; dangling ids drop out (skipped).
	const depIdx = units.map((u) =>
		(u.deps ?? []).map((d) => idToIndex.get(d)).filter((x): x is number => x !== undefined),
	);
	const level = new Array<number>(units.length).fill(-1);
	let remaining = units.length;
	let progressed = true;
	while (remaining > 0 && progressed) {
		progressed = false;
		for (let i = 0; i < units.length; i++) {
			if (level[i] !== -1) continue;
			const deps = depIdx[i]!;
			if (deps.every((d) => level[d] !== -1)) {
				level[i] = deps.length === 0 ? 0 : Math.max(...deps.map((d) => level[d]!)) + 1;
				remaining--;
				progressed = true;
			}
		}
	}
	if (remaining > 0) {
		const stuck = level.flatMap((l, i) => (l === -1 ? [unitTagOf(units[i]!)] : []));
		throw invariantPreflight(stage, `fanout deps form a cycle among units: ${stuck.join(", ")}`);
	}
	const levels: number[][] = Array.from({ length: Math.max(0, ...level) + 1 }, () => []);
	level.forEach((l, i) => {
		levels[l]!.push(i);
	});
	return levels;
}

/**
 * Live-entry guard (run-stage.ts materialization + resume-loop.ts re-wave). Reports
 * a DANGLING dep (an id matching no unit) and a dependency CYCLE, both as a clean
 * `invariantPreflight` halt attributed to `stage`. Cheap; runs before dispatch so the
 * dispatcher never has to throw (D12). Cycle detection delegates to `computeWaveLevels`.
 */
export function validateUnitDeps(units: readonly Unit[], stage: string): void {
	const ids = new Set(units.map(unitTagOf));
	for (const u of units) {
		for (const d of u.deps ?? []) {
			if (!ids.has(d)) {
				throw invariantPreflight(stage, `fanout unit "${unitTagOf(u)}" declares unknown dep "${d}"`);
			}
		}
	}
	computeWaveLevels(units, stage); // throws on cycle
}
