import { describe, expect, it } from "vitest";
import {
	fullRowBudget,
	HOST_ALLOCATED_ROWS,
	INLINE_MIN_ROWS,
	inlineRowBudget,
	mustYieldInlineSlot,
	resolvePresentation,
	rowBudgetForHost,
} from "./presentation.js";

describe("row budgets", () => {
	it("passes terminal rows through unchanged for the overlay", () => {
		expect(fullRowBudget(24)).toBe(24);
		expect(fullRowBudget(7)).toBe(7);
	});

	it("caps inline at a share of the terminal with a floor, never above the terminal", () => {
		expect(inlineRowBudget(24)).toBe(16);
		expect(inlineRowBudget(40)).toBe(28);
		expect(inlineRowBudget(16)).toBe(INLINE_MIN_ROWS);
		expect(inlineRowBudget(8)).toBe(8);
	});
});

describe("resolvePresentation", () => {
	it("holds the inline slot until released, degrading contenders to a hideable overlay", () => {
		const first = resolvePresentation();
		expect(first).toMatchObject({ overlay: false, rowBudget: inlineRowBudget });
		const second = resolvePresentation();
		expect(second).toMatchObject({ overlay: true, rowBudget: fullRowBudget, hideOnCollapse: true });
		expect(second.release).toBeUndefined();

		first.release?.();
		// Idempotent: a double release must not free a slot someone else now holds.
		const third = resolvePresentation();
		first.release?.();
		expect(resolvePresentation().overlay).toBe(true);
		third.release?.();
	});
});

describe("rowBudgetForHost", () => {
	it("keeps the presentation's budget for a plain terminal", () => {
		expect(rowBudgetForHost({ rows: 24 }, inlineRowBudget)).toBe(inlineRowBudget);
	});

	it("uses every reported row when the host has already allocated them", () => {
		const allocated = { rows: 19, [HOST_ALLOCATED_ROWS]: true };
		expect(rowBudgetForHost(allocated, inlineRowBudget)).toBe(fullRowBudget);
	});
});

describe("mustYieldInlineSlot", () => {
	const terminal = { rows: 24 };

	it("keeps the slot when nothing is on screen, or the host cannot say", () => {
		expect(mustYieldInlineSlot({ terminal, hasOverlay: () => false })).toBe(false);
		expect(mustYieldInlineSlot({ terminal })).toBe(false);
	});

	it("yields when another overlay is already showing", () => {
		expect(mustYieldInlineSlot({ terminal, hasOverlay: () => true })).toBe(true);
	});

	it("leaves a host that allocates the rows itself in charge of its geometry", () => {
		expect(mustYieldInlineSlot({ terminal: { rows: 19, [HOST_ALLOCATED_ROWS]: true }, hasOverlay: () => true })).toBe(
			false,
		);
	});
});
