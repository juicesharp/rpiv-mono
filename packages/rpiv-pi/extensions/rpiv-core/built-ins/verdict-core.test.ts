/**
 * verdict-core direct truth tables — the shared blocking predicate and the
 * freshness micro-folds every gate layer above builds on. The verdictBlocks
 * describe moved verbatim from gates.test.ts at the gates layer split (its
 * risk-blind confirmDue-composition sibling moved to gate-passes.test.ts with
 * the symbol it exercises); the freshVerdicts / latestVerdictPerDimension
 * describes are new direct pins for folds previously reachable only through
 * the composed workflows.
 */
import type { Output } from "@juicesharp/rpiv-workflow/registration";
import { describe, expect, it } from "vitest";
import { freshVerdicts, latestVerdictPerDimension, type VerdictRecord, verdictBlocks } from "./verdict-core.js";

/** An anchor-drift nit — matches `isAnchorNitDetail`'s drift phrasing. */
const NIT = "the anchor citation drifted 3 lines";
/** A real defect phrasing — matches none of the nit regexes. */
const DEFECT = "the plan omits the migration step entirely";

describe("verdictBlocks", () => {
	it("never blocks a passing verdict, at any severity", () => {
		expect(verdictBlocks({ pass: true })).toBe(false);
		expect(verdictBlocks({ pass: true, severity: "high", findings: [{ detail: DEFECT }] })).toBe(false);
	});

	it("does not block a failing verdict at the low/none severity floor", () => {
		expect(verdictBlocks({ pass: false, severity: "low" })).toBe(false);
		expect(verdictBlocks({ pass: false, severity: "none" })).toBe(false);
	});

	it("clamps an all-nit failing verdict even at high severity", () => {
		expect(verdictBlocks({ pass: false, severity: "high", findings: [{ detail: NIT }] })).toBe(false);
	});

	it("blocks a failing verdict with no severity (raw pass fallback)", () => {
		expect(verdictBlocks({ pass: false })).toBe(true);
	});

	it("blocks medium/high verdicts with non-nit findings", () => {
		expect(verdictBlocks({ pass: false, severity: "medium", findings: [{ detail: DEFECT }] })).toBe(true);
		expect(verdictBlocks({ pass: false, severity: "high", findings: [{ detail: DEFECT }] })).toBe(true);
	});

	it("blocks a dimension-bearing sentinel — a label with none of the three fields", () => {
		const sentinel = { dimension: "correctness" } as VerdictRecord;
		expect(verdictBlocks(sentinel)).toBe(true);
		expect(verdictBlocks(undefined)).toBe(true);
	});

	it("blocks mixed findings — one real defect beside a nit defeats the clamp", () => {
		expect(verdictBlocks({ pass: false, severity: "high", findings: [{ detail: NIT }, { detail: DEFECT }] })).toBe(
			true,
		);
	});
});

describe("freshVerdicts (direct pin)", () => {
	const out = (data: Record<string, unknown>): Output =>
		({ kind: "json", artifacts: [], data, meta: {} }) as unknown as Output;

	it("drops verdicts judged against a replaced artifact — basename match; empty/absent artifact kept (compat default)", () => {
		const current = ".rpiv/artifacts/plans/map-2.md";
		const stale = out({ dimension: "correctness", artifact: ".rpiv/artifacts/plans/map-1.md" });
		const fresh = out({ dimension: "correctness", artifact: current });
		const noField = out({ dimension: "correctness" });
		const empty = out({ dimension: "correctness", artifact: "" });
		expect(freshVerdicts([stale, fresh, noField, empty], current)).toEqual([fresh, noField, empty]);
	});

	it("keeps every entry when no current artifact is given (no-artifact default, unfiltered)", () => {
		const entries = [out({ dimension: "correctness" }), out({ dimension: "completeness" })];
		expect(freshVerdicts(entries)).toBe(entries);
	});
});

describe("latestVerdictPerDimension (direct pin)", () => {
	it("latest verdict per dimension wins; entries without a string dimension are skipped", () => {
		const out = (dimension: unknown): Output =>
			({ kind: "json", artifacts: [], data: { dimension }, meta: {} }) as unknown as Output;
		const c1 = out("correctness");
		const k = out("completeness");
		const bare = out(undefined);
		const c2 = out("correctness");
		const latest = latestVerdictPerDimension([c1, k, bare, c2]);
		expect(latest.size).toBe(2);
		expect(latest.get("correctness")).toBe(c2);
		expect(latest.get("completeness")).toBe(k);
	});
});
