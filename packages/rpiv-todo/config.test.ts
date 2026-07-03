import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_WIDGET_LINES, getMaxWidgetLines } from "./config.js";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-todo", "config.json");

function writeConfigFile(contents: string): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, contents, "utf-8");
}
function removeConfigFile(): void {
	rmSync(CONFIG_PATH, { force: true });
}

beforeEach(removeConfigFile);
afterEach(removeConfigFile);

describe("getMaxWidgetLines", () => {
	it("returns the default when no config is present", () => {
		expect(getMaxWidgetLines()).toBe(DEFAULT_MAX_WIDGET_LINES);
	});
	it("returns the default when the field is absent", () => {
		writeConfigFile(JSON.stringify({}));
		expect(getMaxWidgetLines()).toBe(DEFAULT_MAX_WIDGET_LINES);
	});
	it("returns the default for non-number values", () => {
		writeConfigFile(JSON.stringify({ maxWidgetLines: "twelve" }));
		expect(getMaxWidgetLines()).toBe(DEFAULT_MAX_WIDGET_LINES);
	});
	it("returns the default for values below the floor (2, 1, 0, -5)", () => {
		writeConfigFile(JSON.stringify({ maxWidgetLines: 2 }));
		expect(getMaxWidgetLines()).toBe(DEFAULT_MAX_WIDGET_LINES);
		writeConfigFile(JSON.stringify({ maxWidgetLines: 1 }));
		expect(getMaxWidgetLines()).toBe(DEFAULT_MAX_WIDGET_LINES);
		writeConfigFile(JSON.stringify({ maxWidgetLines: 0 }));
		expect(getMaxWidgetLines()).toBe(DEFAULT_MAX_WIDGET_LINES);
		writeConfigFile(JSON.stringify({ maxWidgetLines: -5 }));
		expect(getMaxWidgetLines()).toBe(DEFAULT_MAX_WIDGET_LINES);
	});
	it("returns the configured value at the floor (3) and above — no ceiling", () => {
		writeConfigFile(JSON.stringify({ maxWidgetLines: 3 }));
		expect(getMaxWidgetLines()).toBe(3);
		writeConfigFile(JSON.stringify({ maxWidgetLines: 8 }));
		expect(getMaxWidgetLines()).toBe(8);
		writeConfigFile(JSON.stringify({ maxWidgetLines: 50 }));
		expect(getMaxWidgetLines()).toBe(50);
	});
});
