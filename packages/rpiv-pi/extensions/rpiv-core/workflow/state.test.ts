import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendStage,
	generateRunId,
	readAllStages,
	readLastStage,
	resolveStateFile,
	resolveWorkflowsDir,
	type WorkflowHeader,
	type WorkflowStage,
	writeHeader,
} from "./state.js";

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

describe("resolveWorkflowsDir / resolveStateFile", () => {
	it("resolves to .rpiv/workflows under cwd", () => {
		expect(resolveWorkflowsDir("/project")).toBe("/project/.rpiv/workflows");
	});

	it("resolves state file with .jsonl extension", () => {
		expect(resolveStateFile("/project", "2026-05-20_15-30-45")).toBe(
			"/project/.rpiv/workflows/2026-05-20_15-30-45.jsonl",
		);
	});
});

describe("writeHeader + readAllStages + readLastStage", () => {
	it("writes header and reads it back as not-a-stage", () => {
		const header: WorkflowHeader = {
			runId: "2026-05-20_15-30-45",
			preset: "mid",
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
			preset: "mid",
			input: "test",
			ts: "2026-05-20T15:30:45-0400",
		});

		const stage1: WorkflowStage = {
			stageNumber: 1,
			skill: "discover",
			artifact: ".rpiv/artifacts/discover/frd.md",
			status: "completed",
			ts: "2026-05-20T15:31:00-0400",
		};
		const stage2: WorkflowStage = {
			stageNumber: 2,
			skill: "research",
			artifact: ".rpiv/artifacts/research/res.md",
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
			preset: "mid",
			input: "test",
			ts: "2026-05-20T15:30:45-0400",
		});

		const failed: WorkflowStage = {
			stageNumber: 3,
			skill: "design",
			status: "failed",
			ts: "2026-05-20T15:40:00-0400",
		};
		appendStage(tmpDir, runId, failed);

		const last = readLastStage(tmpDir, runId);
		expect(last).toEqual(failed);
		expect(last?.artifact).toBeUndefined();
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
				preset: "mid",
				input: "x",
				ts: "2026",
			}),
		).not.toThrow();
	});

	it("appendStage does not throw on impossible path", () => {
		expect(() =>
			appendStage("/dev/null/impossible", "test", {
				stageNumber: 1,
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
					skill: "discover",
					status: "completed",
					ts: "2026",
				}),
			).toBe(false);
			expect(
				appendStage(tmpDir, "ok-run", {
					stageNumber: 1,
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
		writeHeader(tmpDir, { runId, preset: "mid", input: "test", ts: "2026" });
		appendFileSync(resolveStateFile(tmpDir, runId), "NOT-JSON\n", "utf-8");

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(readLastStage(tmpDir, runId)).toBeUndefined();
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[rpiv-pi] workflow state:"));
		} finally {
			warnSpy.mockRestore();
		}
	});
});
