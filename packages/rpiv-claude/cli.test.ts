import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunWorkflowResult } from "@juicesharp/rpiv-workflow";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeHostDeps } from "./claude-host.js";
import { EXIT, main, type WorkflowApi } from "./cli.js";

function plugin(): string {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-cli-plugin-"));
	mkdirSync(join(dir, "skills", "commit"), { recursive: true });
	writeFileSync(join(dir, "skills", "commit", "SKILL.md"), "---\nname: commit\n---\n");
	return dir;
}

function harness(result: RunWorkflowResult = { success: true, stagesCompleted: 2, runId: "r1" }) {
	const out: string[] = [];
	const err: string[] = [];
	const api: WorkflowApi = {
		loadWorkflows: vi.fn(async () => ({
			workflows: [{ name: "build", description: "the big one" }, { name: "mine" }],
		})),
		runWorkflowByName: vi.fn(async () => result),
		resumeWorkflowByRunId: vi.fn(async () => result),
	};
	const deps = { query: vi.fn(), forkSession: vi.fn() } as unknown as ClaudeHostDeps;
	const go = (args: string[], signal?: AbortSignal) =>
		main(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, { api, deps, signal });
	return { go, api, out, err };
}

describe("rpiv-wf", () => {
	it("lists workflows", async () => {
		const h = harness();
		expect(await h.go(["list"])).toBe(EXIT.ok);
		expect(h.out).toEqual(["build\tthe big one", "mine"]);
	});

	it("runs a workflow with the joined input, a registry host and the requested name", async () => {
		const h = harness({ success: true, stagesCompleted: 3, runId: "r9", lastArtifact: "plan.md" });
		const code = await h.go(["run", "build", "add", "dark", "mode", "--name", "dm", "--plugin-dir", plugin()]);
		expect(code).toBe(EXIT.ok);
		const [ctx, name, input, opts] = vi.mocked(h.api.runWorkflowByName).mock.calls[0]!;
		expect([name, input]).toEqual(["build", "add dark mode"]);
		expect(ctx.maxConcurrency).toBe(4);
		expect(opts).toMatchObject({ name: "dm", trigger: { kind: "programmatic", source: "rpiv-claude" } });
		expect((opts as { host: { getCommands(): unknown[] } }).host.getCommands()).toEqual([
			{ name: "skill:commit", source: "skill" },
		]);
		expect(h.out).toEqual(["completed (run r9): 3 stage(s)", "artifact: plan.md"]);
	});

	it("resumes by reference", async () => {
		const h = harness();
		expect(await h.go(["resume", "dm", "--plugin-dir", plugin(), "--concurrency", "2"])).toBe(EXIT.ok);
		const [ctx, ref] = vi.mocked(h.api.resumeWorkflowByRunId).mock.calls[0]!;
		expect(ref).toBe("dm");
		expect(ctx.maxConcurrency).toBe(2);
	});

	it("exits 1 with the runner's error on failure", async () => {
		const h = harness({ success: false, stagesCompleted: 1, runId: "r2", error: "gate failed" });
		expect(await h.go(["run", "build", "--plugin-dir", plugin()])).toBe(EXIT.failed);
		expect(h.err.at(-1)).toBe("failed (run r2) after 1 stage(s): gate failed");
	});

	it("exits 130 when interrupted", async () => {
		const ac = new AbortController();
		ac.abort();
		const h = harness({ success: false, stagesCompleted: 0 });
		expect(await h.go(["run", "build", "--plugin-dir", plugin()], ac.signal)).toBe(EXIT.interrupted);
	});

	it.each([
		[[]],
		[["run"]],
		[["resume"]],
		[["deploy", "x"]],
		[["run", "x", "--concurrency", "0"]],
		[["run", "x", "--permission-mode", "yolo"]],
		[["run", "x", "--bogus"]],
	])("rejects %j with a usage error", async (args) => {
		const h = harness();
		expect(await h.go(args)).toBe(EXIT.usage);
		expect(h.api.runWorkflowByName).not.toHaveBeenCalled();
	});

	it("refuses a plugin directory with no skills", async () => {
		const h = harness();
		const empty = mkdtempSync(join(tmpdir(), "rpiv-cli-empty-"));
		expect(await h.go(["run", "build", "--plugin-dir", empty])).toBe(EXIT.usage);
		expect(h.err.join()).toContain("export:hosts");
	});

	it("lists rpiv's built-ins through the real registration, without injection", async () => {
		const out: string[] = [];
		const cwd = mkdtempSync(join(tmpdir(), "rpiv-cli-real-"));
		expect(await main(["list", "--cwd", cwd], { out: (l) => out.push(l), err: () => {} })).toBe(EXIT.ok);
		expect(out.map((l) => l.split("\t")[0])).toEqual(expect.arrayContaining(["build", "ship", "vet", "polish"]));
	});

	it("builds the host on the real Claude Agent SDK when none is injected", async () => {
		const result = { success: true, stagesCompleted: 0 };
		const api = { ...harness().api, runWorkflowByName: vi.fn(async () => result) };
		const code = await main(["run", "x", "--plugin-dir", plugin()], { out: () => {}, err: () => {} }, { api });
		expect(code).toBe(EXIT.ok);
		expect(api.runWorkflowByName).toHaveBeenCalledOnce();
	});
});
