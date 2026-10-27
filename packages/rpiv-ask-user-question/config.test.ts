import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AskUserQuestionConfig,
	COLLAPSE_KEY_OFF,
	DEFAULT_BELL,
	DEFAULT_COLLAPSE_KEY,
	DEFAULT_NOTES_KEY,
	formatKeySpecForDisplay,
	formatNotesKeyForDisplay,
	loadConfig,
	resolveBell,
	resolveCollapseKey,
	resolveNotesKey,
} from "./config.ts";

describe("formatKeySpecForDisplay", () => {
	it("capitalizes each +-part of a resolved spec", () => {
		expect(formatKeySpecForDisplay("ctrl+]")).toBe("Ctrl+]");
		expect(formatKeySpecForDisplay("alt+o")).toBe("Alt+O");
		expect(formatKeySpecForDisplay("ctrl+shift+h")).toBe("Ctrl+Shift+H");
	});

	it("handles named special keys and bare keys", () => {
		expect(formatKeySpecForDisplay("f9")).toBe("F9");
		expect(formatKeySpecForDisplay("alt+escape")).toBe("Alt+Escape");
		expect(formatKeySpecForDisplay("]")).toBe("]");
	});

	it("cases compound-word named keys conventionally", () => {
		expect(formatKeySpecForDisplay("ctrl+pagedown")).toBe("Ctrl+PageDown");
		expect(formatKeySpecForDisplay("pageup")).toBe("PageUp");
	});

	it("round-trips the default key to the historical hint casing", () => {
		expect(formatKeySpecForDisplay(DEFAULT_COLLAPSE_KEY)).toBe("Ctrl+]");
	});
});

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
		// Multi-modifier specs are valid
		expect(resolveCollapseKey({ collapseKey: "ctrl+shift+h" })).toBe("ctrl+shift+h");
	});

	it("falls back to the default for typo'd modifiers and unknown key names", () => {
		// `ctr+]` is the dangerous one: pi-tui's parseKeyId takes the LAST `+`-part as
		// the key and ignores unknown parts, so an unvalidated `ctr+]` would match every
		// bare `]` keypress and the raw terminal listener would consume them globally.
		expect(resolveCollapseKey({ collapseKey: "ctr+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "control+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "ctrl+nosuchkey" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "hello" })).toBe(DEFAULT_COLLAPSE_KEY);
		// Duplicate modifiers are not part of the KeyId grammar
		expect(resolveCollapseKey({ collapseKey: "ctrl+ctrl+]" })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("accepts named special keys and bare base keys", () => {
		expect(resolveCollapseKey({ collapseKey: "ctrl+pageup" })).toBe("ctrl+pageup");
		expect(resolveCollapseKey({ collapseKey: "Ctrl+PageUp" })).toBe("ctrl+pageup");
		expect(resolveCollapseKey({ collapseKey: "f5" })).toBe("f5");
		expect(resolveCollapseKey({ collapseKey: "alt+escape" })).toBe("alt+escape");
	});
});

describe("resolveNotesKey", () => {
	it("defaults to n", () => {
		expect(DEFAULT_NOTES_KEY).toBe("n");
		expect(resolveNotesKey({})).toBe("n");
		expect(resolveNotesKey({ notesKey: "  " })).toBe("n");
	});

	it("keeps a single character of any script as typed", () => {
		expect(resolveNotesKey({ notesKey: "т" })).toBe("т");
		expect(resolveNotesKey({ notesKey: " ñ " })).toBe("ñ");
		expect(resolveNotesKey({ notesKey: "N" })).toBe("N");
	});

	it("normalizes a modifier spec", () => {
		expect(resolveNotesKey({ notesKey: "Ctrl+N" })).toBe("ctrl+n");
		expect(resolveNotesKey({ notesKey: "alt+o" })).toBe("alt+o");
	});

	it("falls back to n for malformed specs and the keys the questionnaire navigates with", () => {
		for (const notesKey of ["ctr+n", "тт", "space", "Enter", "tab", "escape", "up", "left"]) {
			expect(resolveNotesKey({ notesKey }), notesKey).toBe("n");
		}
	});
});

describe("resolveBell", () => {
	it("defaults to true", () => {
		expect(DEFAULT_BELL).toBe(true);
		expect(resolveBell({})).toBe(true);
		expect(resolveBell({ bell: undefined })).toBe(true);
	});

	it("honors an explicit false", () => {
		expect(resolveBell({ bell: false })).toBe(false);
	});

	it("falls back to true for non-boolean values", () => {
		expect(resolveBell({ bell: "false" } as unknown as AskUserQuestionConfig)).toBe(true);
		expect(resolveBell({ bell: 0 } as unknown as AskUserQuestionConfig)).toBe(true);
		expect(resolveBell({ bell: null } as unknown as AskUserQuestionConfig)).toBe(true);
	});
});

describe("formatNotesKeyForDisplay", () => {
	it("shows a single character as configured and a spec display-cased", () => {
		expect(formatNotesKeyForDisplay("n")).toBe("n");
		expect(formatNotesKeyForDisplay("т")).toBe("т");
		expect(formatNotesKeyForDisplay("ctrl+n")).toBe("Ctrl+N");
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

	afterEach(removeConfig);

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
	});
});
