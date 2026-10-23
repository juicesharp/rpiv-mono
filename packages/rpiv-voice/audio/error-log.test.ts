import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { appendErrorLog, getErrorLogPath } from "./error-log.ts";

// test/setup.ts stubs HOME to a fresh tmpdir at module-load (homedir() is
// cached) and rmSync's errors.log between tests, so each `it` here starts
// with no log file present.

describe("appendErrorLog", () => {
	it("creates the log file and appends one line per call", () => {
		appendErrorLog("stt.recognize", new Error("decoder broke"));
		appendErrorLog("stt.recognize", "non-error string");

		const path = getErrorLogPath();
		expect(existsSync(path)).toBe(true);
		const lines = readFileSync(path, "utf-8").trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/\[stt\.recognize\] Error: decoder broke$/);
		expect(lines[1]).toMatch(/\[stt\.recognize\] non-error string$/);
		expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
	});

	it("never throws on weird inputs", () => {
		expect(() => appendErrorLog("scope", undefined)).not.toThrow();
		expect(() => appendErrorLog("scope", { weird: "object" })).not.toThrow();
		expect(() => appendErrorLog("scope", null)).not.toThrow();
	});
});
