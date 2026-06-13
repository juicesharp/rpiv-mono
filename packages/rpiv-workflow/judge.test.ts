/**
 * Construction-time tests for the `Judge` first-class concept: `judge()` is a
 * valid-by-construction factory (the `defineRoute` pattern) backed by a single
 * `judgeShapeIssues` rule source. Invalid shapes — missing `outcome.name`,
 * skill+prompt, neither — are unrepresentable past the factory.
 */

import { describe, expect, it } from "vitest";
import { type AnyJudge, isPanel, type Judge, judge, judgeShapeIssues, type PanelJudge, panelMembers } from "./judge.js";

const outcome = { name: "verdict" } as Judge["outcome"];

describe("judgeShapeIssues", () => {
	it("returns no issues for a valid skill judge", () => {
		expect(judgeShapeIssues({ skill: "grade", outcome })).toEqual([]);
	});

	it("returns no issues for a valid prompt judge", () => {
		expect(judgeShapeIssues({ prompt: "grade this", outcome })).toEqual([]);
	});

	it("flags a missing judge object", () => {
		expect(judgeShapeIssues(undefined)).toEqual(["a judge object is required"]);
	});

	it("flags missing outcome.name", () => {
		const issues = judgeShapeIssues({ skill: "grade", outcome: {} as Judge["outcome"] });
		expect(issues).toContain("judge.outcome must carry a `name` so the verdict publishes to its own named channel");
	});

	it("flags skill+prompt (both dispatchers set)", () => {
		const issues = judgeShapeIssues({ skill: "grade", prompt: "x", outcome });
		expect(issues).toContain("judge sets both `skill` and `prompt` — choose one dispatch (skill XOR prompt)");
	});

	it("flags neither skill nor prompt", () => {
		const issues = judgeShapeIssues({ outcome });
		expect(issues).toContain("judge sets neither `skill` nor `prompt` — one is required to dispatch the judge");
	});
});

describe("judge()", () => {
	it("is an identity passthrough for a valid judge", () => {
		const spec: Judge = { skill: "grade", outcome };
		expect(judge(spec)).toBe(spec);
	});

	it("throws on missing outcome.name", () => {
		expect(() => judge({ skill: "grade", outcome: {} as Judge["outcome"] })).toThrow(/judge\(\):.*name/);
	});

	it("throws on skill+prompt", () => {
		expect(() => judge({ skill: "grade", prompt: "x", outcome } as unknown as Judge)).toThrow(/skill XOR prompt/);
	});

	it("throws on neither skill nor prompt", () => {
		expect(() => judge({ outcome } as unknown as Judge)).toThrow(/one is required to dispatch/);
	});
});

// Phase 1 of panel(): the type layer + the `panelMembers` expander only. No
// `panel()` factory, brands, or verdict schema yet — a single judge is the
// panel of one, so every judge site keeps single-judge behavior unchanged.
describe("panelMembers / isPanel", () => {
	it("expands a single judge to a one-member list", () => {
		const j = judge({ skill: "grade", outcome });
		expect(panelMembers(j)).toEqual([j]);
	});

	it("yields a panel's own members in order", () => {
		const a = judge({ skill: "a", outcome: { name: "va" } as Judge["outcome"] });
		const b = judge({ skill: "b", outcome: { name: "vb" } as Judge["outcome"] });
		// No factory yet — construct the value structurally (Phase 2 adds panel()).
		const p: PanelJudge = { kind: "panel", members: [a, b], fold: (vs) => vs };
		expect(panelMembers(p)).toEqual([a, b]);
	});

	it("discriminates a panel from a single judge", () => {
		const single: AnyJudge = judge({ skill: "grade", outcome });
		const p: AnyJudge = { kind: "panel", members: [single as Judge], fold: (vs) => vs };
		expect(isPanel(single)).toBe(false);
		expect(isPanel(p)).toBe(true);
	});
});
