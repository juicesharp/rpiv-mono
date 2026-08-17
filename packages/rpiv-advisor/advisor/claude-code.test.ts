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
