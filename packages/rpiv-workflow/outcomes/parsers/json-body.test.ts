import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fs as fsHandle, opaque } from "../../handle.js";
import type { ParseCtx } from "../../outcome-types.js";
import { jsonBodyParser } from "./json-body.js";

const ctxOf = (cwd: string, artifacts: ParseCtx["artifacts"]): ParseCtx => ({
	cwd,
	runId: "test",
	stageIndex: 0,
	state: {} as never,
	branch: [],
	branchOffset: undefined,
	snapshot: undefined,
	skill: "test",
	artifacts,
});

describe("jsonBodyParser", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-jsonbody-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("parses the primary fs artifact's body and emits kind:'json'", async () => {
		writeFileSync(join(tmpDir, "out.json"), JSON.stringify({ ok: true, count: 3 }));
		const ctx = ctxOf(tmpDir, [{ handle: fsHandle("out.json") }]);
		const result = await jsonBodyParser.parse(ctx);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.payload.kind).toBe("json");
		expect(result.payload.data).toEqual({ ok: true, count: 3 });
	});

	it("accepts absolute paths unchanged", async () => {
		writeFileSync(join(tmpDir, "abs.json"), JSON.stringify({ x: 1 }));
		const ctx = ctxOf(tmpDir, [{ handle: fsHandle(join(tmpDir, "abs.json")) }]);
		const result = await jsonBodyParser.parse(ctx);
		expect(result.kind === "ok" && result.payload.data).toEqual({ x: 1 });
	});

	it("fatals when the primary artifact isn't an fs handle", async () => {
		const ctx = ctxOf(tmpDir, [{ handle: opaque("not-fs") }]);
		const result = await jsonBodyParser.parse(ctx);
		expect(result.kind).toBe("fatal");
		if (result.kind !== "fatal") return;
		expect(result.message).toMatch(/requires an fs artifact/);
	});

	it("fatals when no artifacts are present", async () => {
		const ctx = ctxOf(tmpDir, []);
		const result = await jsonBodyParser.parse(ctx);
		expect(result.kind).toBe("fatal");
		if (result.kind !== "fatal") return;
		expect(result.message).toMatch(/got none/);
	});

	it("fatals when the file doesn't exist", async () => {
		const ctx = ctxOf(tmpDir, [{ handle: fsHandle("missing.json") }]);
		const result = await jsonBodyParser.parse(ctx);
		expect(result.kind).toBe("fatal");
		if (result.kind !== "fatal") return;
		expect(result.message).toMatch(/does not exist on disk/);
	});

	it("fatals on malformed JSON", async () => {
		writeFileSync(join(tmpDir, "bad.json"), "{not json");
		const ctx = ctxOf(tmpDir, [{ handle: fsHandle("bad.json") }]);
		const result = await jsonBodyParser.parse(ctx);
		expect(result.kind).toBe("fatal");
		if (result.kind !== "fatal") return;
		expect(result.message).toMatch(/failed to parse JSON/);
	});
});
