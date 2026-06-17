/**
 * Tests for locate.ts — id → on-disk session file with the three-rung
 * fallback (exact hint → filename search → header scan → null). Pure
 * node:fs over temp dirs; no Pi involvement.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateSessionFile } from "./locate.js";

describe("locateSessionFile", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rpiv-locate-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const sessionHeader = (id: string) =>
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-06-11T00:00:00Z", cwd: "/x" })}\n`;

	it("fast path: the recorded file still exists → returned verbatim", () => {
		const file = join(dir, "2026-06-11_sess-1.jsonl");
		writeFileSync(file, sessionHeader("sess-1"));
		expect(locateSessionFile({ id: "sess-1", file })).toBe(file);
	});

	it("stale hint: falls back to `*_<id>.jsonl` search in the hint's dirname", () => {
		const actual = join(dir, "renamed-label_sess-1.jsonl");
		writeFileSync(actual, sessionHeader("sess-1"));
		// The hint points at a file that no longer exists; same directory.
		const stale = join(dir, "old-name_sess-1-gone.jsonl");
		expect(locateSessionFile({ id: "sess-1", file: stale })).toBe(actual);
	});

	it("filename-convention drift: falls back to the header scan", () => {
		// Filename does NOT embed the id — only the header line carries it.
		const actual = join(dir, "totally-different-name.jsonl");
		writeFileSync(actual, sessionHeader("sess-1"));
		writeFileSync(join(dir, "other.jsonl"), sessionHeader("sess-2"));
		const stale = join(dir, "gone.jsonl");
		expect(locateSessionFile({ id: "sess-1", file: stale })).toBe(actual);
	});

	it("header scan tolerates corrupt + non-jsonl neighbours", () => {
		writeFileSync(join(dir, "corrupt.jsonl"), "{not json\n");
		writeFileSync(join(dir, "notes.txt"), "irrelevant");
		const actual = join(dir, "real.jsonl");
		writeFileSync(actual, sessionHeader("sess-1"));
		expect(locateSessionFile({ id: "sess-1", file: join(dir, "gone.jsonl") })).toBe(actual);
	});

	it("returns null when the id is nowhere to be found (deleted / different machine)", () => {
		writeFileSync(join(dir, "other.jsonl"), sessionHeader("sess-2"));
		expect(locateSessionFile({ id: "sess-1", file: join(dir, "gone.jsonl") })).toBeNull();
	});

	it("returns null when the hint's directory is gone entirely", () => {
		expect(locateSessionFile({ id: "sess-1", file: join(dir, "nope", "gone.jsonl") })).toBeNull();
	});

	it("returns null without a file hint (in-memory session — nowhere to search)", () => {
		expect(locateSessionFile({ id: "sess-1" })).toBeNull();
	});

	it("id-first rung: finds the run-scoped child session by id before any fallback", () => {
		// childSessionsDir(cwd, runId) === <cwd>/.rpiv/workflows/runs/<runId>/sessions/
		const runId = "2026-06-17_10-00-00-ab12";
		const childDir = join(dir, ".rpiv", "workflows", "runs", runId, "sessions");
		mkdirSync(childDir, { recursive: true });
		const childFile = join(childDir, "sess-1.jsonl");
		writeFileSync(childFile, sessionHeader("sess-1"));

		// Even with a STALE/absent `file` hint, the id-first lookup wins (O(1)).
		expect(locateSessionFile({ id: "sess-1", file: join(dir, "gone.jsonl") }, runId, dir)).toBe(childFile);
		// No file hint at all still resolves via the id-first rung.
		expect(locateSessionFile({ id: "sess-1" }, runId, dir)).toBe(childFile);
	});

	it("id-first rung: falls through to the legacy ladder when no run-scoped child exists", () => {
		const runId = "2026-06-17_10-00-00-ab12";
		mkdirSync(join(dir, ".rpiv", "workflows", "runs", runId, "sessions"), { recursive: true }); // empty
		const actual = join(dir, "real_sess-1.jsonl");
		writeFileSync(actual, sessionHeader("sess-1"));
		expect(locateSessionFile({ id: "sess-1", file: actual }, runId, dir)).toBe(actual);
	});

	it("never returns a directory — only regular files survive every rung", () => {
		const asDir = join(dir, "weird_sess-1.jsonl");
		mkdirSync(asDir);
		const actual = join(dir, "real_sess-1.jsonl");
		writeFileSync(actual, sessionHeader("sess-1"));
		expect(locateSessionFile({ id: "sess-1", file: asDir })).toBe(actual);
	});
});
