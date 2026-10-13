import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { findInstalledSiblings, findMissingSiblings, type LoadedSiblingSources } from "./package-checks.js";
import { SIBLINGS } from "./siblings.js";
import { getPiAgentSettingsPath } from "./utils.js";

function writeSettings(contents: unknown) {
	const settingsPath = getPiAgentSettingsPath();
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(contents), "utf-8");
}

// #216 — presence is settings ∪ loaded. Every scenario below either keeps the
// settings-only answer (existing users, fresh installs) or adds a sibling whose
// code is provably loaded; none can turn a present sibling into a missing one.
describe("findMissingSiblings / findInstalledSiblings — settings ∪ loaded (#216)", () => {
	const ARGS_MARKER = "@juicesharp/rpiv-args:loaded";
	const loaded = (extensionPaths: string[], markers: string[] = []): LoadedSiblingSources => ({
		extensionPaths,
		markers: new Set(markers),
	});
	const NOTHING_LOADED = loaded([]);
	const names = (list: { pkg: string }[]) => list.map((s) => s.pkg.replace(/^npm:/, ""));
	const ALL_IN_SETTINGS = SIBLINGS.map((s) => s.pkg);
	const KIT = "/home/u/.pi/agent/npm/node_modules/frida-pi-studio/node_modules";

	it("no snapshot and an empty snapshot both give exactly the settings-only answer", () => {
		writeSettings({ packages: ["npm:@juicesharp/rpiv-todo"] });
		const settingsOnly = names(findMissingSiblings());
		expect(names(findMissingSiblings(NOTHING_LOADED))).toEqual(settingsOnly);
		expect(names(findInstalledSiblings(NOTHING_LOADED))).toEqual(names(findInstalledSiblings()));
	});

	it("fresh install (rpiv-pi only, nothing loaded): every sibling is missing", () => {
		writeSettings({ packages: ["npm:@juicesharp/rpiv-pi"] });
		expect(findMissingSiblings(NOTHING_LOADED)).toHaveLength(SIBLINGS.length);
	});

	it("standard install (every sibling in settings): nothing is missing", () => {
		writeSettings({ packages: ALL_IN_SETTINGS });
		expect(findMissingSiblings(NOTHING_LOADED)).toEqual([]);
	});

	it("declared in settings but not loaded (failed load) still counts as installed", () => {
		writeSettings({ packages: ["npm:@juicesharp/rpiv-todo"] });
		expect(names(findInstalledSiblings(NOTHING_LOADED))).toContain("@juicesharp/rpiv-todo");
	});

	it("bundled in a kit: a sibling loaded by path is present, the rest stay missing", () => {
		writeSettings({ packages: ["npm:frida-pi-studio"] });
		const snapshot = loaded([`${KIT}/@juicesharp/rpiv-todo/index.ts`, `${KIT}/@tintinweb/pi-subagents/src/index.ts`]);
		const missing = names(findMissingSiblings(snapshot));
		expect(missing).not.toContain("@juicesharp/rpiv-todo");
		expect(missing).not.toContain("@tintinweb/pi-subagents");
		expect(missing).toHaveLength(SIBLINGS.length - 2);
		expect(names(findInstalledSiblings(snapshot)).sort()).toEqual([
			"@juicesharp/rpiv-todo",
			"@tintinweb/pi-subagents",
		]);
	});

	it("project install (pi install -l, absent from personal settings) is present once loaded", () => {
		writeSettings({ packages: [] });
		const snapshot = loaded(["/repo/.pi/npm/node_modules/@juicesharp/rpiv-web-tools/index.ts"]);
		expect(names(findMissingSiblings(snapshot))).not.toContain("@juicesharp/rpiv-web-tools");
	});

	it("no settings file at all: loaded siblings are still found", () => {
		const snapshot = loaded([`${KIT}/@juicesharp/rpiv-advisor/index.ts`]);
		expect(names(findMissingSiblings(snapshot))).not.toContain("@juicesharp/rpiv-advisor");
		expect(findMissingSiblings(snapshot)).toHaveLength(SIBLINGS.length - 1);
	});

	it("a filtered object-form entry whose extension did not load stays missing (unchanged)", () => {
		writeSettings({ packages: [{ source: "npm:@juicesharp/rpiv-todo", extensions: [] }] });
		expect(names(findMissingSiblings(NOTHING_LOADED))).toContain("@juicesharp/rpiv-todo");
	});

	it("an unrelated extension (a tool named `todo` elsewhere) does not count", () => {
		writeSettings({ packages: [] });
		const snapshot = loaded([
			"/home/u/extensions/my-todo-tool/index.ts",
			`${KIT}/@juicesharp/rpiv-args-extended/index.ts`,
		]);
		expect(findMissingSiblings(snapshot)).toHaveLength(SIBLINGS.length);
	});

	it("the registry's rpiv-args marker is the key rpiv-args sets (LOADED_MARKER)", () => {
		expect(SIBLINGS.find((s) => s.pkg === "npm:@juicesharp/rpiv-args")?.marker).toBe(ARGS_MARKER);
		expect(SIBLINGS.filter((s) => s.marker !== undefined)).toHaveLength(1);
	});

	it("rpiv-args: the presence marker counts; without it, settings decide (old rpiv-args)", () => {
		writeSettings({ packages: [] });
		expect(names(findMissingSiblings(loaded([], [ARGS_MARKER])))).not.toContain("@juicesharp/rpiv-args");
		expect(names(findMissingSiblings(NOTHING_LOADED))).toContain("@juicesharp/rpiv-args");
		writeSettings({ packages: ["npm:@juicesharp/rpiv-args"] });
		expect(names(findMissingSiblings(NOTHING_LOADED))).not.toContain("@juicesharp/rpiv-args");
	});
});
