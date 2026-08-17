import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	buildClaudeCodeSdkOptions,
	type ClaudeCodeQuery,
	type ClaudeCodeQueryFactory,
	type ClaudeCodeQueryMessage,
	type ClaudeCodeQueryResult,
	claudeCodeAdvisorModel,
	consultClaudeCodeAdvisor,
	formatClaudeCodePrompt,
	isClaudeCodeAdvisorKey,
	mapClaudeCodeEffort,
	resolveClaudeCodeExecutable,
	validateClaudeCodeRuntime,
} from "./claude-code.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.js";

const userMessage: Message = {
	role: "user",
	content: [{ type: "text", text: "Please advise on the executor's situation above." }],
	timestamp: Date.now(),
};

function queryFrom(messages: Array<ClaudeCodeQueryMessage | ClaudeCodeQueryResult>): ClaudeCodeQuery {
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) yield message as never;
		},
		close: vi.fn(),
	};
}

function successResult(overrides: Partial<ClaudeCodeQueryResult> = {}): ClaudeCodeQueryResult {
	return {
		type: "result",
		subtype: "success",
		result: "ship the smaller change",
		stop_reason: "end_turn",
		usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
		total_cost_usd: 0.01,
		...overrides,
	};
}

describe("isClaudeCodeAdvisorKey", () => {
	it("accepts only the two hand-edited Claude Code assignments", () => {
		expect(isClaudeCodeAdvisorKey("claude-code", "claude-opus-5")).toBe(true);
		expect(isClaudeCodeAdvisorKey("claude-code", "claude-fable-5")).toBe(true);
		expect(isClaudeCodeAdvisorKey("claude-code", "claude-sonnet-5")).toBe(false);
		expect(isClaudeCodeAdvisorKey("anthropic", "claude-opus-5")).toBe(false);
	});
});

describe("buildClaudeCodeSdkOptions", () => {
	it("pins isolation options and strips Anthropic credential overrides", () => {
		const previous = {
			apiKey: process.env.ANTHROPIC_API_KEY,
			authToken: process.env.ANTHROPIC_AUTH_TOKEN,
			oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
		};
		process.env.ANTHROPIC_API_KEY = "api";
		process.env.ANTHROPIC_AUTH_TOKEN = "auth";
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth";
		try {
			const options = buildClaudeCodeSdkOptions({
				model: "claude-opus-5",
				effort: "high",
				cwd: "/repo",
				executable: "/bin/claude",
				abortController: new AbortController(),
			});
			expect(options.model).toBe("claude-opus-5");
			expect(options.effort).toBe("high");
			expect(options.systemPrompt).toBe(ADVISOR_SYSTEM_PROMPT);
			expect(options.tools).toEqual([]);
			expect(options.skills).toEqual([]);
			expect(options.settingSources).toEqual([]);
			expect(options.persistSession).toBe(false);
			expect(options.settings).toEqual({ disableBundledSkills: true, fallbackModel: [] });
			expect(options.extraArgs).toEqual({ "disable-slash-commands": null });
			expect((options.env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY).toBeUndefined();
			expect((options.env as NodeJS.ProcessEnv).ANTHROPIC_AUTH_TOKEN).toBeUndefined();
			expect((options.env as NodeJS.ProcessEnv).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		} finally {
			restoreEnv("ANTHROPIC_API_KEY", previous.apiKey);
			restoreEnv("ANTHROPIC_AUTH_TOKEN", previous.authToken);
			restoreEnv("CLAUDE_CODE_OAUTH_TOKEN", previous.oauthToken);
		}
	});
});

describe("mapClaudeCodeEffort", () => {
	it("maps Pi minimal onto the lowest Agent SDK effort and leaves unset effort unset", () => {
		expect(mapClaudeCodeEffort("minimal")).toBe("low");
		expect(mapClaudeCodeEffort("high")).toBe("high");
		expect(mapClaudeCodeEffort(undefined)).toBeUndefined();
	});
});

describe("resolveClaudeCodeExecutable", () => {
	it("prefers an executable found on PATH over the ~/.local/bin fallback", async () => {
		const directory = await mkdtemp(join(tmpdir(), "claude-code-path-"));
		const executable = join(directory, "claude");
		await writeFile(executable, "#!/bin/sh\n");
		await chmod(executable, 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = directory;
		try {
			await expect(resolveClaudeCodeExecutable()).resolves.toBe(executable);
		} finally {
			restoreEnv("PATH", previousPath);
		}
	});
});

describe("validateClaudeCodeRuntime", () => {
	it("requires a first-party claude.ai login", () => {
		expect(() =>
			validateClaudeCodeRuntime({
				loggedIn: true,
				authMethod: "claude.ai",
				apiProvider: "firstParty",
				version: "2.1.0",
			}),
		).not.toThrow();
		expect(() =>
			validateClaudeCodeRuntime({
				loggedIn: false,
				authMethod: "claude.ai",
				apiProvider: "firstParty",
				version: "2.1.0",
			}),
		).toThrow(/Claude subscription login/);
		expect(() =>
			validateClaudeCodeRuntime({
				loggedIn: true,
				authMethod: "api-key",
				apiProvider: "firstParty",
				version: "2.1.0",
			}),
		).toThrow(/Claude subscription login/);
	});
});

describe("formatClaudeCodePrompt", () => {
	it("keeps the user-tail nudge from the shared branch assembly", () => {
		expect(formatClaudeCodePrompt([userMessage])).toContain("Please advise on the executor's situation above.");
	});
});

describe("consultClaudeCodeAdvisor", () => {
	it("returns guidance from a successful isolated query and never retries", async () => {
		const queryFactory: ClaudeCodeQueryFactory = vi.fn(() => queryFrom([successResult()]));
		const result = await consultClaudeCodeAdvisor({
			advisor: claudeCodeAdvisorModel("claude-opus-5"),
			effort: "high",
			messages: [userMessage],
			cwd: "/repo",
			deps: {
				queryFactory,
				runtimeInspector: async () => ({
					loggedIn: true,
					authMethod: "claude.ai",
					apiProvider: "firstParty",
					version: "2.1.0",
				}),
			},
		});
		expect(queryFactory).toHaveBeenCalledTimes(1);
		expect(result.content[0]).toMatchObject({ type: "text", text: "ship the smaller change" });
		expect(result.details).toMatchObject({
			advisorModel: "claude-code:claude-opus-5",
			effort: "high",
			stopReason: "stop",
		});
		expect(result.details.usage).toMatchObject({ input: 10, output: 4, cacheRead: 2, cacheWrite: 1 });
	});

	it("fails closed when Claude Code is not logged in, before opening a query", async () => {
		const queryFactory = vi.fn(() => queryFrom([successResult()]));
		const result = await consultClaudeCodeAdvisor({
			advisor: claudeCodeAdvisorModel("claude-fable-5"),
			effort: "high",
			messages: [userMessage],
			cwd: "/repo",
			deps: {
				queryFactory,
				runtimeInspector: async () => ({
					loggedIn: false,
					authMethod: "",
					apiProvider: "",
					version: "2.1.0",
				}),
			},
		});
		expect(queryFactory).not.toHaveBeenCalled();
		expect(result.details.errorMessage).toMatch(/Claude subscription login/);
		expect(result.content[0]).toMatchObject({ type: "text" });
	});

	it("sends mapped Agent SDK effort, including Pi minimal as low", async () => {
		const queryFactory: ClaudeCodeQueryFactory = vi.fn(() => queryFrom([successResult()]));
		await consultClaudeCodeAdvisor({
			advisor: claudeCodeAdvisorModel("claude-opus-5"),
			effort: "minimal",
			messages: [userMessage],
			cwd: "/repo",
			deps: {
				queryFactory,
				executable: "/bin/claude",
				runtimeInspector: async () => ({
					loggedIn: true,
					authMethod: "claude.ai",
					apiProvider: "firstParty",
					version: "2.1.0",
				}),
			},
		});
		const options = vi.mocked(queryFactory).mock.calls[0]?.[0].options;
		expect(options?.effort).toBe("low");
	});

	it("returns a cancelled envelope only when the caller aborted the signal", async () => {
		const signal = AbortSignal.abort();
		const queryFactory = vi.fn(async () => {
			throw new Error("Advisor SDK process exited unexpectedly");
		});
		const result = await consultClaudeCodeAdvisor({
			advisor: claudeCodeAdvisorModel("claude-opus-5"),
			effort: "high",
			messages: [userMessage],
			cwd: "/repo",
			signal,
			deps: {
				queryFactory,
				executable: "/bin/claude",
				runtimeInspector: async () => ({
					loggedIn: true,
					authMethod: "claude.ai",
					apiProvider: "firstParty",
					version: "2.1.0",
				}),
			},
		});
		expect(result.details.stopReason).toBe("aborted");
		expect(result.content[0]).toMatchObject({
			text: "Advisor call was cancelled before it completed.",
		});
	});

	it("does not treat an unrelated aborted error as caller cancellation", async () => {
		const result = await consultClaudeCodeAdvisor({
			advisor: claudeCodeAdvisorModel("claude-opus-5"),
			effort: "high",
			messages: [userMessage],
			cwd: "/repo",
			deps: {
				queryFactory: async () => {
					throw new Error("operation aborted by provider");
				},
				executable: "/bin/claude",
				runtimeInspector: async () => ({
					loggedIn: true,
					authMethod: "claude.ai",
					apiProvider: "firstParty",
					version: "2.1.0",
				}),
			},
		});
		expect(result.details.stopReason).toBeUndefined();
		expect(result.details.errorMessage).toBe("operation aborted by provider");
		expect(result.content[0]).toMatchObject({ text: "Advisor call threw: operation aborted by provider" });
	});

	it("closes the query and reports a non-success SDK result", async () => {
		const query = queryFrom([
			{
				type: "result",
				subtype: "error_during_execution",
				errors: ["model overloaded"],
			},
		]);
		const result = await consultClaudeCodeAdvisor({
			advisor: claudeCodeAdvisorModel("claude-opus-5"),
			effort: "high",
			messages: [userMessage],
			cwd: "/repo",
			deps: {
				queryFactory: () => query,
				executable: "/bin/claude",
				runtimeInspector: async () => ({
					loggedIn: true,
					authMethod: "claude.ai",
					apiProvider: "firstParty",
					version: "2.1.0",
				}),
			},
		});
		expect(query.close).toHaveBeenCalledTimes(1);
		expect(result.details).toMatchObject({
			stopReason: "error",
			errorMessage: "model overloaded",
		});
	});

	it("fails a managed refusal fallback instead of accepting another model", async () => {
		const result = await consultClaudeCodeAdvisor({
			advisor: claudeCodeAdvisorModel("claude-opus-5"),
			effort: "high",
			messages: [userMessage],
			cwd: "/repo",
			deps: {
				queryFactory: () =>
					queryFrom([
						{
							type: "system",
							subtype: "model_refusal_fallback",
							original_model: "claude-opus-5",
							fallback_model: "claude-sonnet-5",
						},
					]),
				runtimeInspector: async () => ({
					loggedIn: true,
					authMethod: "claude.ai",
					apiProvider: "firstParty",
					version: "2.1.0",
				}),
			},
		});
		expect(result.details.errorMessage).toMatch(/model fallback/);
	});
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
