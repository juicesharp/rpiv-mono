import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addNameToIndex,
	claimName,
	generateRunId,
	isValidName,
	listRuns,
	readNamesIndex,
	rebuildIndex,
	resolveRun,
	writeHeader,
} from "./state/index.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-workflow-names-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function seedRun(runId: string, name?: string): void {
	writeHeader(tmpDir, { runId, workflow: "mid", input: "go", ts: "2026-06-05T00:00:00Z", name });
}

describe("readNamesIndex / addNameToIndex", () => {
	it("returns undefined when names.json is absent", () => {
		expect(readNamesIndex(tmpDir)).toBeUndefined();
	});

	it("round-trips a name → runId mapping", () => {
		expect(addNameToIndex(tmpDir, "auth", "r1")).toBe(true);
		expect(readNamesIndex(tmpDir)).toEqual({ auth: "r1" });
	});

	it("accumulates multiple names", () => {
		addNameToIndex(tmpDir, "auth", "r1");
		addNameToIndex(tmpDir, "perf", "r2");
		expect(readNamesIndex(tmpDir)).toEqual({ auth: "r1", perf: "r2" });
	});
});

describe("isValidName", () => {
	it("accepts well-formed names", () => {
		for (const ok of ["auth", "_x", "A1", "auth-spike_2", "a".repeat(64)]) {
			expect(isValidName(ok)).toBe(true);
		}
	});

	it("rejects malformed names", () => {
		for (const bad of ["", "1lead", "-lead", "has space", "bang!", "a".repeat(65)]) {
			expect(isValidName(bad)).toBe(false);
		}
	});
});

describe("claimName", () => {
	it("reserves a valid, unused name and persists it", () => {
		expect(claimName(tmpDir, "auth", "r1")).toEqual({ ok: true });
		expect(readNamesIndex(tmpDir)).toEqual({ auth: "r1" });
	});

	it("rejects an invalid name and writes NOTHING", () => {
		expect(claimName(tmpDir, "1bad", "r1")).toEqual({ ok: false, reason: "invalid" });
		expect(readNamesIndex(tmpDir)).toBeUndefined();
	});

	it("rejects a collision, names the holding runId, and leaves the index untouched", () => {
		addNameToIndex(tmpDir, "auth", "r0");
		expect(claimName(tmpDir, "auth", "r1")).toEqual({ ok: false, reason: "collision", runId: "r0" });
		expect(readNamesIndex(tmpDir)).toEqual({ auth: "r0" });
	});
});

describe("resolveRun", () => {
	it("resolves a human-readable name to its header", () => {
		const runId = generateRunId();
		seedRun(runId, "auth");
		addNameToIndex(tmpDir, "auth", runId);
		expect(resolveRun(tmpDir, "auth")?.runId).toBe(runId);
	});

	it("falls back to a literal runId when the ref is not a known name", () => {
		const runId = generateRunId();
		seedRun(runId);
		expect(resolveRun(tmpDir, runId)?.runId).toBe(runId);
	});

	it("returns undefined for a stale name whose JSONL was deleted (literal fallback also misses)", () => {
		addNameToIndex(tmpDir, "ghost", "missing-run-id");
		expect(resolveRun(tmpDir, "ghost")).toBeUndefined();
	});
});

describe("rebuildIndex", () => {
	it("reconstructs the index from JSONL headers, skipping unnamed runs", () => {
		const named = generateRunId();
		const unnamed = generateRunId();
		seedRun(named, "auth");
		seedRun(unnamed);
		expect(rebuildIndex(tmpDir)).toEqual({ auth: named });
	});

	it("warns on duplicate names and keeps the last writer", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		seedRun("2026-06-05_00-00-01-aaaa", "dup");
		seedRun("2026-06-05_00-00-02-bbbb", "dup");
		const index = rebuildIndex(tmpDir);
		expect(index?.dup).toBeDefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("duplicate name 'dup'"));
		warn.mockRestore();
	});
});

describe("listRuns — name field", () => {
	it("surfaces the name on the run summary", () => {
		const runId = generateRunId();
		seedRun(runId, "auth");
		expect(listRuns(tmpDir).find((r) => r.runId === runId)?.name).toBe("auth");
	});
});
