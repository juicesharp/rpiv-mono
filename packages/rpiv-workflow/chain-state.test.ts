/**
 * Tests for the collect-all fanout state effects:
 *
 *   - `applyCompletedStage` EARLY-RETURNS for fanout stages — the
 *     index-addressed `placeFanoutOutput` fold owns the produces channel, so a
 *     push here would double-write. The idempotent acts-fanout primary-clear
 *     (`inheritsArtifacts === false`) still runs.
 *   - `placeFanoutOutput` pre-sizes the channel to `total` and fills it
 *     positionally; gaps (pending slots) and failed sentinels are tolerated, and
 *     a failed sentinel never advances the rolling primary.
 *   - `stageEntryArgs`' `fanin` reader skips unfilled (pending) and failed slots,
 *     reading the surviving entries in DECLARED order — and an ALL-FAILED channel
 *     yields a DEFINED (empty) arg string, never `undefined` (the all-failed
 *     contract: synthesis still runs).
 *
 * Sequential-path parity for `applyCompletedStage` (produces/acts/terminal) lives
 * in `internal-utils.test.ts`; this file pins only the fanout-specific behavior.
 */

import { describe, expect, it } from "vitest";
import type { StageDef } from "./api.js";
import { applyCompletedStage, placeFanoutOutput, stageEntryArgs } from "./chain-state.js";
import { type Artifact, fs as fsHandle, handleToString } from "./handle.js";
import { failedOutput, type Output, type OutputMeta } from "./output.js";
import { fanin } from "./stage-def.js";
import type { RunState } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const meta: OutputMeta = { stage: "audit", skill: "audit", stageNumber: 2, ts: "", runId: "r" };

const fakeArtifact = (path: string): Artifact => ({ handle: fsHandle(path), role: "primary" });

const fakeOutput = (artifacts: readonly Artifact[] = []): Output => ({
	kind: "artifacts",
	artifacts,
	data: {},
	meta,
});

const freshState = (): RunState => ({
	originalInput: "brief",
	primaryArtifact: undefined,
	output: undefined,
	named: {},
	stagesCompleted: 0,
	lastAllocatedStageNumber: 0,
	telemetry: { backwardJumps: 0, droppedRoutingRows: [], droppedFailureRows: [] },
	termination: { status: "running" },
});

/** produces-fanout def — `loop.kind === "fanout"`, channel key from outcome.name. */
const producesFanoutDef = (outcomeName = "audits"): StageDef =>
	({
		kind: "produces",
		sessionPolicy: "fresh",
		loop: { kind: "fanout" },
		outcome: { name: outcomeName, collector: { collect: () => ({ kind: "ok", artifacts: [] }) } },
	}) as unknown as StageDef;

/** acts-fanout def — non-produces, optionally opting out of inheritance (terminal-like). */
const actsFanoutDef = (inheritsArtifacts?: boolean): StageDef =>
	({
		kind: "side-effect",
		sessionPolicy: "fresh",
		loop: { kind: "fanout" },
		...(inheritsArtifacts !== undefined ? { inheritsArtifacts } : {}),
	}) as StageDef;

/** A stage that fan-INs a channel — reads every accumulated entry. */
const faninReaderDef = (channel = "audits"): StageDef =>
	({ kind: "produces", sessionPolicy: "fresh", reads: [fanin(channel)] }) as StageDef;

// ---------------------------------------------------------------------------
// applyCompletedStage — fanout early-return
// ---------------------------------------------------------------------------

describe("applyCompletedStage — fanout (early-return)", () => {
	it("produces-fanout: does NOT push the channel (the fold owns it) and leaves primary alone", () => {
		const state = freshState();
		const existing = fakeArtifact("entry.md");
		state.primaryArtifact = existing;

		applyCompletedStage(state, producesFanoutDef(), "audit", fakeOutput([fakeArtifact("a.md")]));

		// No channel write here — placeFanoutOutput is the single channel-write site.
		expect(state.named.audits).toBeUndefined();
		// Primary untouched (the fold sets it via placeFanoutOutput, not here).
		expect(state.primaryArtifact).toBe(existing);
	});

	it("acts-fanout with inheritsArtifacts:false: clears primary (idempotent primary-clear)", () => {
		const state = freshState();
		state.primaryArtifact = fakeArtifact("entry.md");

		applyCompletedStage(state, actsFanoutDef(false), "commit", fakeOutput());

		expect(state.primaryArtifact).toBeUndefined();
	});

	it("acts-fanout WITHOUT inheritsArtifacts:false: leaves primary untouched", () => {
		const state = freshState();
		const existing = fakeArtifact("entry.md");
		state.primaryArtifact = existing;

		applyCompletedStage(state, actsFanoutDef(), "commit", fakeOutput());

		expect(state.primaryArtifact).toBe(existing);
		expect(state.named).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// placeFanoutOutput — index-addressed positional fill
// ---------------------------------------------------------------------------

describe("placeFanoutOutput — positional fill (gaps + sentinels tolerated)", () => {
	it("pre-sizes the channel to `total` and fills positionally, leaving gaps undefined", () => {
		const state = freshState();
		const def = producesFanoutDef();
		const o0 = fakeOutput([fakeArtifact("0.md")]);
		const o2 = fakeOutput([fakeArtifact("2.md")]);

		placeFanoutOutput(state, def, "audit", 0, 3, o0);
		placeFanoutOutput(state, def, "audit", 2, 3, o2);

		const slot = state.named.audits as readonly (Output | undefined)[];
		expect(slot.length).toBe(3);
		expect(slot[0]).toBe(o0);
		expect(slot[1]).toBeUndefined(); // still pending
		expect(slot[2]).toBe(o2);
	});

	it("a successful unit advances primary; a failed sentinel does NOT", () => {
		const state = freshState();
		const def = producesFanoutDef();
		const good = fakeArtifact("0.md");

		placeFanoutOutput(state, def, "audit", 0, 2, fakeOutput([good]));
		expect(state.primaryArtifact).toBe(good);

		// A failed sentinel (no artifacts) must not clobber the rolling primary.
		placeFanoutOutput(state, def, "audit", 1, 2, failedOutput(meta, "unit 1 failed"));
		expect(state.primaryArtifact).toBe(good);
	});

	it("acts-fanout: writes no channel; inheritsArtifacts:false clears primary", () => {
		const state = freshState();
		state.primaryArtifact = fakeArtifact("entry.md");

		placeFanoutOutput(state, actsFanoutDef(false), "commit", 0, 1, fakeOutput());

		expect(state.primaryArtifact).toBeUndefined();
		expect(state.named).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// stageEntryArgs — fanin skips failed/unfilled slots
// ---------------------------------------------------------------------------

describe("stageEntryArgs — fanin over a fanout channel", () => {
	it("skips unfilled (pending) and failed slots, reading survivors in declared order", () => {
		const state = freshState();
		const a0 = fakeArtifact("0.md");
		const a3 = fakeArtifact("3.md");
		// Pre-sized channel: [ok, pending, failed, ok]
		state.named.audits = [
			fakeOutput([a0]),
			undefined,
			failedOutput(meta, "unit 2 failed"),
			fakeOutput([a3]),
		] as unknown as Output[];

		const args = stageEntryArgs(faninReaderDef(), "synthesize", "scan", state);

		// Only the two real entries contribute --audits flags, in index order.
		expect(args).toBe(`--audits ${handleToString(a0.handle)} --audits ${handleToString(a3.handle)}`);
	});

	it("ALL-FAILED channel yields a DEFINED empty arg string, never undefined (all-failed contract)", () => {
		const state = freshState();
		// Every slot failed/unfilled — synthesis still runs, with zero --name args.
		state.named.audits = [failedOutput(meta, "f0"), undefined, failedOutput(meta, "f2")] as unknown as Output[];

		const args = stageEntryArgs(faninReaderDef(), "synthesize", "scan", state);

		expect(args).toBe(""); // defined, not undefined — inputForStage's `!` stays valid
	});

	it("latest-wins (bare) read scans backward past a failed/pending tail to the last real entry", () => {
		const state = freshState();
		const a0 = fakeArtifact("0.md");
		// Bare-string read = latest-wins; the pre-sized tail is failed/pending, so a
		// blind slot[length-1]! would read the sentinel. lastReal scans back to a0.
		state.named.audits = [fakeOutput([a0]), failedOutput(meta, "f1"), undefined] as unknown as Output[];

		const bareReaderDef = { kind: "produces", sessionPolicy: "fresh", reads: ["audits"] } as StageDef;
		const args = stageEntryArgs(bareReaderDef, "synthesize", "scan", state);

		expect(args).toBe(`--audits ${handleToString(a0.handle)}`);
	});

	it("multi-artifact survivor repeats the flag per artifact", () => {
		const state = freshState();
		const a = fakeArtifact("a.md");
		const b = fakeArtifact("b.md");
		state.named.audits = [fakeOutput([a, b]), failedOutput(meta, "f")] as unknown as Output[];

		const args = stageEntryArgs(faninReaderDef(), "synthesize", "scan", state);

		expect(args).toBe(`--audits ${handleToString(a.handle)} --audits ${handleToString(b.handle)}`);
	});
});
