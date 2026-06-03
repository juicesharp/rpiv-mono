/**
 * Unit tests for the pure helpers + scope descriptors extracted during the
 * /rpiv-models split (overrides.ts, items.ts). The command handler is covered
 * by rpiv-models-command.test.ts; this file pins the building blocks directly.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { SelectItem } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ModelsConfigSchema } from "../models-config.js";
import { buildEffortItems, buildModelItems, INHERIT_VALUE, loadRawConfig, scopeItems } from "./items.js";
import {
	applyOverride,
	CHECK,
	floatChecked,
	keyItems,
	removeOverride,
	SCOPE_AGENTS,
	SCOPE_SKILLS,
	SCOPE_STAGES,
	SCOPES,
	withCheck,
} from "./overrides.js";

const model = (provider: string, id: string, name: string, reasoning = false): Model<Api> =>
	({ provider, id, name, reasoning }) as unknown as Model<Api>;

describe("overrides — small UI helpers", () => {
	it("withCheck appends the ✓ suffix only when has=true", () => {
		expect(withCheck("agents", true)).toBe(`agents${CHECK}`);
		expect(withCheck("agents", false)).toBe("agents");
	});

	it("floatChecked floats ✓-marked items to the front, preserving relative order", () => {
		const items: SelectItem[] = [
			{ value: "a", label: "a" },
			{ value: "b", label: `b${CHECK}` },
			{ value: "c", label: "c" },
			{ value: "d", label: `d${CHECK}` },
		];
		expect(floatChecked(items).map((i) => i.value)).toEqual(["b", "d", "a", "c"]);
	});

	it("keyItems decorates via `has` then floats the marked ones up", () => {
		const items = keyItems(["x", "y", "z"], (n) => n === "y");
		expect(items.map((i) => i.value)).toEqual(["y", "x", "z"]);
		expect(items[0].label).toBe(`y${CHECK}`);
		expect(items[1].label).toBe("x");
	});
});

describe("overrides — scope descriptors", () => {
	it("defaults: has/getCurrentKey handle string and object forms", () => {
		const d = SCOPES.defaults;
		expect(d.hasOverride({})).toBe(false);
		expect(d.hasOverride({ defaults: "openai/gpt" } as ModelsConfigSchema)).toBe(true);
		expect(d.keyHasOverride({ defaults: "openai/gpt" } as ModelsConfigSchema, [])).toBe(true);
		expect(d.getCurrentKey({ defaults: "openai/gpt" } as ModelsConfigSchema, [])).toBe("openai/gpt");
		expect(d.getCurrentKey({ defaults: { model: "a/b" } } as ModelsConfigSchema, [])).toBe("a/b");
		expect(d.getCurrentKey({} as ModelsConfigSchema, [])).toBeUndefined();
	});

	it.each([SCOPE_AGENTS, SCOPE_STAGES, SCOPE_SKILLS])("flat-map scope %s: has/keyHas/getCurrentKey", (scope) => {
		const s = SCOPES[scope];
		const raw = { [scope]: { foo: "a/b", bar: { model: "c/d" } } } as unknown as ModelsConfigSchema;
		expect(s.hasOverride(raw)).toBe(true);
		expect(s.hasOverride({ [scope]: {} } as unknown as ModelsConfigSchema)).toBe(false);
		expect(s.hasOverride({} as ModelsConfigSchema)).toBe(false);
		expect(s.keyHasOverride(raw, ["foo"])).toBe(true);
		expect(s.keyHasOverride(raw, ["missing"])).toBe(false);
		expect(s.getCurrentKey(raw, ["foo"])).toBe("a/b");
		expect(s.getCurrentKey(raw, ["bar"])).toBe("c/d");
		expect(s.getCurrentKey({} as ModelsConfigSchema, ["foo"])).toBeUndefined();
	});

	it("presets: workflow-level and stage-level checks", () => {
		const p = SCOPES.presets;
		const raw = { presets: { ship: { stages: { plan: "a/b" } } } } as unknown as ModelsConfigSchema;
		expect(p.hasOverride(raw)).toBe(true);
		expect(p.hasOverride({ presets: {} } as ModelsConfigSchema)).toBe(false);
		expect(p.keyHasOverride(raw, ["ship"])).toBe(true);
		expect(p.keyHasOverride(raw, ["other"])).toBe(false);
		expect(p.keyHasOverride(raw, ["ship", "plan"])).toBe(true);
		expect(p.keyHasOverride(raw, ["ship", "build"])).toBe(false);
		expect(p.getCurrentKey(raw, ["ship", "plan"])).toBe("a/b");
		expect(p.getCurrentKey(raw, ["ship", "missing"])).toBeUndefined();
	});
});

describe("overrides — module-level convenience guards", () => {
	it("removeOverride/applyOverride no-op on an unknown scope", () => {
		const config = { defaults: "a/b" } as ModelsConfigSchema;
		expect(removeOverride(config, "bogus", [])).toEqual({ next: config, removed: false });
		expect(applyOverride(config, "bogus", [], { model: "c/d" })).toBe(config);
	});
});

describe("items — builders", () => {
	it("scopeItems marks scopes that hold overrides and always offers reset-all", () => {
		const raw = { agents: { foo: "a/b" }, defaults: "x/y" } as unknown as ModelsConfigSchema;
		const items = scopeItems(raw);
		const byValue = Object.fromEntries(items.map((i) => [i.value, i.label]));
		expect(byValue.defaults).toBe(`defaults${CHECK}`);
		expect(byValue.agents).toBe(`agents${CHECK}`);
		expect(byValue.stages).toBe("stages");
		expect(byValue.__reset_all__).toBe("reset all overrides");
	});

	it("buildModelItems floats the current selection to the top with a ✓", () => {
		const models = [model("zai", "glm", "GLM"), model("openai", "gpt", "GPT")];
		const items = buildModelItems(models, "openai/gpt");
		expect(items[0].value).toBe("openai/gpt");
		expect(items[0].label).toContain(CHECK);
		// The non-current entry keeps no checkmark.
		expect(items[1].value).toBe("zai/glm");
		expect(items[1].label).not.toContain(CHECK);
	});

	it("buildModelItems leaves order untouched when no currentKey is given", () => {
		const models = [model("zai", "glm", "GLM"), model("openai", "gpt", "GPT")];
		const items = buildModelItems(models);
		expect(items.map((i) => i.value)).toEqual(["zai/glm", "openai/gpt"]);
		expect(items.every((i) => !i.label.includes(CHECK))).toBe(true);
	});

	it("buildEffortItems always offers 'inherit' first", () => {
		const items = buildEffortItems(model("openai", "gpt", "GPT", true));
		expect(items[0].value).toBe(INHERIT_VALUE);
		// Every offered value is a known sentinel or thinking level (never empty).
		expect(items.length).toBeGreaterThanOrEqual(1);
	});

	it("loadRawConfig returns an object (fail-soft to {} when no file exists)", () => {
		expect(typeof loadRawConfig()).toBe("object");
	});
});
