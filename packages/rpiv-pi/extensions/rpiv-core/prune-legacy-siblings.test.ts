import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { findLegacySiblings, pruneLegacySiblings } from "./prune-legacy-siblings.js";
import { getPiAgentSettingsPath } from "./utils.js";

function writeSettingsRaw(raw: string): void {
	const settingsPath = getPiAgentSettingsPath();
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, raw, "utf-8");
}

function writeSettings(contents: unknown): void {
	writeSettingsRaw(JSON.stringify(contents));
}

function readSettingsRaw(): string {
	return readFileSync(getPiAgentSettingsPath(), "utf-8");
}

function readSettings(): unknown {
	return JSON.parse(readSettingsRaw());
}

describe("pruneLegacySiblings", () => {
	it("no settings file → pruned: []", () => {
		expect(pruneLegacySiblings()).toEqual({ pruned: [] });
	});

	it("invalid JSON → pruned: [], file byte-exact unchanged", () => {
		writeSettingsRaw("{not json");
		expect(pruneLegacySiblings()).toEqual({ pruned: [] });
		expect(readSettingsRaw()).toBe("{not json");
	});

	it("non-object top-level (array) → pruned: [], file unchanged", () => {
		writeSettings([1, 2, 3]);
		expect(pruneLegacySiblings()).toEqual({ pruned: [] });
		expect(readSettings()).toEqual([1, 2, 3]);
	});

	it("no packages field → pruned: []", () => {
		writeSettings({ other: "data" });
		expect(pruneLegacySiblings()).toEqual({ pruned: [] });
		expect(readSettings()).toEqual({ other: "data" });
	});

	it("non-array packages field → pruned: []", () => {
		writeSettings({ packages: "not-array" });
		expect(pruneLegacySiblings()).toEqual({ pruned: [] });
	});

	it("only non-legacy entries → pruned: [], file unchanged", () => {
		writeSettings({
			packages: ["npm:pi-perplexity", "npm:@juicesharp/rpiv-todo", "npm:@tintinweb/pi-subagents"],
		});
		const before = readSettingsRaw();
		expect(pruneLegacySiblings()).toEqual({ pruned: [] });
		expect(readSettingsRaw()).toBe(before);
	});

	it("legacy-only: removes pi-subagents (nicobailon fork), preserves other top-level keys", () => {
		writeSettings({
			defaultProvider: "zai",
			theme: "dark",
			packages: ["npm:pi-subagents"],
		});
		const result = pruneLegacySiblings();
		expect(result.pruned).toEqual(["npm:pi-subagents"]);
		expect(readSettings()).toEqual({
			defaultProvider: "zai",
			theme: "dark",
			packages: [],
		});
	});

	it("mixed list: prunes nicobailon's pi-subagents only, preserves @tintinweb/pi-subagents and other entries", () => {
		writeSettings({
			packages: [
				"npm:pi-perplexity",
				"npm:@tintinweb/pi-subagents",
				"npm:@juicesharp/rpiv-todo",
				"/Users/x/rpiv-mono/packages/rpiv-pi",
				null,
				42,
				"npm:pi-subagents",
			],
		});
		const result = pruneLegacySiblings();
		expect(result.pruned).toEqual(["npm:pi-subagents"]);
		expect(readSettings()).toEqual({
			packages: [
				"npm:pi-perplexity",
				"npm:@tintinweb/pi-subagents",
				"npm:@juicesharp/rpiv-todo",
				"/Users/x/rpiv-mono/packages/rpiv-pi",
				null,
				42,
			],
		});
	});

	it("prunes settings from PI_CODING_AGENT_DIR when configured", () => {
		process.env.PI_CODING_AGENT_DIR = join(process.env.HOME!, ".config", "pi", "agent");
		writeSettings({
			packages: ["npm:pi-subagents"],
		});
		expect(pruneLegacySiblings().pruned).toEqual(["npm:pi-subagents"]);
		expect(readSettings()).toEqual({ packages: [] });
	});

	it("idempotent: second call after prune is a no-op", () => {
		writeSettings({
			packages: ["npm:pi-subagents"],
		});
		expect(pruneLegacySiblings().pruned).toEqual(["npm:pi-subagents"]);
		expect(pruneLegacySiblings()).toEqual({ pruned: [] });
	});

	it("case-insensitive match", () => {
		writeSettings({
			packages: ["NPM:Pi-Subagents"],
		});
		expect(pruneLegacySiblings().pruned).toEqual(["NPM:Pi-Subagents"]);
	});
});

describe("findLegacySiblings (read-only scan)", () => {
	it("no settings file → []", () => {
		expect(findLegacySiblings()).toEqual([]);
	});

	it("invalid JSON → []", () => {
		writeSettingsRaw("{not json");
		expect(findLegacySiblings()).toEqual([]);
	});

	it("non-object top-level → []", () => {
		writeSettings([1, 2, 3]);
		expect(findLegacySiblings()).toEqual([]);
	});

	it("no packages field → []", () => {
		writeSettings({ other: "data" });
		expect(findLegacySiblings()).toEqual([]);
	});

	it("non-array packages field → []", () => {
		writeSettings({ packages: "not-array" });
		expect(findLegacySiblings()).toEqual([]);
	});

	it("only non-legacy entries → []", () => {
		writeSettings({
			packages: ["npm:pi-perplexity", "npm:@juicesharp/rpiv-todo", "npm:@tintinweb/pi-subagents"],
		});
		expect(findLegacySiblings()).toEqual([]);
	});

	it("returns legacy entries without mutating settings.json", () => {
		writeSettings({
			defaultProvider: "zai",
			packages: ["npm:pi-subagents", "npm:@juicesharp/rpiv-todo"],
		});
		const before = readSettingsRaw();
		expect(findLegacySiblings()).toEqual(["npm:pi-subagents"]);
		expect(readSettingsRaw()).toBe(before);
	});

	it("reads settings from PI_CODING_AGENT_DIR when configured", () => {
		process.env.PI_CODING_AGENT_DIR = join(process.env.HOME!, ".config", "pi", "agent");
		writeSettings({ packages: ["npm:pi-subagents"] });
		expect(findLegacySiblings()).toEqual(["npm:pi-subagents"]);
	});

	it("idempotent: repeat call returns the same list and does not mutate", () => {
		writeSettings({ packages: ["npm:pi-subagents"] });
		const before = readSettingsRaw();
		expect(findLegacySiblings()).toEqual(["npm:pi-subagents"]);
		expect(findLegacySiblings()).toEqual(["npm:pi-subagents"]);
		expect(readSettingsRaw()).toBe(before);
	});
});
