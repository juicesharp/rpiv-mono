import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type AskUserQuestionConfig,
	COLLAPSE_KEY_OFF,
	DEFAULT_COLLAPSE_KEY,
	loadConfig,
	resolveCollapseKey,
} from "./config.js";

describe("resolveCollapseKey", () => {
	it("returns the default when config has no collapseKey", () => {
		expect(resolveCollapseKey({})).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: undefined })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("returns the default when collapseKey is empty or whitespace", () => {
		expect(resolveCollapseKey({ collapseKey: "" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "   " })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("normalizes the spec (trim + lowercase)", () => {
		expect(resolveCollapseKey({ collapseKey: "  Ctrl+}  " })).toBe("ctrl+}");
		expect(resolveCollapseKey({ collapseKey: "ALT+O" })).toBe("alt+o");
	});

	it("returns the off sentinel unchanged (case-insensitive)", () => {
		expect(resolveCollapseKey({ collapseKey: "off" })).toBe(COLLAPSE_KEY_OFF);
		expect(resolveCollapseKey({ collapseKey: "OFF" })).toBe(COLLAPSE_KEY_OFF);
		expect(resolveCollapseKey({ collapseKey: "  off  " })).toBe(COLLAPSE_KEY_OFF);
	});

	it("falls back to the default for malformed specs", () => {
		// Leading/trailing +, double ++, or empty
		expect(resolveCollapseKey({ collapseKey: "+ctrl+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "ctrl++" })).toBe(DEFAULT_COLLAPSE_KEY);
		// The default itself is valid
		expect(resolveCollapseKey({ collapseKey: "ctrl+]" })).toBe("ctrl+]");
		// Multi-modifier specs are valid (the regex is permissive on the base char)
		expect(resolveCollapseKey({ collapseKey: "ctrl+shift+h" })).toBe("ctrl+shift+h");
	});
});

describe("loadConfig", () => {
	// Use the test HOME set by the project's setup.ts. The config module resolves
	// `~` at import time, so we use the directory that setup.ts has already wired up
	// and write a per-test config inside it.
	const home = process.env.HOME ?? "";
	const configPath = join(home, ".config", "rpiv-ask-user-question", "config.json");

	// We can't mutate HOME here (configPath was resolved at import time, see
	// the read in `loadJsonConfig` for the design rationale), so we test against
	// the directory setup.ts points at and clean up after ourselves.
	const removeConfig = (): void => {
		if (existsSync(configPath)) rmSync(configPath);
	};

	it("returns an empty config when no file is present", () => {
		removeConfig();
		expect(loadConfig().collapseKey).toBeUndefined();
	});

	it("reads a valid JSON config", () => {
		mkdirSync(join(home, ".config", "rpiv-ask-user-question"), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({ collapseKey: "alt+o", guidance: { promptSnippet: "x" } } satisfies AskUserQuestionConfig),
		);
		const c = loadConfig();
		expect(c.collapseKey).toBe("alt+o");
		expect(c.guidance?.promptSnippet).toBe("x");
		removeConfig();
		vi.restoreAllMocks();
	});
});
