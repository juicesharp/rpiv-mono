import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetModelsConfigCache,
	findUnknownModelKeys,
	getAgentModelConfig,
	loadModelsConfig,
	type ModelsConfig,
	resolveStageModel,
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

		it("cascades defaults into skills entries (per-field)", () => {
			writeFileSync(
				configFilePath,
				JSON.stringify({
					defaults: "anthropic/opus",
					skills: {
						commit: { thinking: "minimal" },
					},
				}),
				"utf-8",
			);
			const config = loadModelsConfig();
			expect(config.skills!.commit).toEqual({
				model: "anthropic/opus", // from defaults
				thinking: "minimal",
			});
		});

		it("cascades defaults into preset-stage entries (per-field)", () => {
			writeFileSync(
				configFilePath,
				JSON.stringify({
					defaults: "anthropic/opus",
					presets: { ship: { stages: { plan: { thinking: "high" } } } },
				}),
				"utf-8",
			);
			const config = loadModelsConfig();
			expect(config.presets!.ship.stages!.plan).toEqual({
				model: "anthropic/opus", // from defaults
				thinking: "high",
			});
		});

		it("loads skills + presets alongside agents + stages", () => {
			writeFileSync(
				configFilePath,
				JSON.stringify({
					defaults: "anthropic/opus",
					skills: {
						commit: "zai/glm-4-7",
						research: { model: "openai/gpt-5.5", thinking: "high" },
					},
					presets: {
						ship: {
							stages: {
								plan: "openai/gpt-5.5",
								design: { model: "openai/gpt-5.5", thinking: "high" },
							},
						},
					},
				}),
				"utf-8",
			);
			const config = loadModelsConfig();
			expect(config.skills!.commit).toEqual({ model: "zai/glm-4-7" });
			expect(config.skills!.research).toEqual({
				model: "openai/gpt-5.5",
				thinking: "high",
			});
			expect(config.presets!.ship.stages!.plan).toEqual({ model: "openai/gpt-5.5" });
			expect(config.presets!.ship.stages!.design).toEqual({
				model: "openai/gpt-5.5",
				thinking: "high",
			});
		});

		it("rejects per-preset `agents` / `defaults` blocks via additionalProperties:false", () => {
			writeFileSync(
				configFilePath,
				JSON.stringify({
					presets: {
						ship: {
							agents: { "codebase-locator": "openai/gpt-5.5" }, // stripped
							defaults: "openai/gpt-5.5", // stripped
							stages: { plan: "openai/gpt-5.5" },
						},
					},
				}),
				"utf-8",
			);
			const config = loadModelsConfig();
			expect(config.presets!.ship.stages!.plan).toEqual({ model: "openai/gpt-5.5" });
			expect(config.presets!.ship as Record<string, unknown>).not.toHaveProperty("agents");
			expect(config.presets!.ship as Record<string, unknown>).not.toHaveProperty("defaults");
		});

		it("treats empty `skills: {}` identically to absent `skills` (no-bleed)", () => {
			writeFileSync(configFilePath, JSON.stringify({ defaults: "anthropic/opus", skills: {} }), "utf-8");
			const config = loadModelsConfig();
			expect(config.skills).toBeUndefined();
		});

		it("treats empty `presets: { ship: {} }` identically to absent preset (no-bleed)", () => {
			writeFileSync(configFilePath, JSON.stringify({ defaults: "anthropic/opus", presets: { ship: {} } }), "utf-8");
			const config = loadModelsConfig();
			expect(config.presets).toBeUndefined();
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
						"test-agent": { model: "openai:gpt-5.5", thinking: "ultra" },
					},
				}),
				"utf-8",
			);

			const config = loadModelsConfig();
			expect(config.agents!["test-agent"].thinking).toBeUndefined();
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown thinking level"));

			warnSpy.mockRestore();
		});

		it("accepts an explicit 'off' thinking level (disable reasoning)", () => {
			writeFileSync(
				configFilePath,
				JSON.stringify({ agents: { "test-agent": { model: "openai/gpt-5.5", thinking: "off" } } }),
				"utf-8",
			);
			expect(loadModelsConfig().agents!["test-agent"]).toEqual({ model: "openai/gpt-5.5", thinking: "off" });
		});

		it("cascades defaults.thinking 'off' into a model-only entry", () => {
			writeFileSync(
				configFilePath,
				JSON.stringify({ defaults: { thinking: "off" }, agents: { a: "openai/gpt-5.5" } }),
				"utf-8",
			);
			expect(loadModelsConfig().agents!.a).toEqual({ model: "openai/gpt-5.5", thinking: "off" });
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

	describe("resolveStageModel", () => {
		it("preset-stage hit wins over flat stage", () => {
			const config: ModelsConfig = {
				stages: { plan: { model: "anthropic/opus" } },
				presets: {
					ship: { stages: { plan: { model: "openai/gpt-5.5" } } },
				},
			};
			expect(resolveStageModel(config, { workflow: "ship", stage: "plan" })).toEqual({
				model: "openai/gpt-5.5",
			});
		});

		it("falls through preset-miss to flat stage", () => {
			const config: ModelsConfig = {
				stages: { plan: { model: "anthropic/opus" } },
				presets: {
					ship: { stages: { research: { model: "openai/gpt-5.5" } } },
				},
			};
			expect(resolveStageModel(config, { workflow: "ship", stage: "plan" })).toEqual({
				model: "anthropic/opus",
			});
		});

		it("falls through preset + stage miss to skills[skill]", () => {
			const config: ModelsConfig = {
				skills: { research: { model: "zai/glm-4-7", thinking: "minimal" } },
			};
			expect(resolveStageModel(config, { workflow: "ship", stage: "research", skill: "research" })).toEqual({
				model: "zai/glm-4-7",
				thinking: "minimal",
			});
		});

		it("falls through everything to defaults", () => {
			const config: ModelsConfig = { defaults: { model: "anthropic/opus" } };
			expect(resolveStageModel(config, { workflow: "ship", stage: "plan", skill: "plan" })).toEqual({
				model: "anthropic/opus",
			});
		});

		it("returns undefined when everything is missing", () => {
			expect(resolveStageModel({}, { workflow: "ship", stage: "plan", skill: "plan" })).toBeUndefined();
		});

		it("skips the skill rung when `skill` is undefined (script stages)", () => {
			const config: ModelsConfig = { skills: { plan: { model: "zai/glm-4-7" } } };
			// No skill arg → skill rung must NOT match even though `skills.plan` exists.
			expect(resolveStageModel(config, { stage: "plan" })).toBeUndefined();
		});

		it("skips the preset rung when `workflow` is undefined (standalone bracket)", () => {
			const config: ModelsConfig = {
				stages: { plan: { model: "anthropic/opus" } },
				presets: {
					ship: { stages: { plan: { model: "openai/gpt-5.5" } } },
				},
			};
			// No workflow arg → preset rung skipped; falls through to flat stages.
			expect(resolveStageModel(config, { stage: "plan", skill: "plan" })).toEqual({
				model: "anthropic/opus",
			});
		});

		it("standalone bracket call shape: skill-only lookup", () => {
			const config: ModelsConfig = {
				defaults: { model: "anthropic/opus" },
				skills: { commit: { model: "zai/glm-4-7" } },
			};
			// Standalone bracket passes only `skill`; preset + stage are undefined.
			expect(resolveStageModel(config, { skill: "commit" })).toEqual({ model: "zai/glm-4-7" });
			expect(resolveStageModel(config, { skill: "unknown" })).toEqual({ model: "anthropic/opus" });
		});
	});

	describe("findUnknownModelKeys", () => {
		const known = {
			agents: ["codebase-analyzer", "codebase-locator"],
			stages: ["research", "plan"],
			skills: ["commit", "design"],
			workflows: ["ship"],
			stagesByWorkflow: { ship: ["research", "plan"] },
		};

		it("returns [] when every key matches", () => {
			const config: ModelsConfig = {
				agents: { "codebase-analyzer": { model: "a/b" } },
				stages: { research: { model: "a/b" } },
				skills: { commit: { model: "a/b" } },
				presets: { ship: { stages: { plan: { model: "a/b" } } } },
			};
			expect(findUnknownModelKeys(config, known)).toEqual([]);
		});

		it("flags typo'd keys across every axis as dotted paths", () => {
			const config: ModelsConfig = {
				agents: { "codebase-analzyer": { model: "a/b" } },
				stages: { reserch: { model: "a/b" } },
				skills: { committ: { model: "a/b" } },
				presets: { ship: { stages: { plann: { model: "a/b" } } } },
			};
			expect(findUnknownModelKeys(config, known).sort()).toEqual(
				["agents.codebase-analzyer", "presets.ship.stages.plann", "skills.committ", "stages.reserch"].sort(),
			);
		});

		it("flags an unknown preset workflow and does not descend into its stages", () => {
			const config: ModelsConfig = {
				presets: { shipp: { stages: { plann: { model: "a/b" } } } },
			};
			expect(findUnknownModelKeys(config, known)).toEqual(["presets.shipp"]);
		});

		it("skips an axis whose known-list is undefined (universe unknown)", () => {
			const config: ModelsConfig = {
				stages: { anything: { model: "a/b" } },
				presets: { whatever: { stages: { x: { model: "a/b" } } } },
			};
			// No `stages`/`workflows` provided → those axes are not validated.
			expect(findUnknownModelKeys(config, { agents: ["codebase-analyzer"], skills: ["commit"] })).toEqual([]);
		});

		it("ignores defaults (no key to validate)", () => {
			const config: ModelsConfig = { defaults: { model: "a/b" } };
			expect(findUnknownModelKeys(config, known)).toEqual([]);
		});
	});
});
