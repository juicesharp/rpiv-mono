import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAdvisorConfig, saveAdvisorConfig } from "./advisor.js";

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
