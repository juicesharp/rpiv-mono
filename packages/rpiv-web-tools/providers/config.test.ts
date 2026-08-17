import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "@juicesharp/rpiv-config";
import { beforeEach, describe, expect, it } from "vitest";
import { getConfigPath, readConfig, WebToolsConfigSchema, writeConfig } from "./config.js";

const CONFIG_PATH = configPath("rpiv-web-tools");

beforeEach(() => {
	rmSync(CONFIG_PATH, { force: true });
});

function writeRaw(contents: string): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, contents, "utf-8");
}

describe("getConfigPath", () => {
	it("returns the canonical ~/.config/rpiv-web-tools/config.json", () => {
		expect(getConfigPath()).toBe(CONFIG_PATH);
	});
});

describe("readConfig — fail-soft posture", () => {
	it("returns {} when the file does not exist", () => {
		expect(readConfig()).toEqual({});
	});

	it("returns {} on malformed JSON (matches loadJsonConfig tolerance)", () => {
		writeRaw("{ not valid json");
		expect(readConfig()).toEqual({});
	});

	it("returns {} when the file is a directory (EISDIR)", () => {
		mkdirSync(CONFIG_PATH, { recursive: true });
		try {
			expect(readConfig()).toEqual({});
		} finally {
			rmSync(CONFIG_PATH, { recursive: true, force: true });
		}
	});

	it("drops a wrong-typed field and returns {} when nothing else is present", () => {
		writeRaw(JSON.stringify({ provider: 123 }));
		expect(readConfig()).toEqual({});
	});
});

describe("readConfig — per-field schema salvage", () => {
	it("keeps the rest of the config when one top-level field is wrong-typed", () => {
		writeRaw(JSON.stringify({ provider: 123, apiKeys: { brave: "k" }, otherField: "keep" }));
		expect(readConfig()).toEqual({ apiKeys: { brave: "k" }, otherField: "keep" });
	});

	it("drops only the offending guidance leaf (wrong-typed description), keeping its siblings", () => {
		// The GuidanceFields.description enrollment regression: a wrong-typed
		// nested leaf must cost that field alone, never the whole config.
		writeRaw(
			JSON.stringify({
				provider: "brave",
				apiKeys: { brave: "k" },
				guidance: {
					web_search: { promptSnippet: "snip", description: 123 },
					web_fetch: { promptSnippet: "snip2" },
				},
			}),
		);
		expect(readConfig()).toEqual({
			provider: "brave",
			apiKeys: { brave: "k" },
			guidance: {
				web_search: { promptSnippet: "snip" },
				web_fetch: { promptSnippet: "snip2" },
			},
		});
	});

	it("drops a whole array field on one bad element rather than leaving a sparse hole", () => {
		writeRaw(
			JSON.stringify({
				provider: "brave",
				guidance: { web_search: { promptSnippet: "snip", promptGuidelines: ["a", 5] } },
			}),
		);
		expect(readConfig()).toEqual({
			provider: "brave",
			guidance: { web_search: { promptSnippet: "snip" } },
		});
	});

	it("drops a wrong-typed interceptors union field, keeping the rest", () => {
		writeRaw(JSON.stringify({ provider: "brave", interceptors: "nope" }));
		expect(readConfig()).toEqual({ provider: "brave" });
	});

	it("drops a single wrong-typed apiKeys record entry, keeping the valid keys", () => {
		writeRaw(JSON.stringify({ provider: "brave", apiKeys: { brave: "k", broken: 7 } }));
		expect(readConfig()).toEqual({ provider: "brave", apiKeys: { brave: "k" } });
	});
});

describe("readConfig — released-shape compatibility", () => {
	it("loads a minimal { provider, apiKeys } config unchanged", () => {
		writeRaw(JSON.stringify({ provider: "brave", apiKeys: { brave: "k" } }));
		expect(readConfig()).toEqual({ provider: "brave", apiKeys: { brave: "k" } });
	});

	it("loads the legacy top-level apiKey field", () => {
		writeRaw(JSON.stringify({ apiKey: "legacy" }));
		expect(readConfig()).toMatchObject({ apiKey: "legacy" });
	});

	it("preserves unknown top-level keys (otherField round-trip contract)", () => {
		// The released /web-tools migrate-legacy-apiKey test relies on this:
		// unknown keys MUST NOT be stripped by the schema reader.
		writeRaw(JSON.stringify({ apiKey: "k", otherField: "keep" }));
		const cfg = readConfig() as { otherField?: string };
		expect(cfg.otherField).toBe("keep");
	});

	it("loads the guidance subtree with web_search + web_fetch", () => {
		writeRaw(
			JSON.stringify({
				guidance: {
					web_search: { promptSnippet: "snip", promptGuidelines: ["a", "b"] },
					web_fetch: { promptSnippet: "snip2" },
				},
			}),
		);
		const cfg = readConfig();
		expect(cfg.guidance?.web_search?.promptSnippet).toBe("snip");
		expect(cfg.guidance?.web_fetch?.promptSnippet).toBe("snip2");
	});
});

describe("readConfig — interceptors.github union", () => {
	it("accepts the boolean true shorthand", () => {
		writeRaw(JSON.stringify({ interceptors: { github: true } }));
		expect(readConfig().interceptors?.github).toBe(true);
	});

	it("accepts the boolean false shorthand", () => {
		writeRaw(JSON.stringify({ interceptors: { github: false } }));
		expect(readConfig().interceptors?.github).toBe(false);
	});

	it("accepts the object override form", () => {
		writeRaw(
			JSON.stringify({
				interceptors: { github: { maxRepoSizeMB: 1000, clonePath: "/x" } },
			}),
		);
		const gh = readConfig().interceptors?.github;
		expect(gh).toEqual({ maxRepoSizeMB: 1000, clonePath: "/x" });
	});

	it("drops only the type-incompatible github entry (per-field salvage)", () => {
		// A number is neither boolean nor a GitHubInterceptorOptions object —
		// the offending field alone falls back, not the whole config.
		writeRaw(JSON.stringify({ provider: "brave", interceptors: { github: 42 } }));
		expect(readConfig()).toEqual({ provider: "brave", interceptors: {} });
	});
});

describe("writeConfig", () => {
	it("round-trips a config through readConfig", () => {
		expect(writeConfig({ provider: "brave", apiKeys: { brave: "k" } })).toBe(true);
		expect(readConfig()).toEqual({ provider: "brave", apiKeys: { brave: "k" } });
	});

	it("preserves the interceptors.github stanza across save+load", () => {
		expect(writeConfig({ interceptors: { github: { maxRepoSizeMB: 500 } } })).toBe(true);
		expect(readConfig().interceptors?.github).toEqual({ maxRepoSizeMB: 500 });
	});
});

describe("WebToolsConfigSchema — schema-only sanity", () => {
	it("exists and is a TypeBox object", () => {
		expect(WebToolsConfigSchema).toBeDefined();
		expect(WebToolsConfigSchema.type).toBe("object");
	});
});
