/**
 * verdict-outcome — the verdict channel factory's contract: three fields
 * (name / directory collector / `jsonBodyParser` by reference), so parsed
 * channel data is byte-identical to the bare parser's output — including
 * its fatal arm on malformed JSON.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fs as fsHandle, jsonBodyParser, type ParseContext } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verdictOutcome } from "./verdict-outcome.js";

const ctxOf = (cwd: string, runId: string, rel: string): ParseContext => ({
	cwd,
	runId,
	stageIndex: 0,
	state: {} as never,
	branch: [],
	branchOffset: undefined,
	snapshot: undefined,
	skill: "grade",
	artifacts: [{ handle: fsHandle(rel) }],
});

const parse = async (name: string, ctx: ParseContext) => {
	const outcome = verdictOutcome(name, "plans");
	if (!outcome.parser) throw new Error("verdictOutcome carries no parser");
	return outcome.parser.parse(ctx);
};

describe("verdictOutcome", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-verdict-outcome-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("publishes under its channel name and wires the disk-first collector over the source channel", () => {
		const outcome = verdictOutcome("plan-verdicts", "plans");
		expect(outcome.name).toBe("plan-verdicts");
		expect(outcome.collector).toBeDefined();
		expect(outcome.parser).toBe(jsonBodyParser);
	});

	it("delegates the fatal on malformed JSON", async () => {
		const file = "p__correctness__broken.json";
		writeFileSync(join(tmpDir, file), "{ not json");
		const result = await parse("plan-verdicts", ctxOf(tmpDir, "run-1", file));
		expect(result.kind).toBe("fatal");
	});
});
