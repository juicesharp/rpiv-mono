import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureSubagentConfig } from "./ensure-subagent-config.js";

const CONFIG_PATH = join(process.env.HOME ?? "", ".pi", "agent", "extensions", "subagent", "config.json");

function writeConfig(contents: unknown): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(contents), "utf-8");
}

function readConfig(): unknown {
	return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

describe("ensureSubagentConfig", () => {
	it("first run: creates config.json with both defaults", () => {
		const result = ensureSubagentConfig();
		expect(result.created).toBe(true);
		expect(result.merged).toEqual(["parallel.concurrency", "maxSubagentDepth"]);
		expect(readConfig()).toEqual({
			parallel: { concurrency: 4 },
			maxSubagentDepth: 3,
		});
	});

	it("idempotent: re-run on complete config is a no-op", () => {
		writeConfig({ parallel: { concurrency: 4 }, maxSubagentDepth: 3 });
		const result = ensureSubagentConfig();
		expect(result.created).toBe(false);
		expect(result.merged).toEqual([]);
	});

	it("user-value wins: existing parallel.concurrency preserved", () => {
		writeConfig({ parallel: { concurrency: 16 } });
		const result = ensureSubagentConfig();
		expect(result.created).toBe(false);
		expect(result.merged).toEqual(["maxSubagentDepth"]);
		expect(readConfig()).toEqual({
			parallel: { concurrency: 16 },
			maxSubagentDepth: 3,
		});
	});

	it("partial state: adds concurrency alongside existing parallel.maxTasks", () => {
		writeConfig({ parallel: { maxTasks: 10 } });
		const result = ensureSubagentConfig();
		expect(result.created).toBe(false);
		expect(result.merged).toEqual(["parallel.concurrency", "maxSubagentDepth"]);
		expect(readConfig()).toEqual({
			parallel: { maxTasks: 10, concurrency: 4 },
			maxSubagentDepth: 3,
		});
	});

	it("invalid JSON fail-soft: no throw, no write (file byte-exact)", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, "{not json", "utf-8");
		const result = ensureSubagentConfig();
		expect(result.created).toBe(false);
		expect(result.merged).toEqual([]);
		expect(readFileSync(CONFIG_PATH, "utf-8")).toBe("{not json");
	});

	it("non-object top-level JSON fail-soft", () => {
		writeConfig([1, 2, 3]);
		const result = ensureSubagentConfig();
		expect(result.created).toBe(false);
		expect(result.merged).toEqual([]);
		expect(readConfig()).toEqual([1, 2, 3]);
	});

	it("preserves unrelated top-level + nested keys on merge", () => {
		writeConfig({
			asyncByDefault: true,
			worktreeSetupHook: "/path/to/hook.sh",
			parallel: { maxTasks: 10 },
		});
		const result = ensureSubagentConfig();
		expect(result.merged).toEqual(["parallel.concurrency", "maxSubagentDepth"]);
		expect(readConfig()).toEqual({
			asyncByDefault: true,
			worktreeSetupHook: "/path/to/hook.sh",
			parallel: { maxTasks: 10, concurrency: 4 },
			maxSubagentDepth: 3,
		});
	});
});
