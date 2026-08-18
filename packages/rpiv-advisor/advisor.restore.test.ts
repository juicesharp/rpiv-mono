import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import {
	__resetAdvisorAnnounced,
	getAdvisorEffort,
	getAdvisorModel,
	restoreAdvisorState,
	setAdvisorEffort,
	setAdvisorModel,
} from "./advisor/index.js";

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
	// Regression — stale in-memory effort must not survive a restore whose
	// config carries a model but no effort. "Model present, effort absent" is a
	// first-class persisted state (the /advisor Esc and off choices both save
	// it), and another process can remove the field mid-session; restore must
	// overwrite, never merge.
	it("clears stale in-memory effort when the config has a model but no effort", () => {
		setAdvisorModel({ provider: "a", id: "m" } as never);
		setAdvisorEffort("high");
		writeConfig({ modelKey: "a:m" });
		const model = { provider: "a", id: "m", name: "M" } as never;
		const { pi } = createMockPi();
		const ctx = createMockCtx();
		ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => model) } as never;
		restoreAdvisorState(ctx, pi);
		expect(getAdvisorModel()).toEqual(model);
		expect(getAdvisorEffort()).toBeUndefined();
	});
	it("drops an out-of-ordinal persisted effort instead of restoring it", () => {
		writeConfig({ modelKey: "a:m", effort: "off" });
		const model = { provider: "a", id: "m", name: "M" } as never;
		const { pi } = createMockPi();
		const ctx = createMockCtx();
		ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => model) } as never;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			restoreAdvisorState(ctx, pi);
		} finally {
			warn.mockRestore();
		}
		expect(getAdvisorModel()).toEqual(model);
		expect(getAdvisorEffort()).toBeUndefined();
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

	// Regression — issue #72: the advisor tool registers active-by-default, so
	// when no usable model is configured restore MUST strip it; otherwise its
	// promptSnippet/promptGuidelines linger in the base system prompt while every
	// advisor() call would fail with ERR_NO_MODEL.
	describe("strips advisor when no usable model is configured (issue #72)", () => {
		it("strips advisor from active tools when modelKey is absent", () => {
			writeConfig({ effort: "high" });
			const { pi, captured } = createMockPi();
			pi.setActiveTools(["advisor", "other"]);
			const ctx = createMockCtx();
			restoreAdvisorState(ctx, pi);
			expect(captured.activeTools).toEqual(["other"]);
		});

		it("strips advisor when modelKey lacks ':' separator", () => {
			writeConfig({ modelKey: "malformed" });
			const { pi, captured } = createMockPi();
			pi.setActiveTools(["advisor", "other"]);
			const ctx = createMockCtx();
			restoreAdvisorState(ctx, pi);
			expect(captured.activeTools).toEqual(["other"]);
		});

		it("strips advisor when registry.find returns undefined", () => {
			writeConfig({ modelKey: "unknown:model" });
			const { pi, captured } = createMockPi();
			pi.setActiveTools(["advisor", "other"]);
			const ctx = createMockCtx({ hasUI: true });
			ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => undefined) } as never;
			restoreAdvisorState(ctx, pi);
			expect(captured.activeTools).toEqual(["other"]);
		});

		it("no-ops when advisor is already absent and no model is configured", () => {
			writeConfig({ effort: "high" });
			const { pi, captured } = createMockPi();
			pi.setActiveTools(["other"]);
			vi.mocked(pi.setActiveTools).mockClear();
			const ctx = createMockCtx();
			restoreAdvisorState(ctx, pi);
			expect(pi.setActiveTools).not.toHaveBeenCalled();
			expect(captured.activeTools).toEqual(["other"]);
		});

		// A no-model exit must also clear the module-level selection. Otherwise
		// a model set by a prior session_start lingers, and the per-turn
		// before_agent_start strip reads it as truthy and re-adds the tool.
		it("clears a stale advisor selection when modelKey is later absent", () => {
			setAdvisorModel({ provider: "a", id: "m" } as never);
			setAdvisorEffort("high");
			writeConfig({});
			const { pi, captured } = createMockPi();
			pi.setActiveTools(["advisor", "other"]);
			const ctx = createMockCtx();
			restoreAdvisorState(ctx, pi);
			expect(getAdvisorModel()).toBeUndefined();
			expect(getAdvisorEffort()).toBeUndefined();
			expect(captured.activeTools).toEqual(["other"]);
		});

		// The model-found-but-executor-blocked path strips too (model exists,
		// so this branch's setup differs from the no-model paths above).
		it("strips advisor when a valid model is configured but the executor is blocked", () => {
			writeConfig({ modelKey: "anthropic:opus", disabledForModels: ["anthropic:sonnet"] });
			const model = { provider: "anthropic", id: "opus", name: "Opus" } as never;
			const { pi, captured } = createMockPi();
			pi.setActiveTools(["advisor", "other"]);
			const ctx = createMockCtx({
				hasUI: true,
				model: { provider: "anthropic", id: "sonnet", name: "Sonnet" } as never,
			});
			ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => model) } as never;
			restoreAdvisorState(ctx, pi);
			expect(getAdvisorModel()).toEqual(model);
			expect(captured.activeTools).toEqual(["other"]);
		});
	});

	describe("notify-once latch", () => {
		// Pi fires `session_start` for every session including programmatic
		// spawns (workflow stages, batch ops, etc.). State mutation must run
		// each fire; the user-facing announcement must NOT — repeating it
		// once per stage spams the status line. The latch flips on the first
		// notify and stays until `__resetAdvisorAnnounced()` (test reset) or
		// `/reload` (production module reload).

		it("first call notifies the 'Advisor restored' message and mutates state", () => {
			writeConfig({ modelKey: "a:m", effort: "high" });
			const model = { provider: "a", id: "m", name: "M" } as never;
			const { pi, captured } = createMockPi();
			const ctx = createMockCtx({ hasUI: true });
			ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => model) } as never;
			const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;

			restoreAdvisorState(ctx, pi);

			expect(getAdvisorModel()).toEqual(model);
			expect(getAdvisorEffort()).toBe("high");
			expect(captured.activeTools).toContain("advisor");
			expect(notify).toHaveBeenCalledTimes(1);
		});

		it("second call (e.g. workflow child session_start) re-runs state mutation but does NOT re-notify", () => {
			writeConfig({ modelKey: "a:m", effort: "high" });
			const model = { provider: "a", id: "m", name: "M" } as never;
			const { pi } = createMockPi();
			const ctx = createMockCtx({ hasUI: true });
			ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => model) } as never;
			const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;

			restoreAdvisorState(ctx, pi);
			restoreAdvisorState(ctx, pi);
			restoreAdvisorState(ctx, pi);

			// State mutation happens every call.
			expect(getAdvisorModel()).toEqual(model);
			// Notify only on the first call.
			expect(notify).toHaveBeenCalledTimes(1);
		});

		it("`__resetAdvisorAnnounced()` re-arms the latch (covers /reload)", () => {
			writeConfig({ modelKey: "a:m", effort: "high" });
			const model = { provider: "a", id: "m", name: "M" } as never;
			const { pi } = createMockPi();
			const ctx = createMockCtx({ hasUI: true });
			ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => model) } as never;
			const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;

			restoreAdvisorState(ctx, pi);
			restoreAdvisorState(ctx, pi);
			__resetAdvisorAnnounced();
			restoreAdvisorState(ctx, pi);

			expect(notify).toHaveBeenCalledTimes(2);
		});

		it("'no longer available' warning also latches once per process", () => {
			writeConfig({ modelKey: "unknown:model" });
			const { pi } = createMockPi();
			const ctx = createMockCtx({ hasUI: true });
			ctx.modelRegistry = { ...ctx.modelRegistry, find: vi.fn(() => undefined) } as never;
			const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;

			restoreAdvisorState(ctx, pi);
			restoreAdvisorState(ctx, pi);

			expect(notify).toHaveBeenCalledTimes(1);
		});
	});
});
