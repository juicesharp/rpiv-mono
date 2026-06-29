import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendLoopCap,
	appendStage,
	generateRunId,
	type LoopCapRow,
	listArtifacts,
	listRuns,
	readAllStages,
	readAllStagesForResume,
	readHeader,
	readLastStage,
	readLoopCaps,
	runsDir,
	stateFilePath,
	type WorkflowHeader,
	type WorkflowStage,
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

describe("runsDir / stateFilePath", () => {
	it("resolves to .rpiv/workflows/runs under cwd", () => {
		expect(runsDir("/project")).toBe("/project/.rpiv/workflows/runs");
	});

	it("resolves state file with .jsonl extension", () => {
		expect(stateFilePath("/project", "2026-05-20_15-30-45")).toBe(
			"/project/.rpiv/workflows/runs/2026-05-20_15-30-45.jsonl",
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
			session: null,
			stageNumber: 1,
			stage: "discover",
			skill: "discover",
			status: "completed",
			ts: "2026-05-20T15:31:00-0400",
		};
		const stage2: WorkflowStage = {
			session: null,
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
			session: null,
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

describe("loop-cap rows + unit-identity fields", () => {
	it("round-trips a loop-cap row via appendLoopCap → readLoopCaps", () => {
		const runId = "2026-05-20_15-30-45";
		writeHeader(tmpDir, { runId, workflow: "mid", input: "x", ts: "2026" });
		const row: LoopCapRow = { type: "loop-cap", stage: "breakdown", count: 5, max: 5, ts: "2026" };
		expect(appendLoopCap(tmpDir, runId, row)).toBe(true);
		expect(readLoopCaps(tmpDir, runId)).toEqual([row]);
	});

	it("stage readers skip loop-cap rows (shape-discriminated, not positional)", () => {
		const runId = "skip-loop-cap";
		writeHeader(tmpDir, { runId, workflow: "mid", input: "x", ts: "2026" });
		const stage: WorkflowStage = {
			session: null,
			stageNumber: 1,
			stage: "breakdown",
			skill: "breakdown",
			status: "completed",
			ts: "2026",
		};
		appendStage(tmpDir, runId, stage);
		appendLoopCap(tmpDir, runId, { type: "loop-cap", stage: "breakdown", count: 8, max: 8, ts: "2026" });

		// readAllStages / readLastStage skip the loop-cap row untouched.
		expect(readAllStages(tmpDir, runId)).toEqual([stage]);
		expect(readLastStage(tmpDir, runId)).toEqual(stage);
		// readLoopCaps only sees the cap row, never the stage row.
		expect(readLoopCaps(tmpDir, runId)).toEqual([
			{ type: "loop-cap", stage: "breakdown", count: 8, max: 8, ts: "2026" },
		]);
	});

	it("rows carrying the four unit-identity fields round-trip through readAllStages", () => {
		const runId = "unit-fields";
		writeHeader(tmpDir, { runId, workflow: "mid", input: "x", ts: "2026" });
		const unitRow: WorkflowStage = {
			session: null,
			stageNumber: 4,
			stage: "implement (phase-2)",
			skill: "implement",
			status: "completed",
			ts: "2026",
			parent: "implement",
			role: "produce",
			unitId: "phase-2",
			unitIndex: 1,
		};
		appendStage(tmpDir, runId, unitRow);
		// isWorkflowStage filters on stageNumber + stage only, so the unit row passes
		// through unchanged with all four structured fields intact.
		expect(readAllStages(tmpDir, runId)).toEqual([unitRow]);
	});

	it("preserves unit-identity fields on a failure row", () => {
		const runId = "unit-failure";
		writeHeader(tmpDir, { runId, workflow: "mid", input: "x", ts: "2026" });
		const failed: WorkflowStage = {
			session: null,
			stageNumber: 2,
			stage: "implement (phase-3)",
			skill: "implement",
			status: "failed",
			ts: "2026",
			errMsg: "implement failed",
			parent: "implement",
			role: "produce",
			unitId: "phase-3",
			unitIndex: 2,
		};
		appendStage(tmpDir, runId, failed);
		expect(readLastStage(tmpDir, runId)).toEqual(failed);
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
				session: null,
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
					session: null,
					stageNumber: 1,
					stage: "discover",
					skill: "discover",
					status: "completed",
					ts: "2026",
				}),
			).toBe(false);
			expect(
				appendStage(tmpDir, "ok-run", {
					session: null,
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
		// Previously, a single malformed line at the tail (truncated
		// `appendFileSync`, ENOSPC, network FS hiccup) made readJsonlRows
		// swallow the entire parse error in its outer try/catch and return
		// []. Every successfully-written prior row vanished from the reader's
		// view. Now each line parses in its own try/catch.
		const runId = "partial-write";
		writeHeader(tmpDir, { runId, workflow: "mid", input: "test", ts: "2026" });
		appendStage(tmpDir, runId, {
			session: null,
			stageNumber: 1,
			stage: "research",
			skill: "research",
			status: "completed",
			ts: "2026",
		});
		appendStage(tmpDir, runId, {
			session: null,
			stageNumber: 2,
			stage: "design",
			skill: "design",
			status: "completed",
			ts: "2026",
		});
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
		mkdirSync(runsDir(tmpDir), { recursive: true });
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
			session: null,
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
		mkdirSync(runsDir(tmpDir), { recursive: true });
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
		appendFileSync(join(runsDir(tmpDir), "stray.txt"), "ignore me\n", "utf-8");
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
			session: null,
			stageNumber: 1,
			stage: "research",
			skill: "research",
			status: "completed",
			ts: "2026",
			output: mkOutput([{ kind: "fs", path: ".rpiv/artifacts/research/r.md" }]),
		});
		// Stage without artifacts — should NOT appear in the list.
		appendStage(tmpDir, runId, {
			session: null,
			stageNumber: 2,
			stage: "commit",
			skill: "commit",
			status: "completed",
			ts: "2026",
		});
		appendStage(tmpDir, runId, {
			session: null,
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
		appendStage(tmpDir, runId, {
			session: null,
			stageNumber: 1,
			stage: "commit",
			skill: "commit",
			status: "completed",
			ts: "2026",
		});
		expect(listArtifacts(tmpDir, runId)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Deep stage guard + resume-grade strict reader
// ---------------------------------------------------------------------------

describe("deep stage guard + readAllStagesForResume", () => {
	const runId = "t9-run";
	const seed = () => {
		writeHeader(tmpDir, { runId, workflow: "mid", input: "x", ts: "2026" });
		appendStage(tmpDir, runId, {
			session: null,
			stageNumber: 1,
			stage: "plan",
			skill: "plan",
			status: "completed",
			ts: "t1",
		});
	};
	const appendRaw = (row: Record<string, unknown>) =>
		appendFileSync(stateFilePath(tmpDir, runId), `${JSON.stringify(row)}\n`, "utf-8");

	it("readAllStages SKIPS a row whose status is outside the enum; the strict reader REFUSES", () => {
		seed();
		appendRaw({ stageNumber: 2, stage: "build", skill: "build", status: "exploded", ts: "t2" });

		expect(readAllStages(tmpDir, runId).map((s) => s.stage)).toEqual(["plan"]);
		const strict = readAllStagesForResume(tmpDir, runId);
		expect(strict.ok).toBe(false);
		if (strict.ok) return;
		expect(strict.detail).toContain('stage row 2 ("build")');
	});

	it("refuses a row whose output lacks an artifacts array (downstream indexes it)", () => {
		seed();
		appendRaw({ stageNumber: 2, stage: "build", status: "completed", ts: "t2", output: "oops" });
		const strict = readAllStagesForResume(tmpDir, runId);
		expect(strict.ok).toBe(false);
	});

	it("refuses a unit row (parent set) missing its numeric unitIndex (the drift guard compares it)", () => {
		seed();
		appendRaw({ stageNumber: 2, stage: "build (u1)", status: "completed", ts: "t2", parent: "build" });
		const strict = readAllStagesForResume(tmpDir, runId);
		expect(strict.ok).toBe(false);
	});

	it("non-stage rows (header / routing / loop-cap) never trip the strict reader", () => {
		seed();
		appendRaw({ type: "routing", fromStageIndex: 1, fromStage: "plan", decision: "build", ts: "t2" });
		appendRaw({ type: "loop-cap", stage: "build", count: 3, max: 3, ts: "t3" });
		const strict = readAllStagesForResume(tmpDir, runId);
		expect(strict.ok).toBe(true);
		if (!strict.ok) return;
		expect(strict.rows.map((s) => s.stage)).toEqual(["plan"]);
	});

	it("REFUSES a pre-feature row missing the session key; readAllStages stays lenient", () => {
		seed();
		// A row written before session provenance existed — no `session` key.
		appendRaw({ stageNumber: 2, stage: "build", skill: "build", status: "completed", ts: "t2" });

		// Display reader keeps rendering the row (shape-filter on stageNumber).
		expect(readAllStages(tmpDir, runId).map((s) => s.stage)).toEqual(["plan", "build"]);
		// Resume reader refuses — the fold must not replay provenance-less rows.
		const strict = readAllStagesForResume(tmpDir, runId);
		expect(strict.ok).toBe(false);
		if (strict.ok) return;
		expect(strict.detail).toContain('stage row 2 ("build")');
	});

	it("refuses a session object missing its id; accepts null and { id }", () => {
		seed();
		appendStage(tmpDir, runId, {
			stageNumber: 2,
			stage: "build",
			skill: "build",
			status: "completed",
			ts: "t2",
			session: { id: "sess-1", file: "/tmp/x.jsonl", branchOffset: 4 },
		});
		expect(readAllStagesForResume(tmpDir, runId).ok).toBe(true);

		// An orphan file/branchOffset without an id is malformed.
		appendRaw({ stageNumber: 3, stage: "deploy", status: "completed", ts: "t3", session: { file: "/tmp/x.jsonl" } });
		expect(readAllStagesForResume(tmpDir, runId).ok).toBe(false);
	});

	it("round-trips the SessionRef value verbatim (wire shape = domain shape)", () => {
		seed();
		const ref = { id: "sess-1", file: "/tmp/sessions/a_sess-1.jsonl", branchOffset: 7 };
		appendStage(tmpDir, runId, {
			stageNumber: 2,
			stage: "build",
			skill: "build",
			status: "completed",
			ts: "t2",
			session: ref,
		});
		const strict = readAllStagesForResume(tmpDir, runId);
		expect(strict.ok).toBe(true);
		if (!strict.ok) return;
		expect(strict.rows[1]?.session).toEqual(ref);
		expect(strict.rows[0]?.session).toBeNull();
	});

	it("a clean trail round-trips identically through both readers", () => {
		seed();
		appendStage(tmpDir, runId, {
			session: null,
			stageNumber: 2,
			stage: "build (u1)",
			skill: "build",
			status: "failed",
			ts: "t2",
			errMsg: "boom",
			parent: "build",
			role: "produce",
			unitId: "u1",
			unitIndex: 0,
		});
		const strict = readAllStagesForResume(tmpDir, runId);
		expect(strict.ok).toBe(true);
		if (!strict.ok) return;
		expect(strict.rows).toEqual(readAllStages(tmpDir, runId));
		expect(strict.rows).toHaveLength(2);
	});
});
