import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, type vi } from "vitest";
import registerWebTools, {
	DEFAULT_WEB_FETCH_GUIDELINES,
	DEFAULT_WEB_FETCH_SNIPPET,
	DEFAULT_WEB_SEARCH_GUIDELINES,
	DEFAULT_WEB_SEARCH_SNIPPET,
} from "./index.js";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-web-tools", "config.json");
const DEFAULT_SEARCH_GUIDELINES_LENGTH = DEFAULT_WEB_SEARCH_GUIDELINES.length;
const DEFAULT_FETCH_GUIDELINES_LENGTH = DEFAULT_WEB_FETCH_GUIDELINES.length;

function writeConfig(data: Record<string, unknown>): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function registerAndCapture() {
	const { pi, captured } = createMockPi();
	registerWebTools(pi);
	return { pi, captured };
}

beforeEach(() => {
	// test/setup.ts rmSyncs CONFIG_PATH in shared beforeEach
});

describe("web-tools guidance overrides", () => {
	it("uses built-in defaults when no config file exists", () => {
		const { captured } = registerAndCapture();
		const searchTool = captured.tools.get("web_search")!;
		const fetchTool = captured.tools.get("web_fetch")!;
		expect(searchTool.promptSnippet).toBe(DEFAULT_WEB_SEARCH_SNIPPET);
		expect((searchTool.promptGuidelines as string[]).length).toBe(DEFAULT_SEARCH_GUIDELINES_LENGTH);
		expect(fetchTool.promptSnippet).toBe(DEFAULT_WEB_FETCH_SNIPPET);
		expect((fetchTool.promptGuidelines as string[]).length).toBe(DEFAULT_FETCH_GUIDELINES_LENGTH);
	});

	it("overrides web_search snippet only, web_fetch uses defaults", () => {
		writeConfig({ guidance: { web_search: { promptSnippet: "Custom search snippet" } } });
		const { captured } = registerAndCapture();
		const searchTool = captured.tools.get("web_search")!;
		const fetchTool = captured.tools.get("web_fetch")!;
		expect(searchTool.promptSnippet).toBe("Custom search snippet");
		expect((searchTool.promptGuidelines as string[]).length).toBe(DEFAULT_SEARCH_GUIDELINES_LENGTH);
		expect(fetchTool.promptSnippet).toBe(DEFAULT_WEB_FETCH_SNIPPET);
	});

	it("overrides web_fetch snippet only, web_search uses defaults", () => {
		writeConfig({ guidance: { web_fetch: { promptSnippet: "Custom fetch snippet" } } });
		const { captured } = registerAndCapture();
		const searchTool = captured.tools.get("web_search")!;
		const fetchTool = captured.tools.get("web_fetch")!;
		expect(searchTool.promptSnippet).toBe(DEFAULT_WEB_SEARCH_SNIPPET);
		expect(fetchTool.promptSnippet).toBe("Custom fetch snippet");
	});

	it("overrides both tools independently", () => {
		writeConfig({
			guidance: {
				web_search: { promptSnippet: "Search custom", promptGuidelines: ["Rule S"] },
				web_fetch: { promptSnippet: "Fetch custom", promptGuidelines: ["Rule F"] },
			},
		});
		const { captured } = registerAndCapture();
		const searchTool = captured.tools.get("web_search")!;
		const fetchTool = captured.tools.get("web_fetch")!;
		expect(searchTool.promptSnippet).toBe("Search custom");
		expect(searchTool.promptGuidelines).toEqual(["Rule S"]);
		expect(fetchTool.promptSnippet).toBe("Fetch custom");
		expect(fetchTool.promptGuidelines).toEqual(["Rule F"]);
	});

	it("falls back to defaults on invalid guidance types", () => {
		writeConfig({
			guidance: { web_search: { promptSnippet: 123 }, web_fetch: { promptGuidelines: "not-array" } },
		});
		const { captured } = registerAndCapture();
		const searchTool = captured.tools.get("web_search")!;
		const fetchTool = captured.tools.get("web_fetch")!;
		expect(searchTool.promptSnippet).toBe(DEFAULT_WEB_SEARCH_SNIPPET);
		expect((fetchTool.promptGuidelines as string[]).length).toBe(DEFAULT_FETCH_GUIDELINES_LENGTH);
	});

	it("falls back to defaults on empty promptSnippet", () => {
		writeConfig({ guidance: { web_search: { promptSnippet: "" } } });
		const { captured } = registerAndCapture();
		const searchTool = captured.tools.get("web_search")!;
		expect(searchTool.promptSnippet).toBe(DEFAULT_WEB_SEARCH_SNIPPET);
	});

	it("preserves guidance when saving API key via /web-tools", async () => {
		writeConfig({ guidance: { web_search: { promptSnippet: "Custom" } } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Brave");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("new-api-key");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.provider).toBe("brave");
		expect(saved.apiKeys).toEqual({ brave: "new-api-key" });
		expect(saved.guidance).toEqual({ web_search: { promptSnippet: "Custom" } });
		expect(saved.apiKey).toBeUndefined();
	});
});
