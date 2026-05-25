import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { findMissingSiblings } from "./package-checks.js";
import { SIBLINGS } from "./siblings.js";
import { getPiAgentSettingsPath } from "./utils.js";

function writeSettings(contents: unknown) {
	const settingsPath = getPiAgentSettingsPath();
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(contents), "utf-8");
}

describe("findMissingSiblings", () => {
	it("returns all 7 siblings when settings.json is missing", () => {
		expect(findMissingSiblings()).toHaveLength(SIBLINGS.length);
	});

	it("returns all 7 siblings when JSON is invalid", () => {
		const settingsPath = getPiAgentSettingsPath();
		mkdirSync(dirname(settingsPath), { recursive: true });
		writeFileSync(settingsPath, "{not json", "utf-8");
		expect(findMissingSiblings()).toHaveLength(SIBLINGS.length);
	});

	it("returns all 7 siblings when packages field is absent", () => {
		writeSettings({ other: "data" });
		expect(findMissingSiblings()).toHaveLength(SIBLINGS.length);
	});

	it("returns all 7 siblings when packages is not an array", () => {
		writeSettings({ packages: "not-array" });
		expect(findMissingSiblings()).toHaveLength(SIBLINGS.length);
	});

	it("filters out non-string entries defensively", () => {
		writeSettings({ packages: [null, 42, "@juicesharp/rpiv-todo"] });
		const missing = findMissingSiblings();
		expect(missing.find((s) => s.matches.test("@juicesharp/rpiv-todo"))).toBeUndefined();
	});

	it("matches case-insensitively", () => {
		writeSettings({ packages: ["@JUICESHARP/RPIV-TODO"] });
		const missing = findMissingSiblings();
		expect(missing.find((s) => s.matches.test("@juicesharp/rpiv-todo"))).toBeUndefined();
	});

	it("rpiv-args word-boundary: treats rpiv-args-extended as non-install", () => {
		writeSettings({ packages: ["@juicesharp/rpiv-args-extended"] });
		const missing = findMissingSiblings();
		expect(missing.find((s) => s.pkg.endsWith("/rpiv-args"))).toBeDefined();
	});

	it("returns [] when all 7 siblings are installed", () => {
		writeSettings({
			packages: SIBLINGS.map((s) => s.pkg.replace(/^npm:/, "")),
		});
		expect(findMissingSiblings()).toEqual([]);
	});

	it("reads settings from PI_CODING_AGENT_DIR when configured", () => {
		process.env.PI_CODING_AGENT_DIR = join(process.env.HOME!, ".config", "pi", "agent");
		writeSettings({
			packages: SIBLINGS.map((s) => s.pkg.replace(/^npm:/, "")),
		});
		expect(findMissingSiblings()).toEqual([]);
	});
});
