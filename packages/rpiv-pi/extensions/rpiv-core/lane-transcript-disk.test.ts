/**
 * lane-transcript-disk tests — the durable on-disk transcript fallback (Problem 2).
 *
 * A real session is written through the SDK's own SessionManager (no hand-crafted
 * jsonl), then re-opened via loadBranchFromDisk to prove the round-trip: path
 * resolution (recorded lastSessionFile vs run-dir glob), the rendered branch, and
 * fail-soft degradation on a missing/garbage file.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { makeAssistantMessage, makeUserMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBranchFromDisk } from "./lane-transcript-disk.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "rpiv-disk-"));
});
afterEach(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Persist a real session under `sessionDir` and return its file path. */
function writeSession(cwd: string, sessionDir: string, assistantText: string): string {
	mkdirSync(sessionDir, { recursive: true });
	const mgr = SessionManager.create(cwd, sessionDir);
	mgr.appendMessage(makeUserMessage("a user turn"));
	mgr.appendMessage(makeAssistantMessage({ text: assistantText }));
	const file = mgr.getSessionFile();
	if (!file) throw new Error("session was not persisted");
	return file;
}

describe("loadBranchFromDisk", () => {
	it("loads the branch from the recorded lastSessionFile (preferred path)", () => {
		const file = writeSession(tmp, join(tmp, "sessions"), "DISK_TRANSCRIPT_MARKER");
		const disk = loadBranchFromDisk("run-x", file, tmp);
		expect(disk).toBeDefined();
		expect(disk?.entries.length).toBeGreaterThan(0);
		expect(disk?.source.cwd).toBe(tmp); // cwd from the session header
		expect(JSON.stringify(disk?.entries)).toContain("DISK_TRANSCRIPT_MARKER");
		// Tool defs degrade to the built-in fallback (no live session).
		expect(disk?.source.toolDef("anything")).toBeUndefined();
	});

	it("globs the run's session dir (newest jsonl) when no lastSessionFile is given", () => {
		const runId = "2026-06-24_10-00-00-abcd";
		// runId IS the run-dir name — childSessionsDir layout under cwd.
		const sessionDir = join(tmp, ".rpiv", "workflows", "runs", runId, "sessions");
		writeSession(tmp, sessionDir, "GLOBBED_TRANSCRIPT");
		const disk = loadBranchFromDisk(runId, undefined, tmp);
		expect(disk).toBeDefined();
		expect(JSON.stringify(disk?.entries)).toContain("GLOBBED_TRANSCRIPT");
	});

	it("returns undefined when nothing resolves (no dir, no file)", () => {
		expect(loadBranchFromDisk("no-such-run", undefined, tmp)).toBeUndefined();
		// A recorded path that doesn't exist falls through to the (absent) glob dir.
		expect(loadBranchFromDisk("no-such-run", join(tmp, "ghost.jsonl"), tmp)).toBeUndefined();
	});

	it("is fail-soft on a garbage jsonl → undefined (never throws)", () => {
		const file = join(tmp, "garbage.jsonl");
		writeFileSync(file, "not json at all\n{broken\n");
		expect(() => loadBranchFromDisk("run-x", file, tmp)).not.toThrow();
		expect(loadBranchFromDisk("run-x", file, tmp)).toBeUndefined();
	});
});
