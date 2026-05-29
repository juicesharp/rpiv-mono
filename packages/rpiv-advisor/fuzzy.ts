/**
 * fuzzy — pure type-to-filter helpers for the /advisor select pickers.
 *
 * A subsequence matcher (fuzzyScore/filterItems) plus the two key-input
 * predicates (isBackspace/isPrintable) that advisor-ui.ts's filterable picker
 * drives off of. All side-effect-free and TUI-free: the only dependency is the
 * SelectItem shape filterItems ranks. Kept apart from advisor-ui.ts so that
 * module holds only bordered-panel/SelectList wiring.
 */

import type { SelectItem } from "@earendil-works/pi-tui";

/**
 * Fuzzy subsequence match. Returns a relevance score (higher is better) when
 * every character of `query` appears in `text` in order, or null when it does
 * not match. Contiguous runs and word-boundary hits (start, space, ":", "-")
 * score higher so "opus" ranks an "Opus" model above an incidental scatter.
 */
export function fuzzyScore(query: string, text: string): number | null {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	if (q.length === 0) return 0;

	let qi = 0;
	let score = 0;
	let streak = 0;
	let prevMatch = -2;

	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] !== q[qi]) continue;

		if (prevMatch === ti - 1) {
			streak += 1;
			score += 5 + streak;
		} else {
			streak = 0;
			score += 1;
		}

		const prev = t[ti - 1];
		if (ti === 0 || prev === " " || prev === ":" || prev === "-") score += 3;

		prevMatch = ti;
		qi += 1;
	}

	return qi === q.length ? score : null;
}

/**
 * Filter + rank items by a fuzzy query, matching against both the visible
 * label and the underlying value (e.g. "anthropic:claude-opus-4-7"). An empty
 * query returns the items unchanged, preserving the caller's ordering.
 */
export function filterItems(items: SelectItem[], query: string): SelectItem[] {
	if (query.length === 0) return items;

	return items
		.map((item, idx) => ({ item, idx, score: fuzzyScore(query, `${item.label} ${item.value}`) }))
		.filter((scored): scored is { item: SelectItem; idx: number; score: number } => scored.score !== null)
		.sort((a, b) => b.score - a.score || a.idx - b.idx)
		.map((scored) => scored.item);
}

export function isBackspace(data: string): boolean {
	return data === "\u007f" || data === "\b";
}

export function isPrintable(data: string): boolean {
	if (data.length !== 1) return false;
	const code = data.charCodeAt(0);
	return code >= 0x20 && code !== 0x7f;
}
