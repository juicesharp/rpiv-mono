/**
 * `state/raw.ts` — the LEAF fs primitives under the state readers (`reads.ts`)
 * and the names index (`names.ts`): the bounded `readFirstJsonlLine` prefix
 * read + `enumerateRunIds`. Also exercises `state/paths.ts:runFileFor`.
 *
 * Focus: the read paths that the header/stage round-trip tests in
 * `state.test.ts` don't reach because they always write a newline-terminated
 * header — namely the EOF-before-newline branch of `readFirstJsonlLine`
 * (lines that bound the prefix read when a file has content but no trailing
 * newline), plus enumerateRunIds' missing-dir and non-jsonl filtering.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFileFor, runsDir, stateFilePath } from "./paths.js";
import { enumerateRunIds, readFirstJsonlLine } from "./raw.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-workflow-raw-"));
	mkdirSync(runsDir(tmpDir), { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("readFirstJsonlLine", () => {
	it("returns undefined when the run file does not exist", () => {
		expect(readFirstJsonlLine(tmpDir, "nope")).toBeUndefined();
	});

	it("reads the first JSONL line of a run file", () => {
		const header = { runId: "r1", workflow: "mid", input: "go", ts: "2026-07-03T00:00:00Z" };
		writeFileSync(stateFilePath(tmpDir, "r1"), `${JSON.stringify(header)}\n{"stageNumber":1}\n`);
		expect(readFirstJsonlLine(tmpDir, "r1")).toEqual(header);
	});

	it("returns the first line even when the file has content but no trailing newline (EOF path)", () => {
		// A header shorter than the chunk size with NO newline: the read loop
		// pushes the chunk, advances total, then breaks on the n < chunk EOF.
		const header = { runId: "r2", workflow: "mid", input: "go", ts: "2026-07-03T00:00:00Z" };
		writeFileSync(stateFilePath(tmpDir, "r2"), JSON.stringify(header));
		expect(readFirstJsonlLine(tmpDir, "r2")).toEqual(header);
	});

	it("returns undefined for an empty file", () => {
		writeFileSync(stateFilePath(tmpDir, "empty"), "");
		expect(readFirstJsonlLine(tmpDir, "empty")).toBeUndefined();
	});

	it("returns undefined when the first line is not valid JSON", () => {
		writeFileSync(stateFilePath(tmpDir, "bad"), "not-json\n");
		expect(readFirstJsonlLine(tmpDir, "bad")).toBeUndefined();
	});
});

describe("enumerateRunIds", () => {
	it("lists run ids from .jsonl files in filesystem order, stripped of the extension", () => {
		writeFileSync(stateFilePath(tmpDir, "r-a"), "{}\n");
		writeFileSync(stateFilePath(tmpDir, "r-b"), "{}\n");
		writeFileSync(join(runsDir(tmpDir), "names.json"), "{}\n");
		expect(enumerateRunIds(tmpDir)).toEqual(["r-a", "r-b"]);
	});

	it("returns an empty array when the runs directory exists but holds no run files", () => {
		expect(enumerateRunIds(tmpDir)).toEqual([]);
	});
});

describe("runFileFor", () => {
	it("returns the state file path for a runId-bearing object", () => {
		expect(runFileFor(tmpDir, { runId: "r1" })).toBe(stateFilePath(tmpDir, "r1"));
	});
});
