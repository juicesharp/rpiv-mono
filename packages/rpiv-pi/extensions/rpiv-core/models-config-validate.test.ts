import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./models-config-sources.js", () => ({
	bundledAgentNames: vi.fn(() => ["codebase-analyzer"]),
	skillCommandNames: vi.fn(() => ["commit"]),
	loadWorkflowMap: vi.fn(async () => ({ build: ["research", "plan"] })),
}));

import { loadWorkflowMap } from "./models-config-sources.js";
import { registerModelsConfigValidation } from "./models-config-validate.js";

function writeModels(config: unknown) {
	const dir = join(process.env.HOME!, ".config", "rpiv-pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "models.json"), JSON.stringify(config), "utf-8");
}

function makePi() {
	let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
	const pi = {
		on: vi.fn((event: string, h: (...args: unknown[]) => unknown) => {
			if (event === "session_start") handler = h;
		}),
	} as unknown as ExtensionAPI;
	return { pi, fire: (ctx: unknown = { cwd: "/tmp" }) => handler?.({}, ctx) };
}

afterEach(() => {
	vi.mocked(loadWorkflowMap).mockReset();
	vi.mocked(loadWorkflowMap).mockResolvedValue({ build: ["research", "plan"] });
});

describe("models-config-validate — session_start warn-on-miss", () => {
	it("warns once for each typo'd key across all axes", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeModels({
			agents: { "codebase-analzyer": "a/b" },
			stages: { reserch: "a/b" },
			skills: { committ: "a/b" },
			presets: { build: { stages: { plann: "a/b" } } },
		});
		const { pi, fire } = makePi();
		registerModelsConfigValidation(pi);
		await fire();

		const warned = warn.mock.calls.map((c) => String(c[0]));
		expect(warned.some((w) => w.includes("agents.codebase-analzyer"))).toBe(true);
		expect(warned.some((w) => w.includes("stages.reserch"))).toBe(true);
		expect(warned.some((w) => w.includes("skills.committ"))).toBe(true);
		expect(warned.some((w) => w.includes("presets.build.stages.plann"))).toBe(true);
		warn.mockRestore();
	});

	it("stays silent when every key is valid", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeModels({
			agents: { "codebase-analyzer": "a/b" },
			skills: { commit: "a/b" },
			presets: { build: { stages: { plan: "a/b" } } },
		});
		const { pi, fire } = makePi();
		registerModelsConfigValidation(pi);
		await fire();
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("warns only once per process even across repeated session_start", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeModels({ skills: { committ: "a/b" } });
		const { pi, fire } = makePi();
		registerModelsConfigValidation(pi);
		await fire();
		const afterFirst = warn.mock.calls.length;
		await fire();
		expect(warn.mock.calls.length).toBe(afterFirst);
		warn.mockRestore();
	});

	it("does not load workflows when only agents/skills axes are configured", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeModels({ skills: { committ: "a/b" } });
		const { pi, fire } = makePi();
		registerModelsConfigValidation(pi);
		await fire();
		expect(loadWorkflowMap).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("skills.committ"));
		warn.mockRestore();
	});

	it("does nothing when no record axes are configured", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeModels({ defaults: "a/b" });
		const { pi, fire } = makePi();
		registerModelsConfigValidation(pi);
		await fire();
		expect(loadWorkflowMap).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("skips stages/presets (no crash, no false warn) when the workflow load fails", async () => {
		vi.mocked(loadWorkflowMap).mockRejectedValueOnce(new Error("boom: workflow load failed"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// `reserch` is unknown, but with the workflow universe unavailable the
		// stages axis must be skipped rather than false-warned — and must not throw.
		writeModels({ stages: { reserch: "a/b" } });
		const { pi, fire } = makePi();
		registerModelsConfigValidation(pi);
		await expect(fire()).resolves.toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("skips a configured axis whose known-list is empty without throwing", async () => {
		// Defensive: empty agent registry should not crash; unknown agent key is
		// reported (empty known-list still validates — every key is unknown).
		vi.mocked(loadWorkflowMap).mockResolvedValue({});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeModels({ stages: { research: "a/b" } });
		const { pi, fire } = makePi();
		registerModelsConfigValidation(pi);
		await fire();
		// `research` is not in the empty workflow map → flagged.
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("stages.research"));
		warn.mockRestore();
	});
});
