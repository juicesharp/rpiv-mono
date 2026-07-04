import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	configPath,
	loadJsonConfig,
	loadJsonConfigWithLegacyFallback,
	modelKey,
	parseModelKey,
	readEnvVar,
	saveJsonConfig,
	validateConfig,
	validateGuidanceFields,
} from "./config.js";

// ---------------------------------------------------------------------------
// Temporary config directory — isolated per test
// ---------------------------------------------------------------------------

const TMP_BASE = join(process.env.HOME!, ".config");

function tmpConfigPath(name: string): string {
	return join(TMP_BASE, name, "config.json");
}

function writeTmpConfig(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

afterEach(() => {
	// Clean up test-specific config dirs — not the whole .config
	const dirs = ["rpiv-test-load", "rpiv-test-save"];
	for (const d of dirs) {
		rmSync(join(TMP_BASE, d), { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// configPath
// ---------------------------------------------------------------------------

describe("configPath", () => {
	it("resolves to ~/.config/<name>/config.json by default", () => {
		const result = configPath("rpiv-todo");
		expect(result).toMatch(/\.config[/\\]rpiv-todo[/\\]config\.json$/);
	});

	it("supports custom filename", () => {
		const result = configPath("rpiv-advisor", "advisor.json");
		expect(result).toMatch(/\.config[/\\]rpiv-advisor[/\\]advisor\.json$/);
	});

	it("supports voice.json", () => {
		const result = configPath("rpiv-voice", "voice.json");
		expect(result).toMatch(/\.config[/\\]rpiv-voice[/\\]voice\.json$/);
	});
});

// ---------------------------------------------------------------------------
// configPath — XDG_CONFIG_HOME resolution
// ---------------------------------------------------------------------------

describe("configPath — XDG_CONFIG_HOME", () => {
	const ORIG = process.env.XDG_CONFIG_HOME;

	afterEach(() => {
		if (ORIG === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = ORIG;
	});

	it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
		delete process.env.XDG_CONFIG_HOME;
		expect(configPath("rpiv-todo")).toBe(join(homedir(), ".config", "rpiv-todo", "config.json"));
	});

	it("honors an absolute XDG_CONFIG_HOME", () => {
		const xdg = join(tmpdir(), "rpiv-xdg-abs");
		process.env.XDG_CONFIG_HOME = xdg;
		expect(configPath("rpiv-todo")).toBe(join(xdg, "rpiv-todo", "config.json"));
	});

	it('expands a "~/"-prefixed XDG_CONFIG_HOME', () => {
		process.env.XDG_CONFIG_HOME = "~/xdg";
		expect(configPath("rpiv-todo")).toBe(join(homedir(), "xdg", "rpiv-todo", "config.json"));
	});

	it('resolves a bare "~" XDG_CONFIG_HOME to homedir()', () => {
		process.env.XDG_CONFIG_HOME = "~";
		expect(configPath("rpiv-todo")).toBe(join(homedir(), "rpiv-todo", "config.json"));
	});

	it('falls back to ~/.config when XDG_CONFIG_HOME is ""', () => {
		process.env.XDG_CONFIG_HOME = "";
		expect(configPath("rpiv-todo")).toBe(join(homedir(), ".config", "rpiv-todo", "config.json"));
	});

	it("falls back to ~/.config when XDG_CONFIG_HOME is whitespace-only", () => {
		process.env.XDG_CONFIG_HOME = "   ";
		expect(configPath("rpiv-todo")).toBe(join(homedir(), ".config", "rpiv-todo", "config.json"));
	});

	it("falls back to ~/.config when XDG_CONFIG_HOME is relative", () => {
		process.env.XDG_CONFIG_HOME = "relative";
		expect(configPath("rpiv-todo")).toBe(join(homedir(), ".config", "rpiv-todo", "config.json"));
	});

	it('falls back to ~/.config for a "~user" XDG_CONFIG_HOME (only "~" and "~/" expand)', () => {
		process.env.XDG_CONFIG_HOME = "~user/xdg";
		expect(configPath("rpiv-todo")).toBe(join(homedir(), ".config", "rpiv-todo", "config.json"));
	});

	it("honors a custom filename under a set XDG_CONFIG_HOME", () => {
		const xdg = join(tmpdir(), "rpiv-xdg-custom");
		process.env.XDG_CONFIG_HOME = xdg;
		expect(configPath("rpiv-advisor", "advisor.json")).toBe(join(xdg, "rpiv-advisor", "advisor.json"));
	});
});

// ---------------------------------------------------------------------------
// loadJsonConfig
// ---------------------------------------------------------------------------

describe("loadJsonConfig", () => {
	it("returns {} for missing file", () => {
		const result = loadJsonConfig(tmpConfigPath("rpiv-test-load"));
		expect(result).toEqual({});
	});

	it("parses valid JSON object", () => {
		const path = tmpConfigPath("rpiv-test-load");
		writeTmpConfig(path, { hello: "world", count: 42 });
		const result = loadJsonConfig<Record<string, unknown>>(path);
		expect(result).toEqual({ hello: "world", count: 42 });
	});

	it("returns {} for malformed JSON", () => {
		const path = tmpConfigPath("rpiv-test-load");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "not json", "utf-8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = loadJsonConfig(path);
		expect(result).toEqual({});
		warn.mockRestore();
	});

	it("warns on malformed JSON (diagnostic for silent-revert scenarios)", () => {
		const path = tmpConfigPath("rpiv-test-load");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "not json", "utf-8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		loadJsonConfig(path);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]?.[0]).toMatch(/invalid JSON at .*using default/);
		warn.mockRestore();
	});

	it("returns {} for null content", () => {
		const path = tmpConfigPath("rpiv-test-load");
		writeTmpConfig(path, null);
		const result = loadJsonConfig(path);
		expect(result).toEqual({});
	});

	it("returns {} for string content", () => {
		const path = tmpConfigPath("rpiv-test-load");
		writeTmpConfig(path, "hello");
		const result = loadJsonConfig(path);
		expect(result).toEqual({});
	});

	it("returns {} for number content", () => {
		const path = tmpConfigPath("rpiv-test-load");
		writeTmpConfig(path, 42);
		const result = loadJsonConfig(path);
		expect(result).toEqual({});
	});

	it("returns {} for boolean content", () => {
		const path = tmpConfigPath("rpiv-test-load");
		writeTmpConfig(path, true);
		const result = loadJsonConfig(path);
		expect(result).toEqual({});
	});

	it("returns {} for array content", () => {
		const path = tmpConfigPath("rpiv-test-load");
		writeTmpConfig(path, [1, 2, 3]);
		const result = loadJsonConfig(path);
		expect(result).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// loadJsonConfigWithLegacyFallback
// ---------------------------------------------------------------------------

describe("loadJsonConfigWithLegacyFallback", () => {
	const ORIG = process.env.XDG_CONFIG_HOME;
	const xdgRoot = join(tmpdir(), "rpiv-xdg-fallback");
	const legacyRoot = join(homedir(), ".config");
	const NAME = "rpiv-test-fb";

	function xdgConfigPath(file = "config.json"): string {
		return join(xdgRoot, NAME, file);
	}
	function legacyConfigPath(file = "config.json"): string {
		return join(legacyRoot, NAME, file);
	}

	beforeEach(() => {
		process.env.XDG_CONFIG_HOME = xdgRoot;
		rmSync(xdgRoot, { recursive: true, force: true });
		rmSync(join(legacyRoot, NAME), { recursive: true, force: true });
	});

	afterEach(() => {
		rmSync(xdgRoot, { recursive: true, force: true });
		rmSync(join(legacyRoot, NAME), { recursive: true, force: true });
		if (ORIG === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = ORIG;
	});

	it("reads the XDG file when present", () => {
		const p = xdgConfigPath();
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify({ from: "xdg" }), "utf-8");
		expect(loadJsonConfigWithLegacyFallback<Record<string, unknown>>(NAME)).toEqual({ from: "xdg" });
	});

	it("reads the legacy ~/.config file when the XDG path is missing", () => {
		// XDG root has no file for NAME → falls back to legacy.
		const legacy = legacyConfigPath();
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, JSON.stringify({ from: "legacy" }), "utf-8");
		expect(loadJsonConfigWithLegacyFallback<Record<string, unknown>>(NAME)).toEqual({ from: "legacy" });
	});

	it("returns {} when both XDG and legacy paths are missing", () => {
		expect(loadJsonConfigWithLegacyFallback<Record<string, unknown>>(NAME)).toEqual({});
	});

	it("warns + returns {} for a malformed XDG file and does NOT fall back to legacy", () => {
		const xdg = xdgConfigPath();
		mkdirSync(dirname(xdg), { recursive: true });
		writeFileSync(xdg, "not json", "utf-8");
		// Legacy file is also present — it must NOT be read.
		const legacy = legacyConfigPath();
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, JSON.stringify({ from: "legacy" }), "utf-8");

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = loadJsonConfigWithLegacyFallback<Record<string, unknown>>(NAME);
		expect(result).toEqual({});
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]?.[0]).toMatch(/invalid JSON at .*using default/);
		warn.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// saveJsonConfig
// ---------------------------------------------------------------------------

describe("saveJsonConfig", () => {
	it("returns true on success and writes formatted JSON with trailing newline", () => {
		const path = tmpConfigPath("rpiv-test-save");
		const ok = saveJsonConfig(path, { key: "value" });
		expect(ok).toBe(true);
		expect(readFileSync(path, "utf-8")).toBe('{\n  "key": "value"\n}\n');
	});

	it("creates parent directories recursively", () => {
		const path = join(TMP_BASE, "rpiv-test-save", "nested", "config.json");
		const ok = saveJsonConfig(path, { nested: true });
		expect(ok).toBe(true);
		expect(existsSync(path)).toBe(true);
		rmSync(dirname(path), { recursive: true, force: true });
	});

	it("returns false when mkdir/write fails (unwritable path)", () => {
		// /dev/null is a character device, not a directory — mkdir under it fails
		// with ENOTDIR on every POSIX platform. Windows skips this case.
		if (process.platform === "win32") return;
		const ok = saveJsonConfig("/dev/null/cannot-create/config.json", { x: 1 });
		expect(ok).toBe(false);
	});

	it("does not throw on write failure (callers may ignore the boolean)", () => {
		expect(() => saveJsonConfig("/dev/null/cannot-create/config.json", {})).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// validateGuidanceFields
// ---------------------------------------------------------------------------

describe("validateGuidanceFields", () => {
	it("returns {} for undefined input", () => {
		expect(validateGuidanceFields(undefined)).toEqual({});
	});

	it("returns {} for null input", () => {
		expect(validateGuidanceFields(null)).toEqual({});
	});

	it("returns {} for non-object input", () => {
		expect(validateGuidanceFields("string")).toEqual({});
	});

	it("extracts valid promptSnippet", () => {
		expect(validateGuidanceFields({ promptSnippet: "hello" })).toEqual({ promptSnippet: "hello" });
	});

	it("ignores empty promptSnippet", () => {
		expect(validateGuidanceFields({ promptSnippet: "" })).toEqual({});
	});

	it("ignores non-string promptSnippet", () => {
		expect(validateGuidanceFields({ promptSnippet: 42 })).toEqual({});
	});

	it("extracts valid promptGuidelines", () => {
		expect(validateGuidanceFields({ promptGuidelines: ["a", "b"] })).toEqual({ promptGuidelines: ["a", "b"] });
	});

	it("ignores empty promptGuidelines array", () => {
		expect(validateGuidanceFields({ promptGuidelines: [] })).toEqual({});
	});

	it("ignores promptGuidelines with empty strings", () => {
		expect(validateGuidanceFields({ promptGuidelines: ["", "a"] })).toEqual({});
	});

	it("extracts both fields when valid", () => {
		const result = validateGuidanceFields({
			promptSnippet: "snippet",
			promptGuidelines: ["guide"],
		});
		expect(result).toEqual({ promptSnippet: "snippet", promptGuidelines: ["guide"] });
	});
});

// ---------------------------------------------------------------------------
// readEnvVar
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// parseModelKey
// ---------------------------------------------------------------------------

describe("parseModelKey", () => {
	it("parses canonical provider/modelId (slash form)", () => {
		expect(parseModelKey("anthropic/claude-sonnet-4-20250514")).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4-20250514",
		});
	});

	it("parses legacy provider:modelId (colon form, back-compat)", () => {
		expect(parseModelKey("anthropic:claude-sonnet-4-20250514")).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4-20250514",
		});
	});

	it("prefers slash when both separators present (slash is canonical)", () => {
		// "provider:foo/bar" → splits on first '/' → provider="provider:foo"
		expect(parseModelKey("provider:foo/bar")).toEqual({
			provider: "provider:foo",
			modelId: "bar",
		});
	});

	it("returns undefined when neither separator is present", () => {
		expect(parseModelKey("just-a-string")).toBeUndefined();
	});

	it("returns undefined for leading slash", () => {
		expect(parseModelKey("/model-id")).toBeUndefined();
	});

	it("returns undefined for leading colon (legacy form)", () => {
		expect(parseModelKey(":model-id")).toBeUndefined();
	});

	it("handles provider with hyphens (slash form)", () => {
		expect(parseModelKey("google-gemini/gemini-2.5-pro")).toEqual({
			provider: "google-gemini",
			modelId: "gemini-2.5-pro",
		});
	});

	it("handles provider with hyphens (legacy colon form)", () => {
		expect(parseModelKey("google-gemini:gemini-2.5-pro")).toEqual({
			provider: "google-gemini",
			modelId: "gemini-2.5-pro",
		});
	});
});

// ---------------------------------------------------------------------------
// modelKey
// ---------------------------------------------------------------------------

describe("modelKey", () => {
	it("emits canonical provider/modelId (slash form)", () => {
		expect(modelKey({ provider: "anthropic", id: "claude-sonnet-4-20250514" })).toBe(
			"anthropic/claude-sonnet-4-20250514",
		);
	});

	it("round-trips with parseModelKey (slash form)", () => {
		const key = "openai/o3-pro";
		const parsed = parseModelKey(key);
		expect(parsed).toBeDefined();
		expect(modelKey({ provider: parsed!.provider, id: parsed!.modelId })).toBe(key);
	});

	it("auto-migrates legacy colon-form input to slash-form output", () => {
		// Migration story: an advisor config persisted as "anthropic:opus" parses
		// cleanly; the next save re-serialises via modelKey and writes "anthropic/opus".
		const legacy = "anthropic:opus";
		const parsed = parseModelKey(legacy);
		expect(parsed).toBeDefined();
		const rewritten = modelKey({ provider: parsed!.provider, id: parsed!.modelId });
		expect(rewritten).toBe("anthropic/opus");
		expect(rewritten).not.toBe(legacy);
	});
});

// ---------------------------------------------------------------------------
// readEnvVar
// ---------------------------------------------------------------------------

describe("readEnvVar", () => {
	it("returns env value when set", () => {
		process.env.RPIV_TEST_VAR = "hello";
		expect(readEnvVar("RPIV_TEST_VAR")).toBe("hello");
		delete process.env.RPIV_TEST_VAR;
	});

	it("trims whitespace from env value", () => {
		process.env.RPIV_TEST_VAR = "  hello  ";
		expect(readEnvVar("RPIV_TEST_VAR")).toBe("hello");
		delete process.env.RPIV_TEST_VAR;
	});

	it("returns fallback when env var is unset", () => {
		delete process.env.RPIV_TEST_VAR;
		expect(readEnvVar("RPIV_TEST_VAR", "fallback")).toBe("fallback");
	});

	it("returns undefined when env var is unset and no fallback", () => {
		delete process.env.RPIV_TEST_VAR;
		expect(readEnvVar("RPIV_TEST_VAR")).toBeUndefined();
	});

	it("returns fallback when env var is empty after trim", () => {
		process.env.RPIV_TEST_VAR = "   ";
		expect(readEnvVar("RPIV_TEST_VAR", "fallback")).toBe("fallback");
		delete process.env.RPIV_TEST_VAR;
	});
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe("validateConfig", () => {
	const Schema = Type.Object({
		name: Type.String({ default: "unnamed" }),
		count: Type.Number({ default: 0 }),
	});

	it("applies defaults for missing fields", () => {
		const result = validateConfig(Schema, {});
		expect(result).toEqual({ name: "unnamed", count: 0 });
	});

	it("preserves provided values", () => {
		const result = validateConfig(Schema, { name: "test", count: 5 });
		expect(result).toEqual({ name: "test", count: 5 });
	});

	it("strips unknown keys via Value.Clean", () => {
		const result = validateConfig(Schema, { name: "test", extra: "removed" });
		expect(result).toEqual({ name: "test", count: 0 });
	});

	it("returns {} for non-object input (fail-soft)", () => {
		expect(validateConfig(Schema, "not an object")).toEqual({});
	});

	it("returns {} for null input (fail-soft)", () => {
		expect(validateConfig(Schema, null)).toEqual({});
	});

	it("returns {} for array input (fail-soft)", () => {
		expect(validateConfig(Schema, [1, 2, 3])).toEqual({});
	});
});
