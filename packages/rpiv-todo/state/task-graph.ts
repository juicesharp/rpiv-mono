import type { Task } from "../tool/types.js";

/**
 * Detect whether merging `newBlockedBy` into `taskId`'s `blockedBy` set would
 * introduce a cycle in the dependency graph.
 *
 * Pure of any module state; takes the existing `taskList` and the proposed
 * additions explicitly so the reducer can ask "would this update cycle?"
 * without mutating state first.
 */
export function detectCycle(taskList: readonly Task[], taskId: number, newBlockedBy: readonly number[]): boolean {
	const edges = new Map<number, number[]>();
	for (const t of taskList) {
		if (t.id === taskId) {
			const merged = new Set([...(t.blockedBy ?? []), ...newBlockedBy]);
			edges.set(t.id, [...merged]);
		} else {
			edges.set(t.id, t.blockedBy ? [...t.blockedBy] : []);
		}
	}

	const visiting = new Set<number>();
	const visited = new Set<number>();
	const hasCycleFrom = (node: number): boolean => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;
		visiting.add(node);
		for (const nb of edges.get(node) ?? []) {
			if (hasCycleFrom(nb)) return true;
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	};

	for (const node of edges.keys()) {
		if (hasCycleFrom(node)) return true;
	}
	return false;
}

/**
 * Build the inverse adjacency map: for each task `T`, which other tasks list
 * `T` in their `blockedBy`. Consumed by `selectShowTaskIds` (overlay gating)
 * and the `get` action's "blocks: #x, #y" suffix line.
 */
export function deriveBlocks(taskList: readonly Task[]): Map<number, number[]> {
	const blocks = new Map<number, number[]>();
	for (const t of taskList) {
		for (const dep of t.blockedBy ?? []) {
			const arr = blocks.get(dep) ?? [];
			arr.push(t.id);
			blocks.set(dep, arr);
		}
	}
	return blocks;
}
