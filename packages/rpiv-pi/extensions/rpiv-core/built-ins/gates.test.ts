/**
 * gates.ts facade key-set pin — the conservation contract of the gates layer
 * split. The module is a pure named re-export layer over verdict-core /
 * gate-rosters / gate-passes; this pins that the exact 33 runtime keys of the
 * pre-split 36-symbol surface survive every future layer edit (the three type
 * exports — RiskRecord, SeedOnlyVerdict, VerdictRecord — carry no runtime key;
 * tsc --noEmit over consumer imports pins those). Behavioral homes moved with
 * their symbols: the verdictBlocks truth table → verdict-core.test.ts;
 * progressFromRoundCounts / panelProgress / the risk-blind confirmDue
 * composition → gate-passes.test.ts; the roster truth tables →
 * gate-rosters.test.ts.
 */
import { describe, expect, it } from "vitest";
import * as gates from "./gates.js";

describe("gates facade key set", () => {
	it("re-exports exactly the pre-split 33 runtime symbols", () => {
		expect(Object.keys(gates).sort()).toEqual(
			[
				"allDimensionsPass",
				"anchorNitsOnly",
				"codeGatePasses",
				"confirmDue",
				"dimensionsToRegrade",
				"evidenceCitesFileLine",
				"freshVerdicts",
				"GOAL_DIMENSIONS",
				"gateRoster",
				"gateTier",
				"latestArtifactPath",
				"latestVerdictPerDimension",
				"panelProgress",
				"panelRoster",
				"PLAN_DIMENSIONS",
				"planAuthoredRisks",
				"planGatePasses",
				"procedureSatisfiesDuty",
				"progressFromRoundCounts",
				"RISK_DIMENSION",
				"rulingEffectivePass",
				"seedLiftStuck",
				"seedOnlyCiteFail",
				"seedOnlyFindings",
				"SHIP_DIMENSIONS",
				"shipGatePasses",
				"shipRoster",
				"sliceGatePasses",
				"SLICE_DIMENSIONS",
				"subplanGatePasses",
				"unitFailedDimensions",
				"verdictBlocks",
				"verdictRiskRulings",
			].sort(),
		);
	});
});
