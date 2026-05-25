import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getPiAgentSettingsPath,
	isPlainObject,
	PI_AGENT_SETTINGS,
	readPiAgentSettings,
	toErrorMessage,
} from "./utils.js";

function writeSettingsRaw(raw: string, path = getPiAgentSettingsPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, raw, "utf-8");
}

function writeSettings(contents: unknown, path = getPiAgentSettingsPath()): void {
	writeSettingsRaw(JSON.stringify(contents), path);
}

describe("isPlainObject", () => {
	it("accepts plain objects", () => {
		expect(isPlainObject({})).toBe(true);
		expect(isPlainObject({ a: 1 })).toBe(true);
		expect(isPlainObject(Object.create(null))).toBe(true);
	});

	it("rejects arrays", () => {
		expect(isPlainObject([])).toBe(false);
		expect(isPlainObject([1, 2, 3])).toBe(false);
	});

	it("rejects null and undefined", () => {
		expect(isPlainObject(null)).toBe(false);
		expect(isPlainObject(undefined)).toBe(false);
	});

	it("rejects primitives", () => {
		expect(isPlainObject(0)).toBe(false);
		expect(isPlainObject("")).toBe(false);
		expect(isPlainObject("hello")).toBe(false);
		expect(isPlainObject(true)).toBe(false);
		expect(isPlainObject(false)).toBe(false);
	});
});

describe("toErrorMessage", () => {
	it("returns Error.message for Error instances", () => {
		expect(toErrorMessage(new Error("boom"))).toBe("boom");
	});

	it("returns Error.message for subclasses of Error", () => {
		expect(toErrorMessage(new TypeError("bad type"))).toBe("bad type");
	});

	it("returns String(value) for non-Error inputs without fallback", () => {
		expect(toErrorMessage("oops")).toBe("oops");
		expect(toErrorMessage(42)).toBe("42");
		expect(toErrorMessage(null)).toBe("null");
		expect(toErrorMessage(undefined)).toBe("undefined");
	});

	it("uses the fallback for non-Error inputs when provided", () => {
		expect(toErrorMessage("oops", "Failed to do thing")).toBe("Failed to do thing");
		expect(toErrorMessage(undefined, "Failed to do thing")).toBe("Failed to do thing");
		expect(toErrorMessage({ weird: true }, "Failed to do thing")).toBe("Failed to do thing");
	});

	it("prefers Error.message over the fallback", () => {
		expect(toErrorMessage(new Error("real cause"), "Failed to do thing")).toBe("real cause");
	});
});

describe("getPiAgentSettingsPath", () => {
	it("uses ~/.pi/agent/settings.json when PI_CODING_AGENT_DIR is unset", () => {
		expect(getPiAgentSettingsPath()).toBe(PI_AGENT_SETTINGS);
	});

	it("uses PI_CODING_AGENT_DIR/settings.json when configured", () => {
		process.env.PI_CODING_AGENT_DIR = join(process.env.HOME!, ".config", "pi", "agent");
		expect(getPiAgentSettingsPath()).toBe(join(process.env.HOME!, ".config", "pi", "agent", "settings.json"));
	});
});

describe("readPiAgentSettings", () => {
	it("returns undefined when the settings file is missing", () => {
		rmSync(PI_AGENT_SETTINGS, { force: true });
		expect(readPiAgentSettings()).toBeUndefined();
	});

	it("returns undefined when the file contains invalid JSON", () => {
		writeSettingsRaw("{not json");
		expect(readPiAgentSettings()).toBeUndefined();
	});

	it("returns undefined when the top-level value is not a plain object", () => {
		writeSettings([1, 2, 3]);
		expect(readPiAgentSettings()).toBeUndefined();
	});

	it("returns undefined when packages is missing", () => {
		writeSettings({ other: "data" });
		expect(readPiAgentSettings()).toBeUndefined();
	});

	it("returns undefined when packages is not an array", () => {
		writeSettings({ packages: "not-array" });
		expect(readPiAgentSettings()).toBeUndefined();
	});

	it("returns parsed settings + packages array when valid", () => {
		writeSettings({
			defaultProvider: "zai",
			packages: ["npm:pi-perplexity", "npm:@juicesharp/rpiv-todo"],
		});
		const result = readPiAgentSettings();
		expect(result).toBeDefined();
		expect(result?.packages).toEqual(["npm:pi-perplexity", "npm:@juicesharp/rpiv-todo"]);
		expect(result?.settings).toEqual({
			defaultProvider: "zai",
			packages: ["npm:pi-perplexity", "npm:@juicesharp/rpiv-todo"],
		});
	});

	it("reads from PI_CODING_AGENT_DIR/settings.json when configured", () => {
		process.env.PI_CODING_AGENT_DIR = join(process.env.HOME!, ".config", "pi", "agent");
		writeSettings({ packages: ["npm:@juicesharp/rpiv-todo"] });
		expect(readPiAgentSettings()?.packages).toEqual(["npm:@juicesharp/rpiv-todo"]);
	});

	it("preserves non-string entries inside packages (caller responsibility to filter)", () => {
		writeSettings({ packages: [null, 42, "npm:pi-subagents"] });
		const result = readPiAgentSettings();
		expect(result?.packages).toEqual([null, 42, "npm:pi-subagents"]);
	});

	it("preserves an empty packages array", () => {
		writeSettings({ packages: [] });
		const result = readPiAgentSettings();
		expect(result?.packages).toEqual([]);
		expect(result?.settings).toEqual({ packages: [] });
	});
});
