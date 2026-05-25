import { describe, expect, it } from "vitest";
import { fs } from "../../handle.js";
import type { BranchEntry } from "../../transcript.js";
import { toolCallCollector } from "./tool-call.js";

const asstWithTools = (parts: Array<{ name: string; input: Record<string, unknown> }>): BranchEntry => ({
	type: "message",
	message: {
		role: "assistant",
		content: parts.map((p) => ({ type: "tool_use", name: p.name, input: p.input })),
	},
});

const ctxOf = (branch: BranchEntry[]) => ({
	cwd: "/tmp",
	runId: "test",
	stageIndex: 0,
	state: {} as never,
	branch,
	branchOffset: undefined,
	snapshot: undefined,
	skill: "test",
});

describe("toolCallCollector", () => {
	it("throws when match or toArtifact are missing", () => {
		// @ts-expect-error — intentional misuse
		expect(() => toolCallCollector({})).toThrow(/required functions/);
	});

	it("emits one artifact per matching tool call in branch order", async () => {
		const collector = toolCallCollector({
			match: (tc) => tc.name === "write_file",
			toArtifact: (tc) => ({ handle: fs(String(tc.input.path)), role: "written" }),
		});
		const ctx = ctxOf([
			asstWithTools([
				{ name: "write_file", input: { path: "a.ts" } },
				{ name: "read_file", input: { path: "ignored.ts" } },
				{ name: "write_file", input: { path: "b.ts" } },
			]),
		]);
		const result = await collector.collect(ctx);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.artifacts).toEqual([
			{ handle: { kind: "fs", path: "a.ts" }, role: "written" },
			{ handle: { kind: "fs", path: "b.ts" }, role: "written" },
		]);
	});

	it("returns ok+empty when nothing matches (runner decides whether to fatal)", async () => {
		const collector = toolCallCollector({
			match: (tc) => tc.name === "write_file",
			toArtifact: (tc) => ({ handle: fs(String(tc.input.path)) }),
		});
		const ctx = ctxOf([asstWithTools([{ name: "read_file", input: { path: "x.ts" } }])]);
		const result = await collector.collect(ctx);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.artifacts).toEqual([]);
	});

	it("toArtifact returning undefined skips the call", async () => {
		const collector = toolCallCollector({
			match: () => true,
			toArtifact: (tc) => (tc.input.path ? { handle: fs(String(tc.input.path)) } : undefined),
		});
		const ctx = ctxOf([
			asstWithTools([
				{ name: "bash", input: { cmd: "ls" } }, // no path → skipped
				{ name: "write_file", input: { path: "a.ts" } },
			]),
		]);
		const result = await collector.collect(ctx);
		expect(result.kind === "ok" && result.artifacts).toEqual([{ handle: { kind: "fs", path: "a.ts" } }]);
	});

	it("respects branchOffset", async () => {
		const collector = toolCallCollector({
			match: (tc) => tc.name === "write_file",
			toArtifact: (tc) => ({ handle: fs(String(tc.input.path)) }),
		});
		const branch = [
			asstWithTools([{ name: "write_file", input: { path: "prior.ts" } }]),
			asstWithTools([{ name: "write_file", input: { path: "current.ts" } }]),
		];
		const ctx = { ...ctxOf(branch), branchOffset: 1 };
		const result = await collector.collect(ctx);
		expect(result.kind === "ok" && result.artifacts).toEqual([{ handle: { kind: "fs", path: "current.ts" } }]);
	});

	it("multi-tool match — one collector covers write_file + edit", async () => {
		const collector = toolCallCollector({
			match: (tc) => tc.name === "write_file" || tc.name === "edit",
			toArtifact: (tc) => ({ handle: fs(String(tc.input.path ?? tc.input.target_file)) }),
		});
		const ctx = ctxOf([
			asstWithTools([
				{ name: "write_file", input: { path: "new.ts" } },
				{ name: "edit", input: { target_file: "old.ts" } },
			]),
		]);
		const result = await collector.collect(ctx);
		expect(result.kind === "ok" && result.artifacts.map((a) => a.handle)).toEqual([
			{ kind: "fs", path: "new.ts" },
			{ kind: "fs", path: "old.ts" },
		]);
	});
});
