import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { validateDisabledForModels } from "./advisor/config.js";
import { loadAdvisorConfig, saveAdvisorConfig } from "./advisor/index.js";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");

beforeEach(() => {
	try {
		if (existsSync(CONFIG_PATH)) chmodSync(CONFIG_PATH, 0o600);
	} catch {}
});

describe("loadAdvisorConfig", () => {
	it("returns {} when file is absent", () => {
		expect(loadAdvisorConfig()).toEqual({});
	});
	it("returns {} on invalid JSON", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, "{not json", "utf-8");
		expect(loadAdvisorConfig()).toEqual({});
	});
	it("loads well-formed JSON", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, '{"modelKey":"anthropic:opus","effort":"high"}', "utf-8");
		expect(loadAdvisorConfig()).toEqual({ modelKey: "anthropic:opus", effort: "high" });
	});
	it("loads partial object", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, '{"modelKey":"x:y"}', "utf-8");
		expect(loadAdvisorConfig()).toEqual({ modelKey: "x:y" });
	});
});

describe("saveAdvisorConfig", () => {
	it("creates parent dir recursively", () => {
		saveAdvisorConfig("anthropic:opus", "high");
		expect(existsSync(CONFIG_PATH)).toBe(true);
	});
	it("omits undefined fields", () => {
		saveAdvisorConfig("x:y", undefined);
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(parsed).toEqual({ modelKey: "x:y" });
		expect("effort" in parsed).toBe(false);
	});
	it("omits both when both undefined", () => {
		saveAdvisorConfig(undefined, undefined);
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(parsed).toEqual({});
	});
	it("writes JSON with trailing newline", () => {
		saveAdvisorConfig("x:y", "high");
		expect(readFileSync(CONFIG_PATH, "utf-8").endsWith("\n")).toBe(true);
	});
	it.skipIf(process.platform === "win32")("chmods the file to 0600", () => {
		saveAdvisorConfig("x:y", "high");
		const mode = statSync(CONFIG_PATH).mode & 0o777;
		expect(mode).toBe(0o600);
	});
	it("round-trips through loadAdvisorConfig", () => {
		saveAdvisorConfig("a:b", "low");
		expect(loadAdvisorConfig()).toEqual({ modelKey: "a:b", effort: "low" });
	});
});

describe("validateDisabledForModels", () => {
	it("returns [] when input is not an array", () => {
		expect(validateDisabledForModels(undefined)).toEqual([]);
		expect(validateDisabledForModels(null)).toEqual([]);
		expect(validateDisabledForModels("anthropic:opus")).toEqual([]);
		expect(validateDisabledForModels({ model: "anthropic:opus" })).toEqual([]);
	});

	it("keeps non-empty string entries", () => {
		expect(validateDisabledForModels(["anthropic:opus", "openai:gpt"])).toEqual(["anthropic:opus", "openai:gpt"]);
	});

	it("drops empty-string entries", () => {
		expect(validateDisabledForModels(["", "anthropic:opus"])).toEqual(["anthropic:opus"]);
	});

	it("keeps object entries with valid model and no minEffort", () => {
		expect(validateDisabledForModels([{ model: "anthropic:opus" }])).toEqual([{ model: "anthropic:opus" }]);
	});

	it("keeps object entries with valid minEffort from EFFORT_ORDINAL", () => {
		expect(
			validateDisabledForModels([
				{ model: "anthropic:opus", minEffort: "minimal" },
				{ model: "anthropic:opus", minEffort: "xhigh" },
				{ model: "anthropic:opus", minEffort: "max" },
			]),
		).toEqual([
			{ model: "anthropic:opus", minEffort: "minimal" },
			{ model: "anthropic:opus", minEffort: "xhigh" },
			{ model: "anthropic:opus", minEffort: "max" },
		]);
	});

	it("drops object entries with empty model", () => {
		expect(validateDisabledForModels([{ model: "" }])).toEqual([]);
	});

	it("drops object entries with non-string model", () => {
		expect(validateDisabledForModels([{ model: 42 }])).toEqual([]);
	});

	it("drops object entries with invalid minEffort", () => {
		expect(validateDisabledForModels([{ model: "anthropic:opus", minEffort: "bogus" }])).toEqual([]);
	});

	it("drops null and non-object entries", () => {
		expect(validateDisabledForModels([null, 42, true, undefined, "anthropic:opus"])).toEqual(["anthropic:opus"]);
	});

	it("preserves order of valid entries while dropping invalid", () => {
		expect(
			validateDisabledForModels([
				"anthropic:opus",
				{ model: "" },
				{ model: "anthropic:sonnet", minEffort: "high" },
				"openai:gpt",
			]),
		).toEqual(["anthropic:opus", { model: "anthropic:sonnet", minEffort: "high" }, "openai:gpt"]);
	});
});
