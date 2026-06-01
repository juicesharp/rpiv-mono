import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	configPath,
	loadJsonConfig,
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
	it("parses provider:modelId format", () => {
		expect(parseModelKey("anthropic:claude-sonnet-4-20250514")).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4-20250514",
		});
	});

	it("returns undefined for no colon", () => {
		expect(parseModelKey("just-a-string")).toBeUndefined();
	});

	it("returns undefined for leading colon", () => {
		expect(parseModelKey(":model-id")).toBeUndefined();
	});

	it("handles provider with hyphens", () => {
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
	it("composes provider:id format", () => {
		expect(modelKey({ provider: "anthropic", id: "claude-sonnet-4-20250514" })).toBe(
			"anthropic:claude-sonnet-4-20250514",
		);
	});

	it("round-trips with parseModelKey", () => {
		const key = "openai:o3-pro";
		const parsed = parseModelKey(key);
		expect(parsed).toBeDefined();
		expect(modelKey({ provider: parsed!.provider, id: parsed!.modelId })).toBe(key);
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
