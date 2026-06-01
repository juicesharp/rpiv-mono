import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetModelsConfigCache,
	getAgentModelConfig,
	getStageModelConfig,
	loadModelsConfig,
	type ModelsConfig,
} from "./models-config.js";

const TEST_HOME = process.env.HOME!;

describe("models-config", () => {
	describe("loadModelsConfig", () => {
		const configDir = join(TEST_HOME, ".config", "rpiv-pi");
		const configFilePath = join(configDir, "models.json");

		beforeEach(() => {
			mkdirSync(configDir, { recursive: true });
		});

		it("returns empty config for missing file", () => {
			expect(loadModelsConfig()).toEqual({});
		});

		it("returns empty config for malformed JSON", () => {
			writeFileSync(configFilePath, "not json", "utf-8");
			expect(loadModelsConfig()).toEqual({});
		});

		it("returns empty config for non-object JSON", () => {
			writeFileSync(configFilePath, "42", "utf-8");
			expect(loadModelsConfig()).toEqual({});
		});

		it("returns empty config for array JSON", () => {
			writeFileSync(configFilePath, "[]", "utf-8");
			expect(loadModelsConfig()).toEqual({});
		});

		it("loads a valid config with all sections", () => {
			writeFileSync(
				configFilePath,
				JSON.stringify({
					defaults: "anthropic:claude-sonnet-4-20250514",
					agents: {
						"codebase-analyzer": { model: "openai:o3-pro", thinking: "high" },
						"web-search-researcher": "anthropic:claude-sonnet-4-20250514",
					},
					stages: {
						research: { thinking: "xhigh" },
						plan: "anthropic:claude-sonnet-4-20250514",
					},
				}),
				"utf-8",
			);

			const config = loadModelsConfig();
			expect(config.defaults).toEqual({ model: "anthropic:claude-sonnet-4-20250514" });
			expect(config.agents).toBeDefined();
			expect(config.agents!["codebase-analyzer"]).toEqual({
				model: "openai:o3-pro",
				thinking: "high",
			});
			expect(config.agents!["web-search-researcher"]).toEqual({
				model: "anthropic:claude-sonnet-4-20250514",
			});
			expect(config.stages).toBeDefined();
			expect(config.stages!["research"]).toEqual({
				thinking: "xhigh",
				model: "anthropic:claude-sonnet-4-20250514", // cascaded from defaults
			});
			expect(config.stages!["plan"]).toEqual({
				model: "anthropic:claude-sonnet-4-20250514",
			});
		});

		it("cascades defaults into agent entries", () => {
			writeFileSync(
				configFilePath,
				JSON.stringify({
					defaults: "anthropic:claude-sonnet-4-20250514",
					agents: {
						"codebase-analyzer": { thinking: "high" },
					},
				}),
				"utf-8",
			);

			const config = loadModelsConfig();
			expect(config.agents!["codebase-analyzer"]).toEqual({
				model: "anthropic:claude-sonnet-4-20250514", // from defaults
				thinking: "high", // from agent override
			});
		});

		it("cascades defaults into stage entries", () => {
			writeFileSync(
				configFilePath,
				JSON.stringify({
					defaults: "anthropic:claude-sonnet-4-20250514",
					stages: {
						research: { thinking: "xhigh" },
					},
				}),
				"utf-8",
			);

			const config = loadModelsConfig();
			expect(config.stages!["research"]).toEqual({
				model: "anthropic:claude-sonnet-4-20250514",
				thinking: "xhigh",
			});
		});

		it("strips unknown keys with additionalProperties: false", () => {
			writeFileSync(
				configFilePath,
				JSON.stringify({
					defaults: "openai:gpt-5.5",
					unknownKey: "should be stripped",
					agents: {
						"test-agent": "openai:gpt-5.5",
					},
				}),
				"utf-8",
			);

			const config = loadModelsConfig();
			expect(config).not.toHaveProperty("unknownKey");
		});

		it("warns and drops invalid thinking level", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			writeFileSync(
				configFilePath,
				JSON.stringify({
					agents: {
						"test-agent": { model: "openai:gpt-5.5", thinking: "off" },
					},
				}),
				"utf-8",
			);

			const config = loadModelsConfig();
			expect(config.agents!["test-agent"].thinking).toBeUndefined();
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown thinking level"));

			warnSpy.mockRestore();
		});
	});

	describe("loadModelsConfig cache", () => {
		const configDir = join(TEST_HOME, ".config", "rpiv-pi");
		const configFilePath = join(configDir, "models.json");

		beforeEach(() => {
			__resetModelsConfigCache();
			mkdirSync(configDir, { recursive: true });
		});

		it("returns cached result on second call", () => {
			writeFileSync(configFilePath, JSON.stringify({ defaults: "openai:gpt-5.5" }), "utf-8");

			const first = loadModelsConfig();
			const second = loadModelsConfig();
			expect(first).toBe(second); // strict reference equality — same object
		});

		it("re-reads after __resetModelsConfigCache", () => {
			writeFileSync(configFilePath, JSON.stringify({ defaults: "openai:gpt-5.5" }), "utf-8");

			const first = loadModelsConfig();

			writeFileSync(configFilePath, JSON.stringify({ defaults: "anthropic:claude-sonnet-4-20250514" }), "utf-8");

			__resetModelsConfigCache();
			const afterReset = loadModelsConfig();
			expect(afterReset).not.toBe(first); // different object — re-read
			expect(afterReset.defaults?.model).toBe("anthropic:claude-sonnet-4-20250514");
		});
	});

	describe("getAgentModelConfig", () => {
		it("returns agent-specific config when present", () => {
			const config: ModelsConfig = {
				defaults: { model: "anthropic:claude-sonnet-4-20250514" },
				agents: {
					"codebase-analyzer": { model: "openai:o3-pro", thinking: "high" },
				},
			};
			expect(getAgentModelConfig(config, "codebase-analyzer")).toEqual({
				model: "openai:o3-pro",
				thinking: "high",
			});
		});

		it("falls back to defaults when agent not configured", () => {
			const config: ModelsConfig = {
				defaults: { model: "anthropic:claude-sonnet-4-20250514" },
			};
			expect(getAgentModelConfig(config, "unknown-agent")).toEqual({
				model: "anthropic:claude-sonnet-4-20250514",
			});
		});

		it("returns undefined when neither agent nor defaults configured", () => {
			const config: ModelsConfig = {};
			expect(getAgentModelConfig(config, "unknown-agent")).toBeUndefined();
		});
	});

	describe("getStageModelConfig", () => {
		it("returns stage-specific config when present", () => {
			// Cascade is applied at load time (resolvedEntryWithCascade), so by the
			// time a present stage entry reaches the getter it already carries the
			// cascaded model. The getter itself returns the entry verbatim — it does
			// NOT re-cascade — so a present entry shadows `defaults` entirely.
			const config: ModelsConfig = {
				defaults: { model: "anthropic:claude-sonnet-4-20250514" },
				stages: {
					research: { model: "anthropic:claude-sonnet-4-20250514", thinking: "xhigh" },
				},
			};
			expect(getStageModelConfig(config, "research")).toEqual({
				model: "anthropic:claude-sonnet-4-20250514",
				thinking: "xhigh",
			});
		});

		it("falls back to defaults when stage not configured", () => {
			const config: ModelsConfig = {
				defaults: { model: "anthropic:claude-sonnet-4-20250514" },
			};
			expect(getStageModelConfig(config, "implement")).toEqual({
				model: "anthropic:claude-sonnet-4-20250514",
			});
		});

		it("returns undefined when neither stage nor defaults configured", () => {
			const config: ModelsConfig = {};
			expect(getStageModelConfig(config, "implement")).toBeUndefined();
		});
	});
});
