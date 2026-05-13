import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import {
	ADVISOR_TOOL_NAME,
	DEFAULT_PROMPT_GUIDELINES,
	DEFAULT_PROMPT_SNIPPET,
	loadAdvisorConfig,
	registerAdvisorTool,
	saveAdvisorConfig,
} from "./advisor.js";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");

function writeConfig(data: Record<string, unknown>): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
}

describe("registerAdvisorTool — guidance overrides", () => {
	it("uses built-in defaults when no config file exists", () => {
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		expect(tool.promptGuidelines).toBe(DEFAULT_PROMPT_GUIDELINES);
	});

	it("uses built-in defaults when config has no guidance field", () => {
		writeConfig({ modelKey: "anthropic:opus" });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		expect(tool.promptGuidelines).toBe(DEFAULT_PROMPT_GUIDELINES);
	});

	it("overrides promptSnippet with valid value", () => {
		writeConfig({ guidance: { promptSnippet: "Custom advisor snippet" } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe("Custom advisor snippet");
		expect(tool.promptGuidelines).toBe(DEFAULT_PROMPT_GUIDELINES);
	});

	it("overrides promptGuidelines with valid value", () => {
		writeConfig({ guidance: { promptGuidelines: ["Rule one", "Rule two"] } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		expect(tool.promptGuidelines).toEqual(["Rule one", "Rule two"]);
	});

	it("overrides both promptSnippet and promptGuidelines", () => {
		writeConfig({ guidance: { promptSnippet: "Custom", promptGuidelines: ["Rule"] } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe("Custom");
		expect(tool.promptGuidelines).toEqual(["Rule"]);
	});

	it("falls back to defaults on empty promptSnippet", () => {
		writeConfig({ guidance: { promptSnippet: "" } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
	});

	it("falls back to defaults on empty promptGuidelines array", () => {
		writeConfig({ guidance: { promptGuidelines: [] } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptGuidelines).toBe(DEFAULT_PROMPT_GUIDELINES);
	});

	it("falls back to defaults on wrong types", () => {
		writeConfig({ guidance: { promptSnippet: 123, promptGuidelines: "not-array" } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		expect(tool.promptGuidelines).toBe(DEFAULT_PROMPT_GUIDELINES);
	});

	it("falls back to defaults on promptGuidelines with empty string item", () => {
		writeConfig({ guidance: { promptGuidelines: ["valid", ""] } });
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get(ADVISOR_TOOL_NAME)!;
		expect(tool.promptGuidelines).toBe(DEFAULT_PROMPT_GUIDELINES);
	});
});

describe("saveAdvisorConfig — preserves guidance field", () => {
	it("preserves guidance when saving model selection", () => {
		writeConfig({ guidance: { promptSnippet: "Custom" } });
		saveAdvisorConfig("anthropic:opus", "high");
		const config = loadAdvisorConfig();
		expect(config.modelKey).toBe("anthropic:opus");
		expect(config.effort).toBe("high");
		expect(config.guidance).toEqual({ promptSnippet: "Custom" });
	});

	it("preserves guidance when resetting advisor", () => {
		writeConfig({ modelKey: "anthropic:opus", guidance: { promptSnippet: "Custom" } });
		saveAdvisorConfig(undefined, undefined);
		const config = loadAdvisorConfig();
		expect(config.modelKey).toBeUndefined();
		expect(config.guidance).toEqual({ promptSnippet: "Custom" });
	});
});
