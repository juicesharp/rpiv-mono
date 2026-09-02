import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadVoiceConfig, resolveNumThreads, saveVoiceConfig } from "./voice-config.js";

const CONFIG_PATH = join(homedir(), ".config", "rpiv-voice", "voice.json");

describe("loadVoiceConfig", () => {
	it("returns empty object when config file is missing", () => {
		expect(loadVoiceConfig()).toEqual({});
	});
	it("returns empty object when JSON is corrupted", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, "not json", "utf-8");
		expect(loadVoiceConfig()).toEqual({});
	});
	it("roundtrips hallucinationFilterEnabled", () => {
		saveVoiceConfig({ hallucinationFilterEnabled: false });
		const config = loadVoiceConfig();
		expect(config.hallucinationFilterEnabled).toBe(false);
	});
});

describe("saveVoiceConfig", () => {
	it("creates config directory if missing (parent does not exist pre-call)", () => {
		saveVoiceConfig({ hallucinationFilterEnabled: false });
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		expect(JSON.parse(raw).hallucinationFilterEnabled).toBe(false);
	});
});

describe("resolveNumThreads", () => {
	it("falls back to the default when the key is missing", () => {
		expect(resolveNumThreads({})).toBe(4);
	});

	it("falls back to the default on non-number values", () => {
		expect(resolveNumThreads({ numThreads: "8" as unknown as number })).toBe(4);
		expect(resolveNumThreads({ numThreads: null as unknown as number })).toBe(4);
		expect(resolveNumThreads({ numThreads: Number.NaN })).toBe(4);
	});

	it("falls back to the default on non-integers", () => {
		expect(resolveNumThreads({ numThreads: 8.5 })).toBe(4);
	});

	it("falls back to the default below the floor", () => {
		expect(resolveNumThreads({ numThreads: 0 })).toBe(4);
		expect(resolveNumThreads({ numThreads: -2 })).toBe(4);
	});

	it("passes integers 1–16 through (both endpoints)", () => {
		expect(resolveNumThreads({ numThreads: 1 })).toBe(1);
		expect(resolveNumThreads({ numThreads: 8 })).toBe(8);
		expect(resolveNumThreads({ numThreads: 16 })).toBe(16);
	});

	it("clamps integers above 16 to 16", () => {
		expect(resolveNumThreads({ numThreads: 32 })).toBe(16);
	});
});
