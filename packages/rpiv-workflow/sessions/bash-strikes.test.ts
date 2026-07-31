/**
 * bash-strikes tests — the per-activation strike-ceiling policy for in-place
 * bash-overrun recovery (strike recovery + strike-history observability).
 */

import { describe, expect, it } from "vitest";
import type { StageSessionContext } from "../types.js";
import {
	BASH_TIMEOUT_STRIKES,
	bashStrikesRemaining,
	bashTimeoutSteeringMessage,
	bashTimeoutStrikeHistory,
	consumeBashStrike,
	resolveBashTimeoutStrikes,
} from "./bash-strikes.js";

/** A bare StageSessionContext carrying only the strike-accounting surface the helpers touch. */
const strikeSession = (overrides: Partial<StageSessionContext> = {}): StageSessionContext =>
	({ ...overrides }) as StageSessionContext;

describe("resolveBashTimeoutStrikes", () => {
	it("defaults to 2 when the override is absent or non-numeric or non-positive", () => {
		expect(resolveBashTimeoutStrikes(undefined)).toBe(2);
		expect(resolveBashTimeoutStrikes("not-a-number")).toBe(2);
		expect(resolveBashTimeoutStrikes("0")).toBe(2);
		expect(resolveBashTimeoutStrikes("-3")).toBe(2);
	});

	it("honours a valid override, clamped to [1,5] and truncated to an integer", () => {
		expect(resolveBashTimeoutStrikes("1")).toBe(1);
		expect(resolveBashTimeoutStrikes("3")).toBe(3);
		expect(resolveBashTimeoutStrikes("5")).toBe(5);
		expect(resolveBashTimeoutStrikes("0.5")).toBe(1); // below floor → clamped up
		expect(resolveBashTimeoutStrikes("9")).toBe(5); // above cap → clamped down
	});

	it("is resolved once at module load into BASH_TIMEOUT_STRIKES (default 2 in the test env)", () => {
		expect(BASH_TIMEOUT_STRIKES).toBe(2);
	});
});

describe("bashTimeoutSteeringMessage", () => {
	const reason = "bash command exceeded the 180s per-command timeout and was aborted: `find /`";

	it("echoes the host reason (snippet + ceiling) on every arm and surfaces strikes remaining", () => {
		for (const remaining of [3, 2, 1, 0]) {
			const msg = bashTimeoutSteeringMessage(reason, remaining, remaining === 0);
			expect(msg).toContain("180s per-command timeout");
			expect(msg).toContain("`find /`");
			expect(msg).toContain(`Strikes remaining after this one: ${remaining}.`);
		}
	});

	it("carries the diagnostic guidance on EVERY arm", () => {
		// Non-final arm:
		const msg = bashTimeoutSteeringMessage(reason, 1, false);
		expect(msg).toMatch(/HUNG, not merely slow/i); // (a) hung-not-slow
		expect(msg).toMatch(/Do NOT rerun the same command verbatim/i); // (b) do-not-rerun-verbatim
		expect(msg).toMatch(/Diagnose the blockage/i); // (c) diagnose-or-report
		expect(msg).not.toMatch(/FINAL strike/i); // final-strike warning absent on a non-final arm
	});

	it("states the final-strike warning ONLY when strikesRemaining === 0", () => {
		const final = bashTimeoutSteeringMessage(reason, 0, true);
		expect(final).toMatch(/consume the FINAL strike and fail/i); // (d)
		expect(final).toMatch(/HUNG, not merely slow/i); // (a)-(c) still present
	});

	it("does NOT duplicate the snippet/ceiling in the guidance prose (those come only from reason)", () => {
		const msg = bashTimeoutSteeringMessage(reason, 1, false);
		// Exactly one occurrence of the ceiling + the snippet (from the echoed reason only).
		expect(msg.split("180s per-command timeout").length - 1).toBe(1);
		expect(msg.split("`find /`").length - 1).toBe(1);
	});
});

describe("strike accounting", () => {
	it("consumeBashStrike consumes-then-increments AND appends the reason", () => {
		const s = strikeSession({ bashTimeoutStrikes: 2 });
		expect(consumeBashStrike(s, "r1")).toBe(true);
		expect(bashTimeoutStrikeHistory(s)).toEqual({ count: 1, reasons: ["r1"] });
		expect(consumeBashStrike(s, "r2")).toBe(true);
		expect(bashTimeoutStrikeHistory(s)).toEqual({ count: 2, reasons: ["r1", "r2"] });
	});

	it("returns false (mutating nothing) once exhausted — counting boundary at default-2", () => {
		const s = strikeSession({ bashTimeoutStrikes: 2 });
		consumeBashStrike(s, "r1");
		consumeBashStrike(s, "r2");
		expect(consumeBashStrike(s, "r3")).toBe(false); // strike 3 → exhaust
		// unchanged — the two prior consumes stand; the third mutated nothing
		expect(bashTimeoutStrikeHistory(s)).toEqual({ count: 2, reasons: ["r1", "r2"] });
	});

	it("bashStrikesRemaining is 0 on the final-strike resume", () => {
		const s = strikeSession({ bashTimeoutStrikes: 2 });
		consumeBashStrike(s, "r1");
		expect(bashStrikesRemaining(s)).toBe(1); // after strike 1
		consumeBashStrike(s, "r2"); // final strike consumed
		expect(bashStrikesRemaining(s)).toBe(0); // final-strike resume
	});

	it("honours the module default ceiling when no override is set", () => {
		const s = strikeSession(); // bashTimeoutStrikes undefined ⇒ BASH_TIMEOUT_STRIKES (2)
		expect(bashStrikesRemaining(s)).toBe(2);
		consumeBashStrike(s, "r1");
		expect(bashStrikesRemaining(s)).toBe(1);
	});

	it("bashTimeoutStrikeHistory is undefined at zero strikes, else {count, reasons}", () => {
		const s = strikeSession({ bashTimeoutStrikes: 2 });
		expect(bashTimeoutStrikeHistory(s)).toBeUndefined(); // nothing consumed
		consumeBashStrike(s, "r1");
		consumeBashStrike(s, "r2");
		expect(bashTimeoutStrikeHistory(s)).toEqual({ count: 2, reasons: ["r1", "r2"] });
	});

	it("🔴 resume-fold: a fresh StageSessionContext (same override) starts at zero strikes after a prior session exhausted its budget (no WeakMap stranding)", () => {
		// A prior session exhausts its 2-strike budget.
		const prior = strikeSession({ bashTimeoutStrikes: 2 });
		consumeBashStrike(prior, "r1");
		consumeBashStrike(prior, "r2");
		expect(bashStrikesRemaining(prior)).toBe(0);
		expect(bashTimeoutStrikeHistory(prior)).toEqual({ count: 2, reasons: ["r1", "r2"] });

		// A FRESH StageSessionContext (simulating a resumed activation) with the same override
		// must start at zero strikes — the WeakMap is keyed by identity, so the prior
		// session's exhausted budget does NOT strand into the new one. This is the
		// resume-fold safety net (precedent d753e3b5→4bd1979e/72d47cfb).
		const freshS = strikeSession({ bashTimeoutStrikes: 2 });
		expect(bashStrikesRemaining(freshS)).toBe(2);
		expect(bashTimeoutStrikeHistory(freshS)).toBeUndefined();
	});
});
