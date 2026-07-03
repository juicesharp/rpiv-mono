/**
 * Strategy-table unit tests — the corrupted-cursor guards in the assess
 * `pull`. These states are unreachable through the driver (`advanceCursor`
 * assigns `lastProduce` before any state that implies it, and the resume
 * fold's shape guards refuse corrupted trails), so the guards are exercised
 * directly against hand-corrupted cursors: the pin is that an impossible
 * cursor surfaces as a stage-attributed `StagePreflightError`, never a bare
 * `TypeError`. Driver behavior itself is covered end-to-end in loop.test.ts.
 */

import { describe, expect, it } from "vitest";
import type { AssessLoop, LoopDef, StageDef } from "./api.js";
import { fs as fsHandle } from "./handle.js";
import { pendingFanoutIndices } from "./loop.js";
import {
	buildUnitSession,
	foldFanoutCompletion,
	freshCursor,
	type LoopCursor,
	type LoopEntry,
	type NextStep,
	sequentialStrategyOf,
} from "./loop-kinds.js";
import type { Output } from "./output.js";
import { StagePreflightError } from "./stage-errors.js";
import type { RunContext, RunState } from "./types.js";

const output = (artifacts: Output["artifacts"] = [{ handle: fsHandle("a.md"), role: "primary" }]): Output => ({
	kind: "artifacts",
	artifacts,
	data: {},
	meta: { skill: "draft", ts: "2026-06-11T00:00:00Z" } as Output["meta"],
});

const assessLoop = (judgeSkill?: string): AssessLoop =>
	({
		kind: "assess",
		max: 8,
		judge: { skill: judgeSkill, outcome: { name: "verdict" } },
		done: () => false,
		feedForward: () => "refine",
		onCap: "fail",
		result: "last",
	}) as unknown as AssessLoop;

const entryFor = (loop: AssessLoop): LoopEntry => ({
	stageIdx: 0,
	name: "draft",
	skill: "draft",
	def: { kind: "produces" } as StageDef,
	loop,
	entryArtifact: undefined,
	entryArgs: "go",
	entryPair: { output: undefined, primaryArtifact: undefined },
});

const cursorAt = (overrides: Partial<LoopCursor>): LoopCursor => ({
	index: 1,
	accumulated: [],
	phase: "produce",
	ranThisInvocation: 0,
	...overrides,
});

const run = { cwd: "/tmp", state: {} } as unknown as RunContext;

describe("assess strategy — corrupted-cursor guards", () => {
	it("judge phase with no lastProduce throws a stage-attributed preflight error, not a TypeError", async () => {
		const loop = assessLoop("review");
		const pull = sequentialStrategyOf("assess").pull(entryFor(loop), cursorAt({ phase: "judge" }), 8, run);
		await expect(pull).rejects.toThrow(StagePreflightError);
		await expect(pull).rejects.toThrow(/loop stage draft: cursor invariant violated/);
	});

	it("judge skill dispatch with a produce that carried no artifact throws the same invariant class", async () => {
		const loop = assessLoop("review");
		const cursor = cursorAt({ phase: "judge", lastProduce: { output: output([]), artifact: undefined } });
		const pull = sequentialStrategyOf("assess").pull(entryFor(loop), cursor, 8, run);
		await expect(pull).rejects.toThrow(StagePreflightError);
		await expect(pull).rejects.toThrow(/no produced artifact/);
	});

	it("feedForward round with a verdict but no lastProduce throws instead of dereferencing undefined", async () => {
		const loop = assessLoop("review");
		const cursor = cursorAt({ phase: "produce", lastVerdict: output() });
		const pull = sequentialStrategyOf("assess").pull(entryFor(loop), cursor, 8, run);
		await expect(pull).rejects.toThrow(StagePreflightError);
		await expect(pull).rejects.toThrow(/no completed produce on the cursor/);
	});
});

describe("buildUnitSession — collectAll is fanout-only (F1 regression)", () => {
	// A minimal-but-real RunContext: buildUnitSession assembles a StageSession (no
	// I/O) reading these fields via runIdentityOf / resolveModel.
	const runFull = {
		cwd: "/tmp",
		runId: "r1",
		state: {} as RunState,
		lifecycle: {} as RunContext["lifecycle"],
		workflow: { name: "wf" },
		totalStages: 1,
		trigger: { kind: "command" },
		skillContracts: undefined,
	} as unknown as RunContext;

	const unit = (): Extract<NextStep, { kind: "unit" }> => ({
		kind: "unit",
		role: "produce",
		tag: "u0",
		id: "u0",
		label: "u0",
		skill: "draft",
		prompt: "go",
		def: { kind: "produces" } as StageDef,
	});

	const entryWith = (loop: LoopDef): LoopEntry => ({
		stageIdx: 0,
		name: "draft",
		skill: "draft",
		def: { kind: "produces" } as StageDef,
		loop,
		entryArtifact: undefined,
		entryArgs: "go",
		entryPair: { output: undefined, primaryArtifact: undefined },
	});

	const collectAllFor = (loop: LoopDef): boolean =>
		buildUnitSession(entryWith(loop), unit(), 0, runFull, undefined, undefined, async () => {}).collectAll === true;

	it("fanout (default) collects all", () => {
		expect(collectAllFor({ kind: "fanout" } as unknown as LoopDef)).toBe(true);
	});

	it("fanout({ failFast: true }) does NOT collect all", () => {
		expect(collectAllFor({ kind: "fanout", failFast: true } as unknown as LoopDef)).toBe(false);
	});

	it("iterate units NEVER collect all (they advance the cursor)", () => {
		expect(collectAllFor({ kind: "iterate" } as unknown as LoopDef)).toBe(false);
	});

	it("assess units NEVER collect all (they advance the cursor)", () => {
		expect(collectAllFor({ kind: "assess" } as unknown as LoopDef)).toBe(false);
	});
});

describe("fanout cursor vocabulary — filledCount is a count, index stays the pointer", () => {
	const def = { kind: "produces" } as StageDef;
	const throwaway = () => ({ named: {}, primaryArtifact: undefined }) as RunState;

	it("foldFanoutCompletion tracks filledCount (count) and leaves index untouched, even on a non-contiguous fold", () => {
		const cursor = freshCursor();
		// Parallel completion: slots 0 and 2 fold before slot 1 (out of declared order).
		foldFanoutCompletion(throwaway(), cursor, def, "fan", 0, 3, output());
		foldFanoutCompletion(throwaway(), cursor, def, "fan", 2, 3, output());

		expect(cursor.filledCount).toBe(2); // COUNT of filled slots
		expect(cursor.index).toBe(0); // POINTER unchanged by the fold (≠ filledCount)
		expect(pendingFanoutIndices(cursor, 3)).toEqual([1]); // pending derived from slots, not the count
	});
});
