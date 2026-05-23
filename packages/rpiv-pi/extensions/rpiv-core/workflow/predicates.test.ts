import { describe, expect, it } from "vitest";
import { predicateOnField, predicateThreshold } from "./predicates.js";

describe("predicateThreshold", () => {
	it("returns ifAbove when value > threshold", () => {
		const pred = predicateThreshold("severeIssueCount", 0, "revise", "commit");
		const result = pred({
			manifest: {
				kind: "artifact-md",
				data: { severeIssueCount: 3 },
				meta: { skill: "code-review", stage: 1, ts: "", runId: "" },
			},
			state: {} as never,
		});
		expect(result).toBe("revise");
	});

	it("returns ifBelow when value <= threshold", () => {
		const pred = predicateThreshold("severeIssueCount", 0, "revise", "commit");
		const result = pred({
			manifest: {
				kind: "artifact-md",
				data: { severeIssueCount: 0 },
				meta: { skill: "code-review", stage: 1, ts: "", runId: "" },
			},
			state: {} as never,
		});
		expect(result).toBe("commit");
	});

	it("returns ifBelow when value equals threshold (not strictly greater)", () => {
		const pred = predicateThreshold("count", 5, "above", "below");
		const result = pred({
			manifest: { kind: "artifact-md", data: { count: 5 }, meta: { skill: "test", stage: 1, ts: "", runId: "" } },
			state: {} as never,
		});
		expect(result).toBe("below");
	});

	it("treats missing field as 0", () => {
		const pred = predicateThreshold("missing", 0, "above", "below");
		const result = pred({
			manifest: { kind: "artifact-md", data: {}, meta: { skill: "test", stage: 1, ts: "", runId: "" } },
			state: {} as never,
		});
		expect(result).toBe("below");
	});

	it("treats undefined manifest as 0", () => {
		const pred = predicateThreshold("count", 0, "above", "below");
		const result = pred({
			manifest: undefined,
			state: {} as never,
		});
		expect(result).toBe("below");
	});

	it("treats non-numeric value as NaN (which is not > threshold)", () => {
		const pred = predicateThreshold("field", 0, "above", "below");
		const result = pred({
			manifest: {
				kind: "artifact-md",
				data: { field: "not a number" },
				meta: { skill: "test", stage: 1, ts: "", runId: "" },
			},
			state: {} as never,
		});
		expect(result).toBe("below");
	});
});

describe("predicateOnField", () => {
	it("returns ifTrue when field equals target", () => {
		const pred = predicateOnField("status", "pass", "commit", "revise");
		const result = pred({
			manifest: {
				kind: "artifact-md",
				data: { status: "pass" },
				meta: { skill: "test", stage: 1, ts: "", runId: "" },
			},
			state: {} as never,
		});
		expect(result).toBe("commit");
	});

	it("returns ifFalse when field does not equal target", () => {
		const pred = predicateOnField("status", "pass", "commit", "revise");
		const result = pred({
			manifest: {
				kind: "artifact-md",
				data: { status: "fail" },
				meta: { skill: "test", stage: 1, ts: "", runId: "" },
			},
			state: {} as never,
		});
		expect(result).toBe("revise");
	});

	it("uses strict equality (number 1 !== string '1')", () => {
		const pred = predicateOnField<number | string>("val", 1, "yes", "no");
		const result = pred({
			manifest: { kind: "artifact-md", data: { val: "1" }, meta: { skill: "test", stage: 1, ts: "", runId: "" } },
			state: {} as never,
		});
		expect(result).toBe("no");
	});

	it("returns ifFalse when field is missing", () => {
		const pred = predicateOnField("missing", "expected", "yes", "no");
		const result = pred({
			manifest: { kind: "artifact-md", data: {}, meta: { skill: "test", stage: 1, ts: "", runId: "" } },
			state: {} as never,
		});
		expect(result).toBe("no");
	});

	it("returns ifFalse when manifest is undefined", () => {
		const pred = predicateOnField("field", "val", "yes", "no");
		const result = pred({
			manifest: undefined,
			state: {} as never,
		});
		expect(result).toBe("no");
	});
});
