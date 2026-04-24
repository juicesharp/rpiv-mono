import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureBuiltinsDisabled } from "./ensure-builtins-disabled.js";

const SETTINGS_PATH = join(process.env.HOME!, ".pi", "agent", "settings.json");

function writeSettings(contents: unknown): void {
	mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
	writeFileSync(SETTINGS_PATH, JSON.stringify(contents), "utf-8");
}

function readSettings(): unknown {
	return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
}

describe("ensureBuiltinsDisabled", () => {
	it("no settings file → disabled: false", () => {
		expect(ensureBuiltinsDisabled()).toEqual({ disabled: false });
	});

	it("invalid JSON → disabled: false, file byte-exact unchanged", () => {
		mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
		writeFileSync(SETTINGS_PATH, "{not json", "utf-8");
		expect(ensureBuiltinsDisabled()).toEqual({ disabled: false });
		expect(readFileSync(SETTINGS_PATH, "utf-8")).toBe("{not json");
	});

	it("non-object top-level → disabled: false, file unchanged", () => {
		writeSettings([1, 2, 3]);
		expect(ensureBuiltinsDisabled()).toEqual({ disabled: false });
		expect(readSettings()).toEqual([1, 2, 3]);
	});

	it("absent subagents key: writes minimal subagents.disableBuiltins block, preserves other keys", () => {
		writeSettings({
			defaultProvider: "zai",
			theme: "dark",
			packages: ["npm:pi-subagents"],
		});
		expect(ensureBuiltinsDisabled()).toEqual({ disabled: true });
		expect(readSettings()).toEqual({
			defaultProvider: "zai",
			theme: "dark",
			packages: ["npm:pi-subagents"],
			subagents: { disableBuiltins: true },
		});
	});

	it("subagents object exists without disableBuiltins: adds key, preserves siblings (e.g. agentOverrides)", () => {
		writeSettings({
			subagents: {
				agentOverrides: { scout: { model: "glm-5.1" } },
			},
		});
		expect(ensureBuiltinsDisabled()).toEqual({ disabled: true });
		expect(readSettings()).toEqual({
			subagents: {
				agentOverrides: { scout: { model: "glm-5.1" } },
				disableBuiltins: true,
			},
		});
	});

	it("user-wins: explicit disableBuiltins: true → no-op (idempotent)", () => {
		writeSettings({ subagents: { disableBuiltins: true } });
		const before = readFileSync(SETTINGS_PATH, "utf-8");
		expect(ensureBuiltinsDisabled()).toEqual({ disabled: false });
		expect(readFileSync(SETTINGS_PATH, "utf-8")).toBe(before);
	});

	it("user-wins: explicit disableBuiltins: false → respected, NOT overwritten", () => {
		writeSettings({ subagents: { disableBuiltins: false } });
		expect(ensureBuiltinsDisabled()).toEqual({ disabled: false });
		expect(readSettings()).toEqual({ subagents: { disableBuiltins: false } });
	});

	it("subagents is non-object (string) → no-op", () => {
		writeSettings({ subagents: "not-object" });
		expect(ensureBuiltinsDisabled()).toEqual({ disabled: false });
		expect(readSettings()).toEqual({ subagents: "not-object" });
	});
});
