import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROMPT_GUIDELINES, DEFAULT_PROMPT_SNIPPET, registerTodoTool, TOOL_NAME } from "./todo.js";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-todo", "config.json");
const DEFAULT_GUIDELINES_LENGTH = DEFAULT_PROMPT_GUIDELINES.length;

function writeConfig(data: Record<string, unknown>): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
}

beforeEach(() => {
	// test/setup.ts rmSyncs CONFIG_PATH in shared beforeEach
});

describe("registerTodoTool — guidance overrides", () => {
	it("uses built-in defaults when no config file exists", () => {
		const { pi, captured } = createMockPi();
		registerTodoTool(pi);
		const tool = captured.tools.get(TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		expect((tool.promptGuidelines as string[]).length).toBe(DEFAULT_GUIDELINES_LENGTH);
	});

	it("uses built-in defaults when config has no guidance field", () => {
		writeConfig({ otherField: true });
		const { pi, captured } = createMockPi();
		registerTodoTool(pi);
		const tool = captured.tools.get(TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
	});

	it("overrides promptSnippet with valid value", () => {
		writeConfig({ guidance: { promptSnippet: "Custom todo snippet" } });
		const { pi, captured } = createMockPi();
		registerTodoTool(pi);
		const tool = captured.tools.get(TOOL_NAME)!;
		expect(tool.promptSnippet).toBe("Custom todo snippet");
		expect((tool.promptGuidelines as string[]).length).toBe(DEFAULT_GUIDELINES_LENGTH);
	});

	it("overrides promptGuidelines with valid value", () => {
		writeConfig({ guidance: { promptGuidelines: ["Rule one", "Rule two"] } });
		const { pi, captured } = createMockPi();
		registerTodoTool(pi);
		const tool = captured.tools.get(TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		expect(tool.promptGuidelines).toEqual(["Rule one", "Rule two"]);
	});

	it("overrides both promptSnippet and promptGuidelines", () => {
		writeConfig({ guidance: { promptSnippet: "Custom", promptGuidelines: ["Rule"] } });
		const { pi, captured } = createMockPi();
		registerTodoTool(pi);
		const tool = captured.tools.get(TOOL_NAME)!;
		expect(tool.promptSnippet).toBe("Custom");
		expect(tool.promptGuidelines).toEqual(["Rule"]);
	});

	it("falls back to defaults on empty promptSnippet", () => {
		writeConfig({ guidance: { promptSnippet: "" } });
		const { pi, captured } = createMockPi();
		registerTodoTool(pi);
		const tool = captured.tools.get(TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
	});

	it("falls back to defaults on wrong types", () => {
		writeConfig({ guidance: { promptSnippet: 123, promptGuidelines: "not-array" } });
		const { pi, captured } = createMockPi();
		registerTodoTool(pi);
		const tool = captured.tools.get(TOOL_NAME)!;
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		expect((tool.promptGuidelines as string[]).length).toBe(DEFAULT_GUIDELINES_LENGTH);
	});

	it("falls back to defaults on promptGuidelines with empty string item", () => {
		writeConfig({ guidance: { promptGuidelines: ["valid", ""] } });
		const { pi, captured } = createMockPi();
		registerTodoTool(pi);
		const tool = captured.tools.get(TOOL_NAME)!;
		expect((tool.promptGuidelines as string[]).length).toBe(DEFAULT_GUIDELINES_LENGTH);
	});
});
