/** Render-time hit targets. State transitions remain owned by the session/reducer. */
export type PointerTarget = { kind: "option"; index: number } | { kind: "submit"; index: 0 | 1 };

/** One cell interval per rendered line; absent rows are chrome, gaps, or preview content. */
export interface PointerRow {
	start: number;
	end: number;
	target: PointerTarget;
}

export function optionPointerRows(items: readonly (number | undefined)[], width: number): (PointerRow | undefined)[] {
	return items.map((index) =>
		index === undefined ? undefined : { start: 0, end: width, target: { kind: "option", index } },
	);
}

export function pointerTargetAt(
	rows: readonly (PointerRow | undefined)[],
	x: number,
	y: number,
): PointerTarget | undefined {
	const row = rows[y];
	return row && x >= row.start && x < row.end ? row.target : undefined;
}
