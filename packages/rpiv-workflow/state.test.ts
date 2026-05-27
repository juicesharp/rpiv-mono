import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendStage,
	generateRunId,
	listArtifacts,
	listRuns,
	readAllStages,
	readHeader,
	readLastStage,
	stateFilePath,
	type WorkflowHeader,
	type WorkflowStage,
	workflowsDir,
	writeHeader,
} from "./state/index.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-workflow-state-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("generateRunId", () => {
	it("produces slug-format YYYY-MM-DD_HH-MM-SS-<suffix> from local time components", () => {
		const fixed = new Date(2026, /* May */ 4, 20, 15, 30, 45);
		expect(generateRunId(fixed, "abcd")).toBe("2026-05-20_15-30-45-abcd");
	});

	it("pads single-digit months, days, hours, minutes, seconds", () => {
		const fixed = new Date(2026, /* Jan */ 0, 5, 3, 7, 9);
		expect(generateRunId(fixed, "0000")).toBe("2026-01-05_03-07-09-0000");
	});

	it("appends a 4-hex random suffix by default", () => {
		const fixed = new Date(2026, 4, 20, 15, 30, 45);
		expect(generateRunId(fixed)).toMatch(/^2026-05-20_15-30-45-[0-9a-f]{4}$/);
	});

	it("generates distinct ids for two same-second calls (collision protection)", () => {
		const fixed = new Date(2026, 4, 20, 15, 30, 45);
		const ids = new Set(Array.from({ length: 20 }, () => generateRunId(fixed)));
		// 20 calls, 65536 possible suffixes — duplicates are astronomically unlikely.
		expect(ids.size).toBe(20);
	});
});

describe("workflowsDir / stateFilePath", () => {
	it("resolves to .rpiv/workflows under cwd", () => {
		expect(workflowsDir("/project")).toBe("/project/.rpiv/workflows");
	});

	it("resolves state file with .jsonl extension", () => {
		expect(stateFilePath("/project", "2026-05-20_15-30-45")).toBe(
			"/project/.rpiv/workflows/2026-05-20_15-30-45.jsonl",
		);
	});
});

describe("writeHeader + readAllStages + readLastStage", () => {
	it("writes header and reads it back as not-a-stage", () => {
		const header: WorkflowHeader = {
			runId: "2026-05-20_15-30-45",
			workflow: "mid",
			input: "Add dark mode",
			ts: "2026-05-20T15:30:45-0400",
		};
		writeHeader(tmpDir, header);
		expect(readAllStages(tmpDir, header.runId)).toEqual([]);
		expect(readLastStage(tmpDir, header.runId)).toBeUndefined();
	});

	it("appends stages and reads them back", () => {
		const runId = "2026-05-20_15-30-45";
		writeHeader(tmpDir, {
			runId,
			workflow: "mid",
			input: "test",
			ts: "2026-05-20T15:30:45-0400",
		});

		const stage1: WorkflowStage = {
			stageNumber: 1,
			stage: "discover",
			skill: "discover",
			status: "completed",
			ts: "2026-05-20T15:31:00-0400",
		};
		const stage2: WorkflowStage = {
			stageNumber: 2,
			stage: "research",
			skill: "research",
			status: "completed",
			ts: "2026-05-20T15:35:00-0400",
		};

		appendStage(tmpDir, runId, stage1);
		appendStage(tmpDir, runId, stage2);

		const allStages = readAllStages(tmpDir, runId);
		expect(allStages).toHaveLength(2);
		expect(allStages[0]).toEqual(stage1);
		expect(allStages[1]).toEqual(stage2);

		expect(readLastStage(tmpDir, runId)).toEqual(stage2);
	});

	it("records failed stage with no artifact", () => {
		const runId = "2026-05-20_15-30-45";
		writeHeader(tmpDir, {
			runId,
			workflow: "mid",
			input: "test",
			ts: "2026-05-20T15:30:45-0400",
		});

		const failed: WorkflowStage = {
			stageNumber: 3,
			stage: "design",
			skill: "design",
			status: "failed",
			ts: "2026-05-20T15:40:00-0400",
		};
		appendStage(tmpDir, runId, failed);

		const last = readLastStage(tmpDir, runId);
		expect(last).toEqual(failed);
		expect(last?.output).toBeUndefined();
	});
});

describe("fail-soft I/O", () => {
	it("readLastStage returns undefined for missing file", () => {
		expect(readLastStage(tmpDir, "nonexistent")).toBeUndefined();
	});

	it("readAllStages returns empty array for missing file", () => {
		expect(readAllStages(tmpDir, "nonexistent")).toEqual([]);
	});

	it("writeHeader does not throw on impossible path", () => {
		expect(() =>
			writeHeader("/dev/null/impossible", {
				runId: "test",
				workflow: "mid",
				input: "x",
				ts: "2026",
			}),
		).not.toThrow();
	});

	it("appendStage does not throw on impossible path", () => {
		expect(() =>
			appendStage("/dev/null/impossible", "test", {
				stageNumber: 1,
				stage: "discover",
				skill: "discover",
				status: "completed",
				ts: "2026",
			}),
		).not.toThrow();
	});

	it("appendStage returns false on write failure, true on success", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				appendStage("/dev/null/impossible", "test", {
					stageNumber: 1,
					stage: "discover",
					skill: "discover",
					status: "completed",
					ts: "2026",
				}),
			).toBe(false);
			expect(
				appendStage(tmpDir, "ok-run", {
					stageNumber: 1,
					stage: "discover",
					skill: "discover",
					status: "completed",
					ts: "2026",
				}),
			).toBe(true);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("readLastStage logs warning on corrupted file", () => {
		const runId = "corrupt-test";
		writeHeader(tmpDir, { runId, workflow: "mid", input: "test", ts: "2026" });
		appendFileSync(stateFilePath(tmpDir, runId), "NOT-JSON\n", "utf-8");

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(readLastStage(tmpDir, runId)).toBeUndefined();
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[rpiv-workflow] workflow state:"));
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("a corrupt trailing line does NOT erase prior rows (per-line resilience)", () => {
		// Closes I1: pre-fix, a single malformed line at the tail (truncated
		// `appendFileSync`, ENOSPC, network FS hiccup) made readJsonlRows
		// swallow the entire parse error in its outer try/catch and return
		// []. Every successfully-written prior row vanished from the reader's
		// view. Now each line parses in its own try/catch.
		const runId = "partial-write";
		writeHeader(tmpDir, { runId, workflow: "mid", input: "test", ts: "2026" });
		appendStage(tmpDir, runId, {
			stageNumber: 1,
			stage: "research",
			skill: "research",
			status: "completed",
			ts: "2026",
		});
		appendStage(tmpDir, runId, { stageNumber: 2, stage: "design", skill: "design", status: "completed", ts: "2026" });
		// Simulate a truncated trailing line (e.g. process killed mid-append).
		appendFileSync(stateFilePath(tmpDir, runId), '{"stageNumber":3,"skill":"impl', "utf-8");

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const rows = readAllStages(tmpDir, runId);
			expect(rows.map((r) => r.stageNumber)).toEqual([1, 2]);
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("skipping malformed JSONL row"));
		} finally {
			warnSpy.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// Past-runs API — readHeader + listRuns + listArtifacts
// ---------------------------------------------------------------------------

describe("readHeader", () => {
	it("returns the header for a run whose JSONL file exists", () => {
		const runId = "header-roundtrip";
		const header: WorkflowHeader = { runId, workflow: "mid", input: "x", ts: "2026-05-25T10:00:00Z" };
		writeHeader(tmpDir, header);
		expect(readHeader(tmpDir, runId)).toEqual(header);
	});

	it("round-trips trigger metadata for all three RunTrigger kinds", () => {
		const cases: WorkflowHeader[] = [
			{
				runId: "trig-command",
				workflow: "mid",
				input: "x",
				ts: "2026-05-26T10:00:00Z",
				trigger: { kind: "command", name: "wf" },
			},
			{
				runId: "trig-programmatic",
				workflow: "mid",
				input: "x",
				ts: "2026-05-26T10:01:00Z",
				trigger: { kind: "programmatic", source: "test-driver" },
			},
			{
				runId: "trig-external",
				workflow: "mid",
				input: "x",
				ts: "2026-05-26T10:02:00Z",
				trigger: {
					kind: "external",
					source: "github-webhook",
					ref: "deadbeef",
					meta: { eventType: "push" },
				},
			},
		];
		for (const header of cases) {
			writeHeader(tmpDir, header);
			expect(readHeader(tmpDir, header.runId)).toEqual(header);
		}
	});

	it("treats trigger as optional — legacy headers without trigger still parse", () => {
		// Simulate a header written before the trigger field was added.
		const runId = "legacy-no-trigger";
		mkdirSync(workflowsDir(tmpDir), { recursive: true });
		appendFileSync(
			stateFilePath(tmpDir, runId),
			`${JSON.stringify({ runId, workflow: "mid", input: "x", ts: "2026" })}\n`,
			"utf-8",
		);
		const header = readHeader(tmpDir, runId);
		expect(header?.trigger).toBeUndefined();
		expect(header?.runId).toBe(runId);
	});

	it("returns undefined when the file does not exist", () => {
		expect(readHeader(tmpDir, "nonexistent")).toBeUndefined();
	});

	it("returns undefined when the first line is not a valid header", () => {
		const runId = "bad-first-line";
		// Skip writeHeader — append a stage row first so the first line lacks header fields.
		appendStage(tmpDir, runId, {
			stageNumber: 1,
			stage: "research",
			skill: "research",
			status: "completed",
			ts: "2026",
		});
		expect(readHeader(tmpDir, runId)).toBeUndefined();
	});

	it("returns undefined when the first line is malformed JSON (fail-soft)", () => {
		const runId = "garbled";
		mkdirSync(workflowsDir(tmpDir), { recursive: true });
		appendFileSync(stateFilePath(tmpDir, runId), "NOT-JSON\n", "utf-8");
		expect(readHeader(tmpDir, runId)).toBeUndefined();
	});
});

describe("listRuns", () => {
	it("enumerates every <runId>.jsonl in the workflows directory and projects RunSummary", () => {
		const headerA: WorkflowHeader = { runId: "run-a", workflow: "mid", input: "first", ts: "2026-05-25T10:00:00Z" };
		const headerB: WorkflowHeader = {
			runId: "run-b",
			workflow: "large",
			input: "second",
			ts: "2026-05-25T11:00:00Z",
		};
		writeHeader(tmpDir, headerA);
		writeHeader(tmpDir, headerB);

		const runs = listRuns(tmpDir);
		const byId = Object.fromEntries(runs.map((r) => [r.runId, r]));
		expect(Object.keys(byId).sort()).toEqual(["run-a", "run-b"]);
		expect(byId["run-a"]).toEqual({ runId: "run-a", workflow: "mid", input: "first", ts: headerA.ts });
		expect(byId["run-b"]).toEqual({ runId: "run-b", workflow: "large", input: "second", ts: headerB.ts });
	});

	it("returns an empty array when the workflows directory does not exist", () => {
		expect(listRuns(tmpDir)).toEqual([]);
	});

	it("silently skips files whose first line is not a valid header", () => {
		writeHeader(tmpDir, { runId: "good", workflow: "mid", input: "ok", ts: "2026" });
		// Manually write a malformed run file alongside the good one.
		appendFileSync(stateFilePath(tmpDir, "bad"), "NOT-JSON\n", "utf-8");
		const runs = listRuns(tmpDir);
		expect(runs.map((r) => r.runId)).toEqual(["good"]);
	});

	it("ignores non-.jsonl entries in the workflows directory", () => {
		writeHeader(tmpDir, { runId: "good", workflow: "mid", input: "ok", ts: "2026" });
		appendFileSync(join(workflowsDir(tmpDir), "stray.txt"), "ignore me\n", "utf-8");
		const runs = listRuns(tmpDir);
		expect(runs.map((r) => r.runId)).toEqual(["good"]);
	});

	it("projects trigger from header to RunSummary", () => {
		writeHeader(tmpDir, {
			runId: "with-trigger",
			workflow: "mid",
			input: "x",
			ts: "2026",
			trigger: { kind: "external", source: "cron", ref: "0 9 * * *" },
		});
		writeHeader(tmpDir, { runId: "without-trigger", workflow: "mid", input: "x", ts: "2026" });
		const byId = Object.fromEntries(listRuns(tmpDir).map((r) => [r.runId, r]));
		expect(byId["with-trigger"]?.trigger).toEqual({ kind: "external", source: "cron", ref: "0 9 * * *" });
		expect(byId["without-trigger"]?.trigger).toBeUndefined();
	});
});

describe("listArtifacts", () => {
	const mkOutput = (artifacts: Array<{ kind: "fs"; path: string }>) => ({
		kind: "artifact-md",
		artifacts: artifacts.map((handle) => ({ handle })),
		data: {},
		meta: { stage: "x", skill: "x", stageNumber: 1, ts: "2026", runId: "x" },
	});

	it("projects every artifact across stage rows (one entry per artifact, in stage order)", () => {
		const runId = "artifacts-run";
		writeHeader(tmpDir, { runId, workflow: "mid", input: "x", ts: "2026" });
		appendStage(tmpDir, runId, {
			stageNumber: 1,
			stage: "research",
			skill: "research",
			status: "completed",
			ts: "2026",
			output: mkOutput([{ kind: "fs", path: ".rpiv/artifacts/research/r.md" }]),
		});
		// Stage without artifacts — should NOT appear in the list.
		appendStage(tmpDir, runId, { stageNumber: 2, stage: "commit", skill: "commit", status: "completed", ts: "2026" });
		appendStage(tmpDir, runId, {
			stageNumber: 3,
			stage: "design",
			skill: "design",
			status: "completed",
			ts: "2026",
			output: mkOutput([{ kind: "fs", path: ".rpiv/artifacts/design/d.md" }]),
		});

		expect(listArtifacts(tmpDir, runId)).toEqual([
			{
				stage: "research",
				skill: "research",
				artifact: { handle: { kind: "fs", path: ".rpiv/artifacts/research/r.md" } },
			},
			{
				stage: "design",
				skill: "design",
				artifact: { handle: { kind: "fs", path: ".rpiv/artifacts/design/d.md" } },
			},
		]);
	});

	it("returns an empty array when no stage row carries an artifact", () => {
		const runId = "no-artifacts";
		writeHeader(tmpDir, { runId, workflow: "mid", input: "x", ts: "2026" });
		appendStage(tmpDir, runId, { stageNumber: 1, stage: "commit", skill: "commit", status: "completed", ts: "2026" });
		expect(listArtifacts(tmpDir, runId)).toEqual([]);
	});
});
