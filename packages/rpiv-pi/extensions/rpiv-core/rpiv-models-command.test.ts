import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadModelsConfig } from "./models-config.js";
import { bundledAgentNames } from "./models-config-sources.js";
import { applyOverride, registerRpivModelsCommand, removeOverride } from "./rpiv-models/index.js";

vi.mock("./models-picker.js", () => ({
	showFilterablePicker: vi.fn(),
}));

const { showFilterablePicker } = await import("./models-picker.js");

function makePi() {
	let cmdHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const registerCommand = vi.fn(
		(name: string, opts: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			if (name === "rpiv-models") cmdHandler = opts.handler;
		},
	);
	// Provide a minimal sourceInfo stub on each mock entry so a future read of
	// `sourceInfo` in skillCommandNames doesn't silently pass tests while
	// failing production.
	const stubSourceInfo = { path: "/stub/SKILL.md", baseDir: "/stub" };
	const getCommands = vi.fn(() => [
		{ name: "skill:commit", description: "Commit changes", source: "skill", sourceInfo: stubSourceInfo },
		{ name: "skill:research", description: "Research a topic", source: "skill", sourceInfo: stubSourceInfo },
		{ name: "rpiv-models", description: "Configure models", source: "extension", sourceInfo: stubSourceInfo },
	]);
	return {
		pi: { registerCommand, getCommands } as unknown as ExtensionAPI,
		handler: () => cmdHandler!,
		getCommands,
	};
}

function makeCtx(hasUI = true) {
	const models = [
		{ name: "GLM-4.7", provider: "zai", id: "glm-4-7", reasoning: false },
		{ name: "GPT-5.5", provider: "openai", id: "gpt-5.5", reasoning: true },
	];
	return {
		hasUI,
		cwd: process.cwd(),
		ui: { notify: vi.fn(), confirm: vi.fn(async () => true) },
		modelRegistry: { getAvailable: () => models },
	} as unknown as ExtensionContext;
}

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-pi", "models.json");

beforeEach(() => {
	vi.restoreAllMocks();
	// restoreAllMocks does not drain a module-mock's mockResolvedValueOnce queue;
	// reset explicitly so a test that returns early can't bleed leftover picker
	// answers into the next test.
	vi.mocked(showFilterablePicker).mockReset();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("/rpiv-models — guards", () => {
	it("errors when ctx.hasUI is false", async () => {
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx(false);
		await handler()("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
	});

	it("cancels gracefully when scope picker returns null", async () => {
		vi.mocked(showFilterablePicker).mockResolvedValueOnce(null);
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(existsSync(CONFIG_PATH)).toBe(false);
	});
});

describe("/rpiv-models — defaults flow", () => {
	it("writes defaults entry via slash-canonical model key", async () => {
		vi.mocked(showFilterablePicker).mockResolvedValueOnce("defaults").mockResolvedValueOnce("zai/glm-4-7");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		expect(existsSync(CONFIG_PATH)).toBe(true);
		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.defaults).toBe("zai/glm-4-7");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Saved defaults"), "info");
	});
});

describe("/rpiv-models — skills flow (live registry)", () => {
	it("pulls skill names from pi.getCommands() filtered by source==='skill'", async () => {
		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("skills")
			.mockResolvedValueOnce("commit")
			.mockResolvedValueOnce("zai/glm-4-7");
		const { pi, handler, getCommands } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		expect(getCommands).toHaveBeenCalled();
		const skillPickerCall = vi.mocked(showFilterablePicker).mock.calls[1];
		expect((skillPickerCall[1] as { items: { value: string }[] }).items.map((i) => i.value)).toEqual([
			"commit",
			"research",
		]);

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.skills.commit).toBe("zai/glm-4-7");
	});
});

describe("/rpiv-models — effort picker for reasoning models", () => {
	it("calls effort picker only when reasoning is true", async () => {
		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("defaults")
			.mockResolvedValueOnce("openai/gpt-5.5")
			.mockResolvedValueOnce("high");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.defaults).toEqual({ model: "openai/gpt-5.5", thinking: "high" });
	});
});

describe("/rpiv-models — first-class off vs inherit", () => {
	it("persists thinking:'off' when the off effort is chosen", async () => {
		rmSync(CONFIG_PATH, { force: true });
		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("defaults")
			.mockResolvedValueOnce("openai/gpt-5.5")
			.mockResolvedValueOnce("off");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.defaults).toEqual({ model: "openai/gpt-5.5", thinking: "off" });
	});

	it("persists a bare model (no thinking ⇒ inherit) when inherit is chosen", async () => {
		rmSync(CONFIG_PATH, { force: true });
		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("defaults")
			.mockResolvedValueOnce("openai/gpt-5.5")
			.mockResolvedValueOnce("__inherit__");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.defaults).toBe("openai/gpt-5.5"); // bare string, no thinking field
	});

	it("offers inherit first, then off, in the effort picker for a reasoning model", async () => {
		rmSync(CONFIG_PATH, { force: true });
		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("defaults")
			.mockResolvedValueOnce("openai/gpt-5.5")
			.mockResolvedValueOnce(null); // cancel at effort
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const effortItems = (vi.mocked(showFilterablePicker).mock.calls[2][1] as { items: SelectItem[] }).items;
		const values = effortItems.map((i) => i.value);
		expect(values[0]).toBe("__inherit__");
		expect(values).toContain("off");
		expect(values).toContain("minimal");
	});
});

describe("/rpiv-models — cache invalidation", () => {
	it("resets cache after successful save (next loadModelsConfig sees new value)", async () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ defaults: "anthropic/old" }), "utf-8");
		const before = loadModelsConfig();
		expect(before.defaults?.model).toBe("anthropic/old");

		vi.mocked(showFilterablePicker).mockResolvedValueOnce("defaults").mockResolvedValueOnce("zai/glm-4-7");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const after = loadModelsConfig();
		expect(after.defaults?.model).toBe("zai/glm-4-7");
	});
});

describe("/rpiv-models — checkmark display", () => {
	it("passes currentKey to buildModelItems when defaults override exists", async () => {
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ defaults: "zai/glm-4-7" }), "utf-8");

		vi.mocked(showFilterablePicker).mockResolvedValueOnce("defaults").mockResolvedValueOnce("zai/glm-4-7");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const modelPickerCall = vi.mocked(showFilterablePicker).mock.calls[1];
		const items = (modelPickerCall[1] as { items: SelectItem[] }).items;
		const glmItem = items.find((i: SelectItem) => i.value === "zai/glm-4-7");
		expect(glmItem?.label).toContain("✓");
	});

	it("does not show checkmark when no override is configured", async () => {
		rmSync(CONFIG_PATH, { force: true });

		vi.mocked(showFilterablePicker).mockResolvedValueOnce("defaults").mockResolvedValueOnce("zai/glm-4-7");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const modelPickerCall = vi.mocked(showFilterablePicker).mock.calls[1];
		const items = (modelPickerCall[1] as { items: SelectItem[] }).items;
		const glmItem = items.find((i: SelectItem) => i.value === "zai/glm-4-7");
		expect(glmItem?.label).not.toContain("✓");
	});
});

describe("/rpiv-models — override checkmarks", () => {
	it("marks scopes that hold overrides on the scope picker (not empty scopes, not reset-all)", async () => {
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ skills: { commit: "zai/glm-4-7" } }), "utf-8");

		vi.mocked(showFilterablePicker).mockResolvedValueOnce(null); // cancel at scope picker
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const scopeListItems = (vi.mocked(showFilterablePicker).mock.calls[0][1] as { items: SelectItem[] }).items;
		const byValue = Object.fromEntries(scopeListItems.map((i) => [i.value, i.label]));
		expect(byValue.skills).toContain("✓");
		expect(byValue.agents).not.toContain("✓");
		expect(byValue.__reset_all__).not.toContain("✓");
	});

	it("marks only the overridden key on a key picker", async () => {
		const agents = bundledAgentNames();
		const target = agents[0]; // a real bundled agent so it appears in the list
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ agents: { [target]: "zai/glm-4-7" } }), "utf-8");

		vi.mocked(showFilterablePicker).mockResolvedValueOnce("agents").mockResolvedValueOnce(null);
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const agentItems = (vi.mocked(showFilterablePicker).mock.calls[1][1] as { items: SelectItem[] }).items;
		expect(agentItems.find((i) => i.value === target)?.label).toContain("✓");
		expect(agentItems.find((i) => i.value !== target)?.label).not.toContain("✓");
	});

	it("floats scopes that hold overrides to the top, keeping reset-all last", async () => {
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ stages: { plan: "zai/glm-4-7" } }), "utf-8");

		vi.mocked(showFilterablePicker).mockResolvedValueOnce(null); // cancel at scope
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const scopeListItems = (vi.mocked(showFilterablePicker).mock.calls[0][1] as { items: SelectItem[] }).items;
		expect(scopeListItems[0].value).toBe("stages"); // overridden scope floated up
		expect(scopeListItems[scopeListItems.length - 1].value).toBe("__reset_all__"); // reset stays last
	});

	it("floats an overridden key to the top of its key picker", async () => {
		const agents = bundledAgentNames();
		const target = agents[agents.length - 1]; // last in natural order
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ agents: { [target]: "zai/glm-4-7" } }), "utf-8");

		vi.mocked(showFilterablePicker).mockResolvedValueOnce("agents").mockResolvedValueOnce(null);
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const agentItems = (vi.mocked(showFilterablePicker).mock.calls[1][1] as { items: SelectItem[] }).items;
		expect(agentItems[0].value).toBe(target); // floated from last to first
	});

	it("floats the current model to the top of the model list and keeps its ✓", async () => {
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		// openai/gpt-5.5 is the SECOND model in the registry; make it the default.
		writeFileSync(CONFIG_PATH, JSON.stringify({ defaults: "openai/gpt-5.5" }), "utf-8");

		vi.mocked(showFilterablePicker).mockResolvedValueOnce("defaults").mockResolvedValueOnce(null);
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const modelItems = (vi.mocked(showFilterablePicker).mock.calls[1][1] as { items: SelectItem[] }).items;
		expect(modelItems[0].value).toBe("openai/gpt-5.5"); // floated to index 0
		expect(modelItems[0].label).toContain("✓");
		// and it was passed as the preferred (preselected) value
		expect((vi.mocked(showFilterablePicker).mock.calls[1][1] as { preferredValue?: string }).preferredValue).toBe(
			"openai/gpt-5.5",
		);
	});
});

describe("/rpiv-models — per-entry reset", () => {
	it("removes agents entry when reset sentinel is chosen", async () => {
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ agents: { "codebase-analyst": "zai/glm-4-7" } }), "utf-8");

		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("agents")
			.mockResolvedValueOnce("codebase-analyst")
			.mockResolvedValueOnce("__reset__");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.agents).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Removed"), "info");
	});

	it("removes a defaults override (no trailing slash in the label)", async () => {
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ defaults: "zai/glm-4-7" }), "utf-8");

		// scope=defaults → model picker → reset.
		vi.mocked(showFilterablePicker).mockResolvedValueOnce("defaults").mockResolvedValueOnce("__reset__");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.defaults).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith("Removed defaults.", "info");
	});

	it("reports honestly (no misleading 'Removed') when the key has no override", async () => {
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		// Config has one agent override; reset a DIFFERENT agent that has none.
		writeFileSync(CONFIG_PATH, JSON.stringify({ agents: { "codebase-locator": "zai/glm-4-7" } }), "utf-8");

		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("agents")
			.mockResolvedValueOnce("codebase-analyst")
			.mockResolvedValueOnce("__reset__");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.agents["codebase-locator"]).toBe("zai/glm-4-7"); // untouched
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No override set"), "info");
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Removed"), "info");
	});
});

describe("removeOverride (cascade cleanup)", () => {
	it("prunes the empty scope map when the last agent entry is removed", () => {
		const { next, removed } = removeOverride({ agents: { commit: "zai/glm-4-7" } }, "agents", ["commit"]);
		expect(removed).toBe(true);
		expect(next.agents).toBeUndefined();
	});

	it("collapses the whole presets tree when the last stage is removed", () => {
		const { next, removed } = removeOverride(
			{ presets: { ship: { stages: { research: "zai/glm-4-7" } } } },
			"presets",
			["ship", "research"],
		);
		expect(removed).toBe(true);
		expect(next.presets).toBeUndefined();
	});

	it("keeps sibling stages/workflows when removing one preset stage", () => {
		const { next, removed } = removeOverride(
			{
				presets: {
					ship: { stages: { research: "zai/glm-4-7", plan: "anthropic/opus" } },
					polish: { stages: { review: "zai/glm-4-7" } },
				},
			},
			"presets",
			["ship", "research"],
		);
		expect(removed).toBe(true);
		expect(next.presets).toEqual({
			ship: { stages: { plan: "anthropic/opus" } },
			polish: { stages: { review: "zai/glm-4-7" } },
		});
	});

	it("removes a defaults override", () => {
		const { next, removed } = removeOverride({ defaults: "zai/glm-4-7" }, "defaults", []);
		expect(removed).toBe(true);
		expect(next.defaults).toBeUndefined();
	});

	it("reports removed=false and leaves config untouched when the key is absent", () => {
		const config = { agents: { commit: "zai/glm-4-7" } };
		const { next, removed } = removeOverride(config, "agents", ["research"]);
		expect(removed).toBe(false);
		expect(next).toEqual(config);
	});

	it("reports removed=false for an absent preset stage", () => {
		const config = { presets: { ship: { stages: { research: "zai/glm-4-7" } } } };
		expect(removeOverride(config, "presets", ["ship", "plan"]).removed).toBe(false);
		expect(removeOverride(config, "presets", ["polish", "review"]).removed).toBe(false);
	});
});

describe("/rpiv-models — global reset", () => {
	it("clears entire config when reset-all scope is chosen and confirmed", async () => {
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(
			CONFIG_PATH,
			JSON.stringify({
				defaults: "zai/glm-4-7",
				agents: { "codebase-analyst": "anthropic/opus" },
				skills: { commit: "zai/glm-4-7" },
			}),
			"utf-8",
		);

		vi.mocked(showFilterablePicker).mockResolvedValueOnce("__reset_all__");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored).toEqual({});
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cleared"), "info");
	});

	it("does NOT wipe config when the confirm dialog is cancelled", async () => {
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		const original = { defaults: "zai/glm-4-7", skills: { commit: "anthropic/opus" } };
		writeFileSync(CONFIG_PATH, JSON.stringify(original), "utf-8");

		vi.mocked(showFilterablePicker).mockResolvedValueOnce("__reset_all__");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		vi.mocked(ctx.ui.confirm).mockResolvedValueOnce(false);
		await handler()("", ctx);

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored).toEqual(original); // untouched
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cancelled"), "info");
	});
});

describe("/rpiv-models — save failure", () => {
	it("notifies error AND does NOT reset cache on saveJsonConfig=false", async () => {
		if (process.platform === "win32") return;

		// Pre-seed BOTH disk AND cache with a known sentinel.
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ defaults: "anthropic/seed" }), "utf-8");
		const seeded = loadModelsConfig();
		expect(seeded.defaults?.model).toBe("anthropic/seed");

		// Force EISDIR by replacing the file with a directory at the config path.
		rmSync(CONFIG_PATH);
		mkdirSync(CONFIG_PATH);

		vi.mocked(showFilterablePicker).mockResolvedValueOnce("defaults").mockResolvedValueOnce("zai/glm-4-7");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save"), "error");

		// Cache MUST NOT have been reset on save failure.
		// The seeded sentinel persists — proving invalidateModelsConfigCache was NOT
		// called (early return on saveJsonConfig=false).
		const afterFail = loadModelsConfig();
		expect(afterFail.defaults?.model).toBe("anthropic/seed");
	});
});

describe("applyOverride", () => {
	it("writes a defaults entry as a bare model string", () => {
		const result = applyOverride({}, "defaults", [], { model: "zai/glm-4-7" });
		expect(result.defaults).toBe("zai/glm-4-7");
	});

	it("writes a defaults entry with thinking as an object", () => {
		const result = applyOverride({}, "defaults", [], { model: "zai/glm-4-7", thinking: "high" });
		expect(result.defaults).toEqual({ model: "zai/glm-4-7", thinking: "high" });
	});

	it("adds an agent entry to a new scope map", () => {
		const result = applyOverride({}, "agents", ["commit"], { model: "zai/glm-4-7" });
		expect(result.agents).toEqual({ commit: "zai/glm-4-7" });
	});

	it("merges into an existing scope map", () => {
		const result = applyOverride({ agents: { existing: "openai/gpt-5.5" } }, "agents", ["commit"], {
			model: "zai/glm-4-7",
		});
		expect(result.agents).toEqual({ existing: "openai/gpt-5.5", commit: "zai/glm-4-7" });
	});

	it("adds a stage entry with thinking as an object", () => {
		const result = applyOverride({}, "stages", ["plan"], { model: "openai/gpt-5.5", thinking: "off" });
		expect(result.stages).toEqual({ plan: { model: "openai/gpt-5.5", thinking: "off" } });
	});

	it("adds a preset stage to a new workflow", () => {
		const result = applyOverride({}, "presets", ["ship", "research"], { model: "zai/glm-4-7" });
		expect(result.presets).toEqual({ ship: { stages: { research: "zai/glm-4-7" } } });
	});

	it("adds a preset stage to an existing workflow", () => {
		const result = applyOverride(
			{ presets: { ship: { stages: { research: "zai/glm-4-7" } } } },
			"presets",
			["ship", "plan"],
			{ model: "openai/gpt-5.5", thinking: "medium" },
		);
		expect(result.presets).toEqual({
			ship: { stages: { research: "zai/glm-4-7", plan: { model: "openai/gpt-5.5", thinking: "medium" } } },
		});
	});

	it("returns config unchanged for an unknown scope", () => {
		const config = { defaults: "zai/glm-4-7" };
		const result = applyOverride(config, "unknown", ["key"], { model: "openai/gpt-5.5" });
		expect(result).toEqual(config);
	});
});

describe("/rpiv-models — loadWorkflowMap error handling", () => {
	it("notifies error when loadWorkflowMap throws for stages scope", async () => {
		const sources = await import("./models-config-sources.js");
		vi.spyOn(sources, "loadWorkflowMap").mockRejectedValueOnce(new Error("load failed"));
		vi.mocked(showFilterablePicker).mockResolvedValueOnce("stages");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No workflows"), "error");
	});

	it("notifies error when loadWorkflowMap throws for presets scope", async () => {
		const sources = await import("./models-config-sources.js");
		vi.spyOn(sources, "loadWorkflowMap").mockRejectedValueOnce(new Error("load failed"));
		vi.mocked(showFilterablePicker).mockResolvedValueOnce("presets");
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No workflows"), "error");
	});

	it("exits cleanly when the presets STAGE step's loadWorkflowMap rejects (second call)", async () => {
		rmSync(CONFIG_PATH, { force: true });
		const sources = await import("./models-config-sources.js");
		// Workflow step succeeds; the stage step's second load rejects (e.g. the
		// workflow was deleted between picks).
		vi.spyOn(sources, "loadWorkflowMap")
			.mockResolvedValueOnce({ ship: ["plan", "build"] })
			.mockRejectedValueOnce(new Error("load failed"));
		vi.mocked(showFilterablePicker).mockResolvedValueOnce("presets").mockResolvedValueOnce("ship"); // workflow picked; stage step then aborts before its picker
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No workflows"), "error");
		expect(existsSync(CONFIG_PATH)).toBe(false); // aborted before any write
	});
});

describe("/rpiv-models — ESC navigates one level up", () => {
	it("ESC at the model picker returns to the scope picker (re-shown, preselecting the prior scope)", async () => {
		rmSync(CONFIG_PATH, { force: true });
		// scope=defaults → model picker → ESC (back) → scope picker → ESC (exit).
		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("defaults")
			.mockResolvedValueOnce(null) // ESC at model → back to scope
			.mockResolvedValueOnce(null); // ESC at scope → exit
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		const calls = vi.mocked(showFilterablePicker).mock.calls;
		// The scope picker was shown a SECOND time after backing out of the model.
		expect(calls.length).toBeGreaterThanOrEqual(3);
		const reshownScope = calls[2][1] as { items: SelectItem[]; preferredValue?: string };
		expect(reshownScope.items.some((i) => i.value === "defaults")).toBe(true);
		expect(reshownScope.preferredValue).toBe("defaults"); // highlights where we came from
		// Nothing was written — the whole flow was cancelled out.
		expect(existsSync(CONFIG_PATH)).toBe(false);
	});

	it("ESC at the effort picker returns to the model picker (preselecting the prior model)", async () => {
		rmSync(CONFIG_PATH, { force: true });
		// defaults → reasoning model → ESC at effort (back) → re-pick a NON-reasoning model → save.
		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("defaults")
			.mockResolvedValueOnce("openai/gpt-5.5") // reasoning → effort prompt
			.mockResolvedValueOnce(null) // ESC at effort → back to model
			.mockResolvedValueOnce("zai/glm-4-7"); // re-pick (non-reasoning) → commits
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const calls = vi.mocked(showFilterablePicker).mock.calls;
		// calls: [0]=scope, [1]=model, [2]=effort, [3]=model re-shown.
		const reshownModel = calls[3][1] as { preferredValue?: string };
		expect(reshownModel.preferredValue).toBe("openai/gpt-5.5"); // the model we backed out of

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.defaults).toBe("zai/glm-4-7"); // the re-picked model won
	});

	it("ESC at the model picker for presets returns to the STAGE picker (one level), not the workflow", async () => {
		rmSync(CONFIG_PATH, { force: true });
		const sources = await import("./models-config-sources.js");
		vi.spyOn(sources, "loadWorkflowMap").mockResolvedValue({ ship: ["plan", "build"] });

		// presets → ship → plan → ESC at model (back to STAGE) → build → model → save.
		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("presets")
			.mockResolvedValueOnce("ship") // workflow
			.mockResolvedValueOnce("plan") // stage
			.mockResolvedValueOnce(null) // ESC at model → back to stage (NOT workflow)
			.mockResolvedValueOnce("build") // re-pick stage
			.mockResolvedValueOnce("zai/glm-4-7"); // model (non-reasoning) → commit
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const calls = vi.mocked(showFilterablePicker).mock.calls;
		// calls: [0]scope [1]workflow [2]stage [3]model [4]stage-again [5]model-again.
		const reshownStage = calls[4][1] as { title: string; preferredValue?: string };
		expect(reshownStage.title).toContain("Stage"); // landed on the stage picker, not workflow
		expect(reshownStage.preferredValue).toBe("plan"); // preselects the stage we backed out of

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.presets.ship.stages.build).toBe("zai/glm-4-7");
		expect(stored.presets.ship.stages.plan).toBeUndefined(); // only one level up — workflow kept
	});

	it("ESC at the first key step returns to the scope picker, where a different scope proceeds", async () => {
		rmSync(CONFIG_PATH, { force: true });
		// agents → ESC at agent step (back to scope) → skills → commit → model → save.
		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("agents")
			.mockResolvedValueOnce(null) // ESC at agent key step → back to scope
			.mockResolvedValueOnce("skills") // pick a different scope
			.mockResolvedValueOnce("commit") // skill key step
			.mockResolvedValueOnce("zai/glm-4-7"); // model (non-reasoning) → commit
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const calls = vi.mocked(showFilterablePicker).mock.calls;
		const reshownScope = calls[2][1] as { items: SelectItem[]; preferredValue?: string };
		expect(reshownScope.items.some((i) => i.value === "skills")).toBe(true);
		expect(reshownScope.preferredValue).toBe("agents"); // highlights the scope we backed out of

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.skills.commit).toBe("zai/glm-4-7");
	});

	it("inner pickers advertise ESC as 'back' in the nav hint; the scope picker keeps 'cancel'", async () => {
		rmSync(CONFIG_PATH, { force: true });
		vi.mocked(showFilterablePicker).mockResolvedValueOnce("defaults").mockResolvedValueOnce(null);
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const calls = vi.mocked(showFilterablePicker).mock.calls;
		expect((calls[0][1] as { escHint?: string }).escHint).toBeUndefined(); // scope → default "cancel"
		expect((calls[1][1] as { escHint?: string }).escHint).toBe("back"); // model → "back"
	});
});

describe("/rpiv-models — committing returns to the parent list (not close)", () => {
	it("after saving a keyed override, returns to the KEY list with the new ✓ (not the scope picker)", async () => {
		rmSync(CONFIG_PATH, { force: true });
		// skills → commit → model (non-reasoning) → SAVE → land back on the skill list → ESC out.
		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("skills")
			.mockResolvedValueOnce("commit")
			.mockResolvedValueOnce("zai/glm-4-7") // non-reasoning → commits immediately
			.mockResolvedValueOnce(null) // ESC on the re-shown skill list → back to scope
			.mockResolvedValueOnce(null); // ESC on scope → exit
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const calls = vi.mocked(showFilterablePicker).mock.calls;
		// calls[3] is the skill list re-shown AFTER the save — same picker, now with ✓.
		const reshown = calls[3][1] as { title: string; items: SelectItem[] };
		expect(reshown.title).toBe("Skill"); // returned to the key list, not scope/model
		expect(reshown.items.find((i) => i.value === "commit")?.label).toContain("✓"); // reflects the save
		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.skills.commit).toBe("zai/glm-4-7");
	});

	it("after saving a defaults override (no key list), returns to the SCOPE picker with the new ✓", async () => {
		rmSync(CONFIG_PATH, { force: true });
		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("defaults")
			.mockResolvedValueOnce("zai/glm-4-7") // non-reasoning → commits
			.mockResolvedValueOnce(null); // ESC on the re-shown scope picker → exit
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const calls = vi.mocked(showFilterablePicker).mock.calls;
		// calls[2] is the scope picker re-shown AFTER the save.
		const reshown = calls[2][1] as { title: string; items: SelectItem[]; preferredValue?: string };
		expect(reshown.title).toBe("Model Overrides"); // back at the top-level scope picker
		expect(reshown.preferredValue).toBe("defaults"); // preselects where we came from
		expect(reshown.items.find((i) => i.value === "defaults")?.label).toContain("✓");
	});

	it("supports configuring multiple overrides in one session (save, return to list, configure another)", async () => {
		rmSync(CONFIG_PATH, { force: true });
		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("agents")
			.mockResolvedValueOnce("codebase-analyst")
			.mockResolvedValueOnce("zai/glm-4-7") // save agents/codebase-analyst → back to agent list
			.mockResolvedValueOnce("codebase-locator")
			.mockResolvedValueOnce("zai/glm-4-7") // save agents/codebase-locator → back to agent list
			.mockResolvedValueOnce(null) // ESC agent list → scope
			.mockResolvedValueOnce(null); // ESC scope → exit
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		await handler()("", makeCtx());

		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.agents["codebase-analyst"]).toBe("zai/glm-4-7");
		expect(stored.agents["codebase-locator"]).toBe("zai/glm-4-7"); // both written in one run
	});

	it("after a per-entry reset, returns to the key list with the ✓ now gone", async () => {
		const target = bundledAgentNames()[0]; // a real bundled agent so it appears in the list
		rmSync(CONFIG_PATH, { force: true });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ agents: { [target]: "zai/glm-4-7" } }), "utf-8");

		vi.mocked(showFilterablePicker)
			.mockResolvedValueOnce("agents")
			.mockResolvedValueOnce(target)
			.mockResolvedValueOnce("__reset__") // remove → back to agent list
			.mockResolvedValueOnce(null) // ESC agent list → scope
			.mockResolvedValueOnce(null); // ESC scope → exit
		const { pi, handler } = makePi();
		registerRpivModelsCommand(pi);
		const ctx = makeCtx();
		await handler()("", ctx);

		const calls = vi.mocked(showFilterablePicker).mock.calls;
		const reshown = calls[3][1] as { title: string; items: SelectItem[] };
		expect(reshown.title).toBe("Agent"); // returned to the key list
		expect(reshown.items.find((i) => i.value === target)?.label).not.toContain("✓");
		const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(stored.agents).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Removed"), "info");
	});
});
