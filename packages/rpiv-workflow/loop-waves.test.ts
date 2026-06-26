import { describe, expect, it } from "vitest";
import type { Unit } from "./loop-def.js";
import { computeWaveLevels, unitIdIndex, validateUnitDeps } from "./loop-waves.js";
import { StagePreflightError } from "./stage-errors.js";

const u = (id: string, deps?: string[]): Unit => ({ prompt: id, label: id, id, ...(deps ? { deps } : {}) });

describe("computeWaveLevels", () => {
	it("collapses a deps-free fanout to a single level (byte-identical to flat dispatch)", () => {
		expect(computeWaveLevels([u("slice-1"), u("slice-2"), u("slice-3")], "design")).toEqual([[0, 1, 2]]);
	});

	it("orders a linear chain into one unit per level", () => {
		const units = [u("slice-1"), u("slice-2", ["slice-1"]), u("slice-3", ["slice-2"])];
		expect(computeWaveLevels(units, "design")).toEqual([[0], [1], [2]]);
	});

	it("places a diamond fan-in at the deepest dep + 1", () => {
		const units = [
			u("slice-1"),
			u("slice-2", ["slice-1"]),
			u("slice-3", ["slice-1"]),
			u("slice-4", ["slice-2", "slice-3"]),
		];
		expect(computeWaveLevels(units, "design")).toEqual([[0], [1, 2], [3]]);
	});

	it("keeps indices ascending within a level regardless of declaration order", () => {
		// root is index 1; a(0) and b(2) both depend on it → level 1, ascending.
		const units = [u("a", ["root"]), u("root"), u("b", ["root"])];
		expect(computeWaveLevels(units, "design")).toEqual([[1], [0, 2]]);
	});

	it("treats a dangling dep as satisfied (validateUnitDeps owns the dangling report)", () => {
		expect(computeWaveLevels([u("slice-2", ["slice-1"])], "design")).toEqual([[0]]);
	});

	it("throws an invariant preflight on a dependency cycle", () => {
		let err: unknown;
		try {
			computeWaveLevels([u("a", ["b"]), u("b", ["a"])], "design");
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(StagePreflightError);
		expect((err as StagePreflightError).kind).toBe("invariant");
		expect((err as StagePreflightError).errMsg).toContain("cycle");
	});

	it("returns no levels for an empty unit list", () => {
		expect(computeWaveLevels([], "design")).toEqual([]);
	});
});

describe("validateUnitDeps", () => {
	it("passes a valid DAG", () => {
		expect(() => validateUnitDeps([u("slice-1"), u("slice-2", ["slice-1"])], "design")).not.toThrow();
	});

	it("throws on a dangling dep id", () => {
		let err: unknown;
		try {
			validateUnitDeps([u("slice-2", ["slice-9"])], "design");
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(StagePreflightError);
		expect((err as StagePreflightError).errMsg).toContain("unknown dep");
	});

	it("throws on a cycle", () => {
		expect(() => validateUnitDeps([u("a", ["b"]), u("b", ["a"])], "design")).toThrow(StagePreflightError);
	});
});

describe("unitIdIndex", () => {
	it("keys by id ?? label and keeps the first occurrence of a duplicate id", () => {
		const units: Unit[] = [
			{ prompt: "p", label: "first", id: "x" },
			{ prompt: "p", label: "by-label" }, // no id → keyed by label
			{ prompt: "p", label: "second", id: "x" }, // dup id → first wins
		];
		const m = unitIdIndex(units);
		expect(m.get("x")).toBe(0);
		expect(m.get("by-label")).toBe(1);
		expect(m.size).toBe(2);
	});
});
