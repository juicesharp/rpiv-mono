import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { getAdvisorEffort, getAdvisorModel, restoreAdvisorState } from "./advisor.js";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-advisor", "advisor.json");

function writeConfig(contents: object) {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(contents), "utf-8");
}

describe("restoreAdvisorState", () => {
	it("no-ops when config is missing", () => {
		const { pi } = createMockPi();
		const ctx = createMockCtx();
		restoreAdvisorState(ctx, pi);
		expect(getAdvisorModel()).toBeUndefined();
	});
	it("no-ops when modelKey is absent", () => {
		writeConfig({ effort: "high" });
		const { pi } = createMockPi();
		const ctx = createMockCtx();
		restoreAdvisorState(ctx, pi);
		expect(getAdvisorModel()).toBeUndefined();
		expect(getAdvisorEffort()).toBeUndefined();
	});
	it("no-ops when modelKey lacks ':' separator", () => {
		writeConfig({ modelKey: "malformed" });
		const { pi } = createMockPi();
		const ctx = createMockCtx();
		restoreAdvisorState(ctx, pi);
		expect(getAdvisorModel()).toBeUndefined();
	});
	it("notifies + no-ops when registry.find returns undefined", () => {
		writeConfig({ modelKey: "unknown:model" });
		const { pi } = createMockPi();
		const ctx = createMockCtx({ hasUI: true });
		ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => undefined) } as never;
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		restoreAdvisorState(ctx, pi);
		expect(getAdvisorModel()).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("no longer available"), "warning");
	});
	it("happy path: sets model + effort + pushes advisor into active tools", () => {
		writeConfig({ modelKey: "a:m", effort: "high" });
		const model = { provider: "a", id: "m", name: "M" } as never;
		const { pi, captured } = createMockPi();
		const ctx = createMockCtx({ hasUI: true });
		ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => model) } as never;
		restoreAdvisorState(ctx, pi);
		expect(getAdvisorModel()).toEqual(model);
		expect(getAdvisorEffort()).toBe("high");
		expect(captured.activeTools).toContain("advisor");
	});
	it("does NOT push advisor again if already active", () => {
		writeConfig({ modelKey: "a:m" });
		const model = { provider: "a", id: "m" } as never;
		const { pi, captured } = createMockPi({ getActiveTools: vi.fn(() => ["advisor"]) as never });
		const ctx = createMockCtx();
		ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => model) } as never;
		restoreAdvisorState(ctx, pi);
		expect(captured.activeTools).not.toContain("advisor");
	});
});
