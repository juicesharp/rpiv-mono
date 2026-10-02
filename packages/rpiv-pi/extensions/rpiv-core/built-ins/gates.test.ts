/**
 * verdictBlocks — the single blocking predicate's truth table. Every
 * severity-fold consumer (dimensionsToRegrade / allDimensionsPass /
 * confirmDue / ship's shipGradeStopNote) folds through this one definition,
 * so this table pins the shared semantics once: pass true, the low/none
 * severity floor, the anchor-nit clamp, sentinels, mixed findings — plus the
 * risk-blind boundary against confirmDue's ON-TOP risk composition.
 */

import { fs as fsHandle, type Output, type RunView } from "@juicesharp/rpiv-workflow/registration";
import { describe, expect, it } from "vitest";
import {
	confirmDue,
	evidenceCitesFileLine,
	PLAN_DIMENSIONS,
	panelProgress,
	progressFromRoundCounts,
	SLICE_DIMENSIONS,
	type VerdictRecord,
	verdictBlocks,
} from "./gates.js";
import { FILE_LINE_CITATION_RE } from "./shared.js";

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

	it("is risk-blind: a passing verdict with a failed risk ruling stays non-blocking, while confirmDue's composition still blocks", () => {
		const verdict = {
			dimension: "correctness",
			pass: true,
			severity: "low",
			risk_rulings: [{ id: "r1", pass: false }],
		};
		expect(verdictBlocks(verdict)).toBe(false);
		const state: RunView = {
			originalInput: "",
			output: undefined,
			named: {
				"plan-verdicts": [
					{
						kind: "artifacts",
						artifacts: [],
						data: verdict,
						meta: { stage: "plan-grade", stageNumber: 1, ts: "2026-09-05T00:00:00.000Z", runId: "run-1" },
					},
				],
			},
		};
		expect(confirmDue(state, "plans", "plan-verdicts", PLAN_DIMENSIONS)).toBe(true);
	});
});

describe("progressFromRoundCounts (whole-lap rule core)", () => {
	it("maps count trajectories to the four verdicts — counts only, never scores", () => {
		// The signature is the pin: two count parameters, nothing else — no
		// score input exists for the rule core to consult.
		expect(progressFromRoundCounts).toHaveLength(2);
		// Nothing completed behind the current round — the first lap.
		expect(progressFromRoundCounts([], 0)).toBe("unknown");
		expect(progressFromRoundCounts([], 5)).toBe("unknown");
		// Strictly fewer blockers than every earlier round's best.
		expect(progressFromRoundCounts([3], 2)).toBe("improved");
		expect(progressFromRoundCounts([3, 2], 1)).toBe("improved");
		expect(progressFromRoundCounts([2, 1], 0)).toBe("improved");
		// Grew past the immediately previous round.
		expect(progressFromRoundCounts([1], 2)).toBe("regressed");
		expect(progressFromRoundCounts([1, 1, 2], 3)).toBe("regressed");
		// Flat at the best, or between best and last: counted, not waived.
		expect(progressFromRoundCounts([1], 1)).toBe("unchanged");
		expect(progressFromRoundCounts([3, 1], 1)).toBe("unchanged");
		expect(progressFromRoundCounts([1, 3], 2)).toBe("unchanged");
		expect(progressFromRoundCounts([3, 2], 2)).toBe("unchanged");
	});
});

describe("panelProgress — basename-mode round delineation", () => {
	const PLAN = ".rpiv/artifacts/plans/p.md";
	const iso = (h: number, m = 0): string =>
		`2026-09-05T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
	const verdict = (dimension: string, pass: boolean, ts: string, extra: Record<string, unknown> = {}): Output =>
		({
			artifacts: [],
			kind: "json",
			meta: { ts },
			data: { dimension, pass, severity: pass ? "none" : "high", artifact: PLAN, ...extra },
		}) as unknown as Output;
	// A basename-mode round re-grades from scratch (the regenerated artifact
	// invalidates prior verdicts), so every round carries the FULL roster under
	// one fresh artifact basename.
	const rosterRound = (blocking: string[], artifact: string, ts: string): Output[] =>
		PLAN_DIMENSIONS.map((d) => verdict(d, !blocking.includes(d), ts, { artifact }));
	const mapRound = (pass: boolean, i: number, ts: string): Output[] =>
		SLICE_DIMENSIONS.map((d) => verdict(d, pass, ts, { artifact: `.rpiv/artifacts/slices/map-${i}.md` }));
	const progress = panelProgress("code-verdicts", PLAN_DIMENSIONS);
	const sliceProgress = panelProgress("slice-verdicts", SLICE_DIMENSIONS);
	// The per-re-entry verdict sequence: after each round lands, the hook reads
	// the channel a re-entering guard would see.
	const trajectory = (rounds: Output[][], read: (channel: Output[]) => string): string[] => {
		const channel: Output[] = [];
		const out: string[] = [];
		for (const r of rounds) {
			channel.push(...r);
			out.push(read(channel));
		}
		return out;
	};
	const view = (verdicts: Output[]): RunView => ({ named: { "code-verdicts": verdicts } }) as unknown as RunView;
	const sliceView = (verdicts: Output[]): RunView => ({ named: { "slice-verdicts": verdicts } }) as unknown as RunView;

	it("four-round converging trail: 3,2,1,1 counts once, then waives twice, then counts", () => {
		const rounds = [
			rosterRound(["completeness", "correctness", "actionability"], ".rpiv/artifacts/plans/m-1.md", iso(10)),
			rosterRound(["completeness", "correctness"], ".rpiv/artifacts/plans/m-2.md", iso(11)),
			rosterRound(["completeness"], ".rpiv/artifacts/plans/m-3.md", iso(12)),
			rosterRound(["completeness"], ".rpiv/artifacts/plans/m-4.md", iso(13)),
		];
		expect(trajectory(rounds, (c) => progress(view(c)))).toEqual(["unknown", "improved", "improved", "unchanged"]);
	});

	it("converged panel: 1,0,0 improves once then holds", () => {
		const rounds = [
			rosterRound(["completeness"], ".rpiv/artifacts/plans/m-1.md", iso(10)),
			rosterRound([], ".rpiv/artifacts/plans/m-2.md", iso(11)),
			rosterRound([], ".rpiv/artifacts/plans/m-3.md", iso(12)),
		];
		expect(trajectory(rounds, (c) => progress(view(c)))).toEqual(["unknown", "improved", "unchanged"]);
	});

	it("single-dimension lane: 1,1,1,1 never improves", () => {
		const rounds = [
			mapRound(false, 1, iso(10)),
			mapRound(false, 2, iso(11)),
			mapRound(false, 3, iso(12)),
			mapRound(false, 4, iso(13)),
		];
		expect(trajectory(rounds, (c) => sliceProgress(sliceView(c)))).toEqual([
			"unknown",
			"unchanged",
			"unchanged",
			"unchanged",
		]);
	});

	it("severity-floored nit never blocks: 1,1,2,1 regresses on the third lap only", () => {
		const A1 = ".rpiv/artifacts/plans/m-1.md";
		// Round 1: the floored pattern-following nit (pass:false, severity low) is
		// NON-blocking — the lone blocker is completeness.
		const round1 = [
			...PLAN_DIMENSIONS.filter((d) => d !== "pattern-following" && d !== "completeness").map((d) =>
				verdict(d, true, iso(10), { artifact: A1 }),
			),
			verdict("pattern-following", false, iso(10), { artifact: A1, severity: "low" }),
			verdict("completeness", false, iso(10), { artifact: A1 }),
		];
		const rounds = [
			round1,
			rosterRound(["completeness"], ".rpiv/artifacts/plans/m-2.md", iso(11)),
			rosterRound(["completeness", "correctness"], ".rpiv/artifacts/plans/m-3.md", iso(12)),
			rosterRound(["completeness"], ".rpiv/artifacts/plans/m-4.md", iso(13)),
		];
		expect(trajectory(rounds, (c) => progress(view(c)))).toEqual(["unknown", "unchanged", "regressed", "unchanged"]);
	});
});

describe("panelProgress — snapshot-mode cuts, carry-forward, boundary exclusion", () => {
	const PLAN = ".rpiv/artifacts/plans/p.md";
	const iso = (h: number, m = 0): string =>
		`2026-09-05T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
	const verdict = (dimension: string, pass: boolean, ts: string, extra: Record<string, unknown> = {}): Output =>
		({
			artifacts: [],
			kind: "json",
			meta: { ts },
			data: { dimension, pass, severity: pass ? "none" : "high", artifact: PLAN, ...extra },
		}) as unknown as Output;
	const snapshotRow = (ts: string): Output =>
		({ artifacts: [], kind: "", meta: { ts }, data: { snapshot_of: PLAN } }) as unknown as Output;
	const planRow = (): Output =>
		({ artifacts: [{ handle: fsHandle(PLAN) }], data: {}, kind: "", meta: {} }) as unknown as Output;
	const progress = panelProgress("plan-verdicts", PLAN_DIMENSIONS, {
		snapshotChannel: "plan-snapshot",
		artifactChannel: "plans",
	});
	const view = (verdicts: Output[], snapshots: Output[]): RunView =>
		({
			named: { plans: [planRow()], "plan-verdicts": verdicts, "plan-snapshot": snapshots },
		}) as unknown as RunView;

	it("the last cut is the CURRENT round until the channel grows past it", () => {
		const r1 = PLAN_DIMENSIONS.map((d) =>
			verdict(d, !["completeness", "correctness", "actionability"].includes(d), iso(10)),
		);
		const r2 = PLAN_DIMENSIONS.map((d) =>
			verdict(d, !["completeness", "correctness", "actionability"].includes(d), iso(11)),
		);
		const s1 = [snapshotRow(iso(10, 30))];
		const s2 = [snapshotRow(iso(11, 30))];
		// Grade re-entry after two laps: nothing follows s2, so s2 closes the
		// CURRENT round — the earlier set is [3] only, current fold is 3.
		expect(progress(view([...r1, ...r2], [...s1, ...s2]))).toBe("unchanged");
		// Round 3 grades the same three blockers, then its confirm OVERTURNS two
		// of them — the whole-channel fold drops to 1 while both cuts now close
		// completed rounds: earlier [3,3], current 1 ⇒ improved.
		const r3 = PLAN_DIMENSIONS.map((d) =>
			verdict(d, !["completeness", "correctness", "actionability"].includes(d), iso(12)),
		);
		const confirm = [verdict("correctness", true, iso(12, 20)), verdict("actionability", true, iso(12, 20))];
		expect(progress(view([...r1, ...r2, ...r3, ...confirm], [...s1, ...s2]))).toBe("improved");
	});

	it("a dimension graded only in round 1 still counts in round 2's cumulative fold", () => {
		const r1 = PLAN_DIMENSIONS.map((d) => verdict(d, d !== "correctness", iso(10))); // 1 blocking
		// Round 2 re-grades every dimension EXCEPT the still-blocking one — its
		// round-1 verdict carries forward into the current fold.
		const r2 = PLAN_DIMENSIONS.filter((d) => d !== "correctness").map((d) => verdict(d, true, iso(11)));
		const s1 = [snapshotRow(iso(10, 30))];
		// Carried blocker keeps the current count at 1 — unchanged, NOT the
		// "improved" a dropped carry would manufacture.
		expect(progress(view([...r1, ...r2], s1))).toBe("unchanged");
	});
});

describe("panelProgress — fail-safe pins", () => {
	const PLAN = ".rpiv/artifacts/plans/p.md";
	const iso = (h: number, m = 0): string =>
		`2026-09-05T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
	const verdict = (dimension: string, pass: boolean, ts: string, extra: Record<string, unknown> = {}): Output =>
		({
			artifacts: [],
			kind: "json",
			meta: { ts },
			data: { dimension, pass, severity: pass ? "none" : "high", artifact: PLAN, ...extra },
		}) as unknown as Output;
	const sentinel = (dimension: string, ts: string): Output =>
		({ artifacts: [], kind: "failed", meta: { ts }, data: { dimension } }) as unknown as Output;
	const snapshotRow = (ts: string): Output =>
		({ artifacts: [], kind: "", meta: { ts }, data: { snapshot_of: PLAN } }) as unknown as Output;
	const planRow = (): Output =>
		({ artifacts: [{ handle: fsHandle(PLAN) }], data: {}, kind: "", meta: {} }) as unknown as Output;
	const basenameProgress = panelProgress("code-verdicts", PLAN_DIMENSIONS);
	const snapshotProgress = panelProgress("plan-verdicts", PLAN_DIMENSIONS, {
		snapshotChannel: "plan-snapshot",
		artifactChannel: "plans",
	});

	it("a roster dimension absent from the current fold reads unknown — never waived on missing evidence", () => {
		const r1 = [verdict("completeness", false, iso(10))]; // partial first round
		const r2 = [verdict("correctness", true, iso(11))];
		const s1 = [snapshotRow(iso(10, 30))];
		// The cumulative fold carries completeness's blocker, but three roster
		// dimensions were never graded at all — the round is incomplete.
		expect(
			snapshotProgress({
				named: { plans: [planRow()], "plan-verdicts": [...r1, ...r2], "plan-snapshot": s1 },
			} as unknown as RunView),
		).toBe("unknown");
	});

	it("a failed-unit sentinel counts blocking — it cannot waive the lap", () => {
		const round1 = PLAN_DIMENSIONS.map((d) =>
			verdict(d, d !== "completeness", iso(10), { artifact: ".rpiv/artifacts/plans/m-1.md" }),
		);
		const round2 = [
			...PLAN_DIMENSIONS.filter((d) => d !== "completeness").map((d) =>
				verdict(d, true, iso(11), { artifact: ".rpiv/artifacts/plans/m-2.md" }),
			),
			sentinel("completeness", iso(11)),
		];
		// The sentinel is completeness's latest entry with no pass/severity —
		// blocking. Without it the current group would be missing the dimension
		// (unknown) or pass-only (a spurious improved); it reads unchanged.
		expect(
			basenameProgress({
				named: { "code-verdicts": [...round1, ...round2] },
			} as unknown as RunView),
		).toBe("unchanged");
	});

	it("a passed dimension with a failed risk ruling contributes zero blocking — risk-blind", () => {
		const round1 = PLAN_DIMENSIONS.map((d) =>
			verdict(d, d !== "completeness", iso(10), { artifact: ".rpiv/artifacts/plans/m-1.md" }),
		);
		const round2 = PLAN_DIMENSIONS.map((d) =>
			verdict(d, true, iso(11), {
				artifact: ".rpiv/artifacts/plans/m-2.md",
				...(d === "completeness" ? { risk_rulings: [{ id: "r1", pass: false }] } : {}),
			}),
		);
		// The predicate folds dimension verdicts only — risk rulings are the
		// confirm gate's composition, never the progress hook's: every dimension
		// passes, so the lap improves despite the failed ruling.
		expect(
			basenameProgress({
				named: { "code-verdicts": [...round1, ...round2] },
			} as unknown as RunView),
		).toBe("improved");
	});
});

describe("evidenceCitesFileLine", () => {
	const mechanics = { id: "r1", claim_type: "mechanics" };

	it("carries no evidence duty when the plan authored no mechanics risk", () => {
		expect(evidenceCitesFileLine({ id: "r1", pass: true })).toBe(true);
		expect(evidenceCitesFileLine({ id: "r1", pass: true }, { id: "r1" })).toBe(true);
	});

	it("demotes a mechanics pass whose evidence is absent or not a string", () => {
		expect(evidenceCitesFileLine({ id: "r1", pass: true }, mechanics)).toBe(false);
	});

	it("accepts long-extension dotfile citations — the first blind spot", () => {
		expect(
			evidenceCitesFileLine(
				{ id: "r1", pass: true, evidence: ".env.local.example:24 — the vars are present" },
				mechanics,
			),
		).toBe(true);
		expect(
			evidenceCitesFileLine(
				{ id: "r1", pass: true, evidence: "scripts/.env.local.example:24-28 — the vars are present" },
				mechanics,
			),
		).toBe(true);
	});

	it("accepts slash-qualified extensionless citations — the second blind spot", () => {
		expect(
			evidenceCitesFileLine(
				{ id: "r1", pass: true, evidence: "scripts/Makefile:18 — the target is present" },
				mechanics,
			),
		).toBe(true);
		expect(
			evidenceCitesFileLine({ id: "r1", pass: true, evidence: "./Makefile:18 — the target is present" }, mechanics),
		).toBe(true);
	});

	it("still rejects a bare extensionless citation — the deliberate gap", () => {
		expect(
			evidenceCitesFileLine({ id: "r1", pass: true, evidence: "Makefile:18 — the target is present" }, mechanics),
		).toBe(false);
	});

	it("still rejects prose word:number tokens as evidence", () => {
		expect(
			evidenceCitesFileLine(
				{ id: "r1", pass: true, evidence: "checked the 3:1 ratio and the 0:30 timestamp" },
				mechanics,
			),
		).toBe(false);
	});
});

describe("FILE_LINE_CITATION_RE", () => {
	// `.match()`, never `.test()` — the regex carries the /g flag (stateful lastIndex)
	const matches = (s: string): boolean => s.match(FILE_LINE_CITATION_RE) !== null;

	it("matches every citation shape the gate must accept", () => {
		for (const s of [
			"bootstrap.sh:24",
			"bootstrap.sh:24-28",
			"x.md:10",
			".rpiv/artifacts/plans/x.md:10",
			".github/workflows/ci.yml:12",
			".eslintrc.js:3",
			"foo.c:24", // 1-char extension — accepted both before and after the fix
			".env.local.example:24",
			"scripts/.env.local.example:24-28",
			"scripts/Makefile:18",
			"./Makefile:18",
		]) {
			expect(matches(s), s).toBe(true);
		}
	});

	it("never matches prose word:number tokens", () => {
		for (const s of ["3:1", "0:30", "ISO 8601:1988", "8601:1988", "17:13:27", "HTTP:80", "Makefile:18"]) {
			expect(matches(s), s).toBe(false);
		}
	});
});
