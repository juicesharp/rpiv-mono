/**
 * Predicate combinators — `gt`/`gte`/`lt`/`lte`/`eq` factory functions that
 * `gate(...)` evaluates against `Number(output.data[field])`. Proves each
 * combinator returns a `NumericPredicate` with the right boundary semantics,
 * plus the NaN-compares-false contract the runtime relies on: a missing or
 * non-numeric field coerces to `NaN` via `Number(...)`, and `NaN` compares
 * false against every threshold so no branch spuriously fires.
 */

import { describe, expect, it } from "vitest";
import { eq, gt, gte, lt, lte, type NumericPredicate, type Predicate } from "./predicates.js";

describe("numeric predicate combinators", () => {
	it("gt() is strictly greater-than (boundary excluded)", () => {
		const p = gt(5);
		expect(p(6)).toBe(true);
		expect(p(5)).toBe(false);
		expect(p(4)).toBe(false);
	});

	it("gte() is greater-than-or-equal (boundary included)", () => {
		const p = gte(5);
		expect(p(6)).toBe(true);
		expect(p(5)).toBe(true);
		expect(p(4)).toBe(false);
	});

	it("lt() is strictly less-than (boundary excluded)", () => {
		const p = lt(5);
		expect(p(4)).toBe(true);
		expect(p(5)).toBe(false);
		expect(p(6)).toBe(false);
	});

	it("lte() is less-than-or-equal (boundary included)", () => {
		const p = lte(5);
		expect(p(4)).toBe(true);
		expect(p(5)).toBe(true);
		expect(p(6)).toBe(false);
	});

	it("eq() is numeric equality", () => {
		const p = eq(5);
		expect(p(5)).toBe(true);
		expect(p(6)).toBe(false);
		expect(p(4)).toBe(false);
	});

	it("every combinator returns false for NaN (the runtime's missing-field contract)", () => {
		const ps: NumericPredicate[] = [gt(5), gte(5), lt(5), lte(5), eq(5)];
		for (const p of ps) {
			expect(p(Number.NaN)).toBe(false);
		}
	});

	it("Predicate is the deprecated alias of NumericPredicate", () => {
		const p: Predicate = gt(5);
		expect(p(6)).toBe(true);
	});
});
