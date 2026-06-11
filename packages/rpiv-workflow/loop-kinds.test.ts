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
import type { AssessLoop, StageDef } from "./api.js";
import { fs as fsHandle } from "./handle.js";
import { type LoopCursor, type LoopEntry, loopStrategyOf } from "./loop-kinds.js";
import type { Output } from "./output.js";
import { StagePreflightError } from "./runner/errors.js";
import type { RunContext } from "./types.js";

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
		const pull = loopStrategyOf("assess").pull(entryFor(loop), cursorAt({ phase: "judge" }), 8, run);
		await expect(pull).rejects.toThrow(StagePreflightError);
		await expect(pull).rejects.toThrow(/loop stage draft: cursor invariant violated/);
	});

	it("judge skill dispatch with a produce that carried no artifact throws the same invariant class", async () => {
		const loop = assessLoop("review");
		const cursor = cursorAt({ phase: "judge", lastProduce: { output: output([]), artifact: undefined } });
		const pull = loopStrategyOf("assess").pull(entryFor(loop), cursor, 8, run);
		await expect(pull).rejects.toThrow(StagePreflightError);
		await expect(pull).rejects.toThrow(/no produced artifact/);
	});

	it("feedForward round with a verdict but no lastProduce throws instead of dereferencing undefined", async () => {
		const loop = assessLoop("review");
		const cursor = cursorAt({ phase: "produce", lastVerdict: output() });
		const pull = loopStrategyOf("assess").pull(entryFor(loop), cursor, 8, run);
		await expect(pull).rejects.toThrow(StagePreflightError);
		await expect(pull).rejects.toThrow(/no completed produce on the cursor/);
	});
});
