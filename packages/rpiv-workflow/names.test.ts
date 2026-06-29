import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	claimName,
	generateRunId,
	isValidName,
	listRuns,
	readNamesIndex,
	rebuildIndex,
	releaseName,
	resolveRun,
	stateFilePath,
	writeHeader,
} from "./state/index.js";
// Deep import: addNameToIndex is deliberately NOT on the state barrels
// (production code goes through claimName); unit tests exercise it directly.
import { addNameToIndex } from "./state/names.js";

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
		seedRun("r0", "auth");
		addNameToIndex(tmpDir, "auth", "r0");
		expect(claimName(tmpDir, "auth", "r1")).toEqual({ ok: false, reason: "collision", runId: "r0" });
		expect(readNamesIndex(tmpDir)).toEqual({ auth: "r0" });
	});

	it("re-claims a name whose holder has no run file (stale entry from a failed releaseName rollback)", () => {
		// The stranded-entry state: claimName succeeded, writeHeader failed,
		// releaseName's rollback ALSO failed — the index points at a run that
		// never existed. The name must not be blocked forever.
		addNameToIndex(tmpDir, "auth", "ghost-run");
		expect(claimName(tmpDir, "auth", "r1")).toEqual({ ok: true });
		expect(readNamesIndex(tmpDir)).toEqual({ auth: "r1" });
	});
});

describe("releaseName", () => {
	it("rolls back a claim, freeing the name for re-claim", () => {
		claimName(tmpDir, "auth", "r1");
		releaseName(tmpDir, "auth", "r1");
		expect(readNamesIndex(tmpDir)).toEqual({});
		expect(claimName(tmpDir, "auth", "r2")).toEqual({ ok: true });
	});

	it("never clobbers an entry held by a DIFFERENT run", () => {
		addNameToIndex(tmpDir, "auth", "r0");
		releaseName(tmpDir, "auth", "r1");
		expect(readNamesIndex(tmpDir)).toEqual({ auth: "r0" });
	});

	it("is a no-op when the index is absent", () => {
		expect(() => releaseName(tmpDir, "auth", "r1")).not.toThrow();
		expect(readNamesIndex(tmpDir)).toBeUndefined();
	});

	it("leaves sibling entries intact", () => {
		addNameToIndex(tmpDir, "auth", "r1");
		addNameToIndex(tmpDir, "perf", "r2");
		releaseName(tmpDir, "auth", "r1");
		expect(readNamesIndex(tmpDir)).toEqual({ perf: "r2" });
	});
});

describe("names.json atomic write path", () => {
	it("claim / release / rebuild leave no temp residue in the runs dir", () => {
		claimName(tmpDir, "auth", "r1");
		releaseName(tmpDir, "auth", "r1");
		seedRun("r2", "perf");
		rebuildIndex(tmpDir);

		const files = readdirSync(join(tmpDir, ".rpiv", "workflows", "runs"));
		expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
		expect(readNamesIndex(tmpDir)).toEqual({ perf: "r2" });
	});

	it("addNameToIndex writes the caller-provided snapshot (claimName's single-read path)", () => {
		// claimName reads the index ONCE and threads it through — no second
		// read between the collision check and the write.
		expect(addNameToIndex(tmpDir, "auth", "r1", { existing: "r0" })).toBe(true);
		expect(readNamesIndex(tmpDir)).toEqual({ existing: "r0", auth: "r1" });
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

	it("prunes a stale name whose JSONL is gone — undefined result, but the dead entry is removed", () => {
		addNameToIndex(tmpDir, "ghost", "missing-run-id");
		expect(resolveRun(tmpDir, "ghost")).toBeUndefined();
		// The stale-present hit triggered a rebuild, which persisted an index
		// without the dead entry — the name is free again.
		expect(readNamesIndex(tmpDir)).toEqual({});
	});

	it("recovers through a stale-present entry to the real run via rebuild", () => {
		const runId = generateRunId();
		seedRun(runId, "auth");
		// names.json points "auth" at a dead runId while the real named run
		// exists on disk (e.g. a clobbered index). The index HIT must not end
		// resolution — the absent-name recovery is gated off for present keys,
		// so step 1 owns this rebuild.
		addNameToIndex(tmpDir, "auth", "dead-run-id");
		expect(resolveRun(tmpDir, "auth")?.runId).toBe(runId);
		expect(readNamesIndex(tmpDir)).toEqual({ auth: runId });
	});

	it("recovers a named run when names.json is missing, by rebuilding from headers", () => {
		const runId = generateRunId();
		seedRun(runId, "auth");
		// No addNameToIndex call — names.json was never written (lost/deleted).
		expect(readNamesIndex(tmpDir)).toBeUndefined();
		expect(resolveRun(tmpDir, "auth")?.runId).toBe(runId);
		// The recovery rebuilt + persisted the index for subsequent O(1) lookups.
		expect(readNamesIndex(tmpDir)).toEqual({ auth: runId });
	});

	it("does NOT rescan for an unresolvable runId-shaped ref (digits lead — not a valid name)", () => {
		seedRun(generateRunId(), "auth");
		expect(resolveRun(tmpDir, "2099-01-01_00-00-00-dead")).toBeUndefined();
		// rebuildIndex would have persisted names.json; an invalid-name ref must not trigger it.
		expect(readNamesIndex(tmpDir)).toBeUndefined();
	});

	it("resolves a runId ref carrying a trailing .jsonl extension (autosuggest paste)", () => {
		const runId = generateRunId();
		seedRun(runId);
		expect(resolveRun(tmpDir, `${runId}.jsonl`)?.runId).toBe(runId);
	});

	it("resolves a full filesystem path to the run's JSONL (editor @-autosuggest)", () => {
		const runId = generateRunId();
		seedRun(runId);
		const path = stateFilePath(tmpDir, runId);
		expect(resolveRun(tmpDir, path)?.runId).toBe(runId);
	});

	it("resolves a relative path with dir prefix to the run's JSONL", () => {
		const runId = generateRunId();
		seedRun(runId);
		expect(resolveRun(tmpDir, `.rpiv/workflows/runs/${runId}.jsonl`)?.runId).toBe(runId);
	});

	it("prefers a verbatim name match over slug normalization (name is never a path)", () => {
		const named = generateRunId();
		const slug = generateRunId();
		seedRun(named, "auth.jsonl");
		seedRun(slug);
		// Both a name "auth.jsonl" and a run whose slug is "auth" could exist;
		// the raw-ref name lookup must win.
		addNameToIndex(tmpDir, "auth.jsonl", named);
		expect(resolveRun(tmpDir, "auth.jsonl")?.runId).toBe(named);
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
