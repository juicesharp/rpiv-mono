import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadVoiceConfig, saveVoiceConfig } from "./voice-config.js";

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
	it("roundtrips whisperModelType", () => {
		saveVoiceConfig({ whisperModelType: "tiny" });
		const config = loadVoiceConfig();
		expect(config.whisperModelType).toBe("tiny");
	});
});

describe("saveVoiceConfig", () => {
	it("creates config directory if missing (parent does not exist pre-call)", () => {
		saveVoiceConfig({ hallucinationFilterEnabled: false });
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		expect(JSON.parse(raw).hallucinationFilterEnabled).toBe(false);
	});
});
