import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type AgentInjectionContext, injectModelFrontmatter } from "./agents-inject.js";
import type { ModelsConfig } from "./models-config.js";
import { BUNDLED_AGENTS_DIR } from "./paths.js";

// Pure-transform coverage for injectModelFrontmatter (string-in/string-out —
// no filesystem writes; the only fs touch is reading bundled agent sources).
// The disk/e2e injection its live in agents-sync.test.ts (they exercise the
// sync engine, not the transform alone).

const bundledNames = () => readdirSync(BUNDLED_AGENTS_DIR).filter((f) => f.endsWith(".md"));
const bundledContent = (name: string) => readFileSync(join(BUNDLED_AGENTS_DIR, name), "utf-8");

describe("agent frontmatter injection", () => {
	const agentContent = [
		"---",
		"name: test-agent",
		"description: Test agent",
		"tools: grep, find",
		"isolated: true",
		"---",
		"",
		"You are a test agent.",
	].join("\n");

	// --- Direct unit tests on the pure transform (the load-bearing invariants) ---

	const cfg: ModelsConfig = {
		agents: { "test-agent": { model: "anthropic/claude-sonnet-4-20250514", thinking: "high" } },
	};

	it("injects model and thinking before the closing ---", () => {
		const out = injectModelFrontmatter(agentContent, "test-agent.md", cfg);
		// Post-slash-canonical migration: models.json value passes through to
		// frontmatter byte-for-byte. No translation step.
		expect(out).toContain("model: anthropic/claude-sonnet-4-20250514");
		expect(out).toContain("thinking: high");
		// Injected keys land inside the frontmatter block, before the body.
		const fmEnd = out.indexOf("\n---", 3);
		expect(out.indexOf("model:")).toBeLessThan(fmEnd);
		expect(out.indexOf("You are a test agent.")).toBeGreaterThan(fmEnd);
	});

	it("is idempotent — inject(inject(x)) === inject(x) (drift prevention)", () => {
		const once = injectModelFrontmatter(agentContent, "test-agent.md", cfg);
		const twice = injectModelFrontmatter(once, "test-agent.md", cfg);
		expect(twice).toBe(once);
	});

	it("emits the models.json model value byte-for-byte (strengthened idempotency)", () => {
		const out = injectModelFrontmatter(agentContent, "test-agent.md", cfg);
		const fmModelLine = out.split("\n").find((l) => l.startsWith("model: "));
		// Post-slash-canonical: the frontmatter `model:` value equals the
		// models.json `model` field char-for-char — no translation layer.
		expect(fmModelLine).toBe(`model: ${cfg.agents!["test-agent"].model}`);
	});

	it("returns content unchanged when no override is configured", () => {
		expect(injectModelFrontmatter(agentContent, "other-agent.md", cfg)).toBe(agentContent);
		expect(injectModelFrontmatter(agentContent, "test-agent.md", {})).toBe(agentContent);
	});

	it("replaces an existing model key in place rather than duplicating it", () => {
		const withModel = agentContent.replace("name: test-agent", "name: test-agent\nmodel: openai/gpt-5.5");
		const out = injectModelFrontmatter(withModel, "test-agent.md", cfg);
		expect(out.match(/^model:/gm)?.length).toBe(1);
		expect(out).toContain("model: anthropic/claude-sonnet-4-20250514");
	});

	it("injects an explicit thinking: off (disable reasoning) and stays idempotent", () => {
		const offCfg: ModelsConfig = { agents: { "test-agent": { model: "anthropic/opus", thinking: "off" } } };
		const out = injectModelFrontmatter(agentContent, "test-agent.md", offCfg);
		expect(out).toContain("thinking: off");
		expect(injectModelFrontmatter(out, "test-agent.md", offCfg)).toBe(out);
	});

	it("cascades a defaults model into an otherwise-unconfigured agent", () => {
		const defaultsCfg: ModelsConfig = {
			defaults: { model: "openai/o3-pro" },
			agents: { "other-agent": { model: "openai/o3-pro" } },
		};
		const out = injectModelFrontmatter(agentContent, "test-agent.md", defaultsCfg);
		expect(out).toContain("model: openai/o3-pro");
	});
});

describe("agent enablement injection (install-gated, config-driven)", () => {
	// The shipped AGENT_ENABLEMENT_GRANTS map is empty (the rpiv-lsp experiment
	// that populated it lives on backup/lsp-experiment); enablement now flows
	// through models.json agent entries. These tests exercise the SAME
	// injection machinery — merge forms, idempotency, the install gate, the
	// e2e sync + cleanup paths — with config-sourced grants against the
	// rpiv-web-tools sibling (a real registry entry, so the settings-driven
	// gate opens for it).
	const GATE_ON: AgentInjectionContext = { installedExtensions: new Set(["rpiv-web-tools"]) };
	const GATE_OFF: AgentInjectionContext = { installedExtensions: new Set<string>() };
	const SCANNER = "integration-scanner.md";
	const ANALYZER = "codebase-analyzer.md";
	const ENABLE_CFG: ModelsConfig = {
		agents: {
			"integration-scanner": { tools: ["ext:rpiv-web-tools/tool_a"], extensions: ["rpiv-web-tools"] },
			"codebase-analyzer": {
				tools: ["ext:rpiv-web-tools/tool_b", "ext:rpiv-web-tools/tool_c"],
				extensions: ["rpiv-web-tools"],
			},
		},
	};

	// --- Pure transform: gate off ---

	it("gate off (no injection arg): every bundled agent byte-identical", () => {
		for (const name of bundledNames()) {
			expect(injectModelFrontmatter(bundledContent(name), name, {})).toBe(bundledContent(name));
		}
	});

	it("gate off (empty installed set): config-sourced enablement stays inactive, bytes identical", () => {
		for (const name of bundledNames()) {
			expect(injectModelFrontmatter(bundledContent(name), name, ENABLE_CFG, GATE_OFF)).toBe(bundledContent(name));
		}
	});

	// --- Pure transform: gate on, injected forms ---

	it("gate on: integration-scanner gains the four-key enablement set from config", () => {
		const out = injectModelFrontmatter(bundledContent(SCANNER), SCANNER, ENABLE_CFG, GATE_ON);
		const lines = out.split("\n");
		expect(lines).toContain("tools: grep, find, ls, ext:rpiv-web-tools/tool_a");
		expect(lines).toContain("extensions: [rpiv-web-tools]");
		expect(lines).toContain("isolated: false");
		expect(lines).toContain("skills: false");
		// Single declarations only — replaced in place, never duplicated.
		expect(out.match(/^tools:/gm)?.length).toBe(1);
		expect(out.match(/^isolated:/gm)?.length).toBe(1);
		expect(out.match(/^skills:/gm)?.length).toBe(1);
	});

	it("gate on: codebase-analyzer preserves base-tool order and appends additions", () => {
		const out = injectModelFrontmatter(bundledContent(ANALYZER), ANALYZER, ENABLE_CFG, GATE_ON);
		const lines = out.split("\n");
		expect(lines).toContain("tools: read, grep, find, ls, ext:rpiv-web-tools/tool_b, ext:rpiv-web-tools/tool_c");
		expect(lines).toContain("extensions: [rpiv-web-tools]");
		expect(lines).toContain("isolated: false");
		expect(lines).toContain("skills: false");
	});

	it("gate on: agents without a config grant are untouched", () => {
		for (const name of bundledNames()) {
			if (name === SCANNER || name === ANALYZER) continue;
			expect(injectModelFrontmatter(bundledContent(name), name, ENABLE_CFG, GATE_ON)).toBe(bundledContent(name));
		}
	});

	it("atomic enablement: an unmergeable tools form skips the WHOLE grant — no isolation flip, one loud warn (I2)", () => {
		// Block-sequence tools cannot receive the CSV merge; the old transform
		// still flipped isolated/skills off — un-scoping the agent while granting
		// nothing, re-materialized silently every sync. The transform is atomic
		// now: unmergeable form ⇒ byte-identical output + console.warn.
		const blockSrc = [
			"---",
			"name: block-agent",
			"tools:",
			"  - grep",
			"  - find",
			"isolated: true",
			"---",
			"",
			"Body.",
			"",
		].join("\n");
		const cfg: ModelsConfig = {
			agents: { "block-agent": { tools: ["ext:rpiv-web-tools/tool_a"], extensions: ["rpiv-web-tools"] } },
		};
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const out = injectModelFrontmatter(blockSrc, "block-agent.md", cfg, GATE_ON);
		expect(out).toBe(blockSrc);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not mergeable"));
		warnSpy.mockRestore();
	});

	it("double-inject fixed point with gate on", () => {
		for (const name of [SCANNER, ANALYZER]) {
			const once = injectModelFrontmatter(bundledContent(name), name, ENABLE_CFG, GATE_ON);
			expect(injectModelFrontmatter(once, name, ENABLE_CFG, GATE_ON)).toBe(once);
		}
	});

	it("model + enablement coexist: appended keys land in fixed order and re-inject is a fixed point", () => {
		const cfg: ModelsConfig = {
			agents: {
				"integration-scanner": {
					model: "openai/o3-pro",
					thinking: "high",
					tools: ["ext:rpiv-web-tools/tool_a"],
					extensions: ["rpiv-web-tools"],
				},
			},
		};
		const once = injectModelFrontmatter(bundledContent(SCANNER), SCANNER, cfg, GATE_ON);
		const idx = (key: string) => once.split("\n").findIndex((l) => l.startsWith(`${key}: `));
		expect(idx("model")).toBeLessThan(idx("thinking"));
		expect(idx("thinking")).toBeLessThan(idx("extensions"));
		expect(idx("extensions")).toBeLessThan(idx("skills"));
		expect(injectModelFrontmatter(once, SCANNER, cfg, GATE_ON)).toBe(once);
	});

	it("tools-only config entry injects without model/thinking keys", () => {
		const cfg: ModelsConfig = { agents: { "integration-scanner": { tools: ["ext:rpiv-web-tools/tool_a"] } } };
		const out = injectModelFrontmatter(bundledContent(SCANNER), SCANNER, cfg, GATE_ON);
		expect(out.split("\n")).toContain("tools: grep, find, ls, ext:rpiv-web-tools/tool_a");
		expect(out.split("\n").find((l) => l.startsWith("model:"))).toBeUndefined();
	});

	it("an empty tools array with configured extensions injects the remaining keys only", () => {
		const cfg: ModelsConfig = {
			agents: { "integration-scanner": { tools: [], extensions: ["rpiv-web-tools"] } },
		};
		const out = injectModelFrontmatter(bundledContent(SCANNER), SCANNER, cfg, GATE_ON);
		const lines = out.split("\n");
		expect(lines).toContain("tools: grep, find, ls");
		expect(out).not.toContain("ext:rpiv-web-tools/");
		expect(lines).toContain("extensions: [rpiv-web-tools]");
		expect(lines).toContain("isolated: false");
	});
});
