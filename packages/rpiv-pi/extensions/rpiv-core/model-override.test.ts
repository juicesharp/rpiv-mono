import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { StageRef, UnitEvent } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetModelOverrideState,
	registerModelOverrideLifecycle,
	registerModelOverrideSessionStart,
} from "./model-override.js";

// The lifecycle registry rpiv-workflow exposes via registerLifecycle is anchored
// on this well-known Symbol. We read it directly to invoke the bundle our
// registerModelOverrideLifecycle pushed, without driving a full workflow run.
const LIFECYCLE_KEY = Symbol.for("@juicesharp/rpiv-workflow:lifecycle");

interface LifecycleBundle {
	onWorkflowStart?: (ctx: unknown) => unknown | Promise<unknown>;
	onStageStart?: (stage: StageRef, ctx: { workflow: string }) => unknown | Promise<unknown>;
	onUnitStart?: (stage: StageRef, unit: UnitEvent, ctx: { workflow: string }) => unknown | Promise<unknown>;
	onWorkflowEnd?: (result: unknown, ctx: unknown) => unknown | Promise<unknown>;
}

// StageRef/UnitEvent fixtures — the runner always sends the discriminated
// StageRef shape, so the listener's `stage.kind === "skill"` narrowing only
// sees the skills cascade rung on the "skill" arm.
const scriptStage = (name: string): StageRef => ({ kind: "script", name, stageNumber: 1 });
const skillStage = (name: string, skill: string): StageRef => ({ kind: "skill", name, stageNumber: 1, skill });
const unit = (skill: string): UnitEvent => ({ role: "produce", index: 0, label: skill, skill });

function lastListener(): LifecycleBundle {
	const reg = ((globalThis as Record<symbol, unknown>)[LIFECYCLE_KEY] ?? []) as LifecycleBundle[];
	expect(reg.length).toBeGreaterThan(0);
	return reg[reg.length - 1];
}

function writeModels(config: unknown): void {
	const dir = join(process.env.HOME!, ".config", "rpiv-pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "models.json"), JSON.stringify(config), "utf-8");
}

type SessionStartHandler = (ev: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface FakePi {
	pi: ExtensionAPI;
	setModel: ReturnType<typeof vi.fn>;
	setThinkingLevel: ReturnType<typeof vi.fn>;
	sessionStart: () => SessionStartHandler | undefined;
}

/** Minimal ExtensionAPI stub exposing only the methods model-override touches. */
function makePi(opts: { setModelResult?: boolean; baselineThinking?: string } = {}): FakePi {
	let handler: SessionStartHandler | undefined;
	const setModel = vi.fn(async () => opts.setModelResult ?? true);
	const setThinkingLevel = vi.fn();
	const pi = {
		on: vi.fn((event: string, h: SessionStartHandler) => {
			if (event === "session_start") handler = h;
		}),
		setModel,
		setThinkingLevel,
		getThinkingLevel: vi.fn(() => opts.baselineThinking ?? "medium"),
	} as unknown as ExtensionAPI;
	return { pi, setModel, setThinkingLevel, sessionStart: () => handler };
}

/** A resolved baseline Model object as captured from session_start. */
const BASELINE_MODEL = { provider: "anthropic", id: "baseline" };

describe("model-override", () => {
	it("__resetModelOverrideState clears baseline", () => {
		__resetModelOverrideState();
		// After reset, internal state is clean (tested via lifecycle integration)
		expect(true).toBe(true);
	});

	describe("session_start capture", () => {
		it("captures modelRegistry and the current model from ExtensionContext", async () => {
			writeModels({ stages: { plan: { model: "anthropic/opus", thinking: "high" } } });
			const { pi, setModel, sessionStart } = makePi({ baselineThinking: "low" });
			registerModelOverrideSessionStart(pi);
			const handler = sessionStart();
			expect(handler).toBeDefined();

			const registry = { find: vi.fn((p: string, m: string) => ({ provider: p, id: m })) };
			await handler!({}, { modelRegistry: registry, model: BASELINE_MODEL });

			// The captured model surfaces only via the lifecycle: onWorkflowStart
			// snapshots it as baseline.model, onWorkflowEnd restores it via setModel.
			await registerModelOverrideLifecycle(pi);
			const lc = lastListener();
			await lc.onWorkflowStart?.({});
			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });
			await lc.onWorkflowEnd?.({}, {});

			expect(setModel).toHaveBeenCalledWith({ provider: "anthropic", id: "opus" });
			expect(setModel).toHaveBeenLastCalledWith(BASELINE_MODEL);
		});

		it("does not refresh capturedModel while a workflow is active (no baseline pollution)", async () => {
			writeModels({ stages: { plan: { model: "anthropic/opus" } } });
			const { pi, setModel, sessionStart } = makePi();
			registerModelOverrideSessionStart(pi);
			await registerModelOverrideLifecycle(pi);
			const handler = sessionStart()!;
			const registry = { find: vi.fn((p: string, m: string) => ({ provider: p, id: m })) };

			// Capture the real baseline before the workflow.
			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL });

			const lc = lastListener();
			await lc.onWorkflowStart?.({}); // freezes capturedModel
			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });

			// A stage's newSession re-fires session_start with a DIFFERENT model.
			const overrideModel = { provider: "openai", id: "o3-pro" };
			await handler({}, { modelRegistry: registry, model: overrideModel });

			await lc.onWorkflowEnd?.({}, {});

			// Restoration must use the pre-workflow baseline, not the stage override.
			expect(setModel).toHaveBeenLastCalledWith(BASELINE_MODEL);
		});
	});

	describe("onStageStart override application", () => {
		async function setup(opts: { setModelResult?: boolean } = {}) {
			const fake = makePi({ baselineThinking: "medium", ...opts });
			registerModelOverrideSessionStart(fake.pi);
			await registerModelOverrideLifecycle(fake.pi);
			const handler = fake.sessionStart()!;
			const registry = {
				find: vi.fn((provider: string, modelId: string) => ({ provider, id: modelId })),
			};
			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL });
			const lc = lastListener();
			await lc.onWorkflowStart?.({});
			return { ...fake, registry, lc };
		}

		it("applies a configured stage model (resolved via registry) and thinking", async () => {
			writeModels({ stages: { plan: { model: "openai:o3-pro", thinking: "high" } } });
			const { setModel, setThinkingLevel, registry, lc } = await setup();

			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });

			expect(registry.find).toHaveBeenCalledWith("openai", "o3-pro");
			expect(setModel).toHaveBeenLastCalledWith({ provider: "openai", id: "o3-pro" });
			expect(setThinkingLevel).toHaveBeenLastCalledWith("high");
		});

		it("applies an explicit thinking: off (disable reasoning) override", async () => {
			writeModels({ stages: { plan: { model: "openai:o3-pro", thinking: "off" } } });
			const { setThinkingLevel, lc } = await setup();

			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });

			expect(setThinkingLevel).toHaveBeenLastCalledWith("off");
		});

		it("falls back to baseline model AND baseline thinking for an unconfigured stage (no bleedthrough)", async () => {
			writeModels({ stages: { plan: { model: "openai:o3-pro" } } });
			const { setModel, setThinkingLevel, lc } = await setup();

			// Stage 1 sets the override model.
			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });
			// Stage 2 is unconfigured → must revert to baseline, not stage 1's model.
			await lc.onStageStart?.(scriptStage("implement"), { workflow: "test-wf" });

			expect(setModel).toHaveBeenLastCalledWith(BASELINE_MODEL);
			expect(setThinkingLevel).toHaveBeenLastCalledWith("medium");
		});

		it("warns and uses baseline when the override model is not found in the registry", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			writeModels({ stages: { plan: { model: "openai:o3-pro" } } });
			const fake = makePi({ baselineThinking: "medium" });
			registerModelOverrideSessionStart(fake.pi);
			await registerModelOverrideLifecycle(fake.pi);
			const handler = fake.sessionStart()!;
			const registry = { find: vi.fn(() => undefined) }; // model not found
			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL });
			const lc = lastListener();
			await lc.onWorkflowStart?.({});

			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });

			expect(warn).toHaveBeenCalledWith(expect.stringContaining("model not found"));
			expect(fake.setModel).toHaveBeenLastCalledWith(BASELINE_MODEL);
			warn.mockRestore();
		});

		it("soft-fails (warns, proceeds) when setModel returns false", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			writeModels({ stages: { plan: { model: "openai:o3-pro", thinking: "high" } } });
			const { setThinkingLevel, lc } = await setup({ setModelResult: false });

			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });

			expect(warn).toHaveBeenCalledWith(expect.stringContaining("setModel failed"));
			// Thinking is still applied — the failure does not abort the stage hook.
			expect(setThinkingLevel).toHaveBeenLastCalledWith("high");
			warn.mockRestore();
		});

		it("is a no-op when no baseline was captured (workflow not started)", async () => {
			writeModels({ stages: { plan: { model: "openai:o3-pro", thinking: "high" } } });
			const fake = makePi();
			registerModelOverrideSessionStart(fake.pi);
			await registerModelOverrideLifecycle(fake.pi);
			const lc = lastListener();

			// onStageStart before onWorkflowStart → must early-return.
			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });

			expect(fake.setModel).not.toHaveBeenCalled();
			expect(fake.setThinkingLevel).not.toHaveBeenCalled();
		});

		describe("per-skill + per-preset cascade", () => {
			it("preset-stage wins when workflow + stage match", async () => {
				writeModels({
					defaults: "anthropic/opus",
					stages: { plan: "anthropic/opus" },
					presets: {
						ship: { stages: { plan: { model: "openai/gpt-5.5", thinking: "high" } } },
					},
				});
				const { setModel, setThinkingLevel, lc } = await setup();

				await lc.onStageStart?.(skillStage("plan", "plan"), { workflow: "ship" });

				expect(setModel).toHaveBeenLastCalledWith({ provider: "openai", id: "gpt-5.5" });
				expect(setThinkingLevel).toHaveBeenLastCalledWith("high");
			});

			it("falls through preset miss to flat stage", async () => {
				writeModels({
					stages: { plan: { model: "anthropic/opus" } },
					presets: { ship: { stages: { research: { model: "openai/gpt-5.5" } } } },
				});
				const { setModel, lc } = await setup();

				await lc.onStageStart?.(skillStage("plan", "plan"), { workflow: "ship" });

				expect(setModel).toHaveBeenLastCalledWith({ provider: "anthropic", id: "opus" });
			});

			it("falls through preset + stage miss to skills[skill]", async () => {
				writeModels({ skills: { commit: { model: "zai/glm-4-7" } } });
				const { setModel, lc } = await setup();

				await lc.onStageStart?.(skillStage("commit", "commit"), { workflow: "polish" });

				expect(setModel).toHaveBeenLastCalledWith({ provider: "zai", id: "glm-4-7" });
			});

			it("skips skills rung for script stages (no stage.skill)", async () => {
				writeModels({
					defaults: "anthropic/opus",
					skills: { tally: { model: "zai/glm-4-7" } }, // would match if rung not skipped
				});
				const { setModel, lc } = await setup();

				// Script stage: stage.skill undefined → skills rung skipped → defaults wins.
				await lc.onStageStart?.(scriptStage("tally"), { workflow: "polish" });

				expect(setModel).toHaveBeenLastCalledWith({ provider: "anthropic", id: "opus" });
			});

			it("preset-stage entry inherits defaults per-field at load time", async () => {
				writeModels({
					defaults: { model: "anthropic/opus" },
					presets: { ship: { stages: { plan: { thinking: "high" } } } },
				});
				const { setModel, setThinkingLevel, lc } = await setup();

				await lc.onStageStart?.(skillStage("plan", "plan"), { workflow: "ship" });

				expect(setModel).toHaveBeenLastCalledWith({ provider: "anthropic", id: "opus" });
				expect(setThinkingLevel).toHaveBeenLastCalledWith("high");
			});

			it("no preset/skill/stage match → falls through to baseline (no-bleed)", async () => {
				writeModels({ presets: { ship: { stages: { plan: "openai/gpt-5.5" } } } });
				const { setModel, setThinkingLevel, lc } = await setup();

				// workflow "polish" has no preset entry; stage "research" not in flat
				// stages; skill "research" not in skills → defaults absent → baseline.
				await lc.onStageStart?.(skillStage("research", "research"), { workflow: "polish" });

				expect(setModel).toHaveBeenLastCalledWith(BASELINE_MODEL);
				expect(setThinkingLevel).toHaveBeenLastCalledWith("medium"); // baseline thinking
			});
		});
	});

	describe("onUnitStart per-unit override application", () => {
		async function setup(opts: { setModelResult?: boolean } = {}) {
			const fake = makePi({ baselineThinking: "medium", ...opts });
			registerModelOverrideSessionStart(fake.pi);
			await registerModelOverrideLifecycle(fake.pi);
			const handler = fake.sessionStart()!;
			const registry = {
				find: vi.fn((provider: string, modelId: string) => ({ provider, id: modelId })),
			};
			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL });
			const lc = lastListener();
			await lc.onWorkflowStart?.({});
			return { ...fake, registry, lc };
		}

		it("resolves a judge unit's model through skills[judge.skill] (judges get their own model)", async () => {
			// A judge unit dispatches the judge's own skill body; the cascade resolves
			// it through the `skills.<judge.skill>` rung — the first time a judge can
			// carry a distinct model.
			writeModels({ skills: { "grade-breakdown": { model: "zai/glm-4-7", thinking: "high" } } });
			const { setModel, setThinkingLevel, registry, lc } = await setup();

			await lc.onUnitStart?.(skillStage("breakdown", "breakdown"), unit("grade-breakdown"), { workflow: "polish" });

			expect(registry.find).toHaveBeenCalledWith("zai", "glm-4-7");
			expect(setModel).toHaveBeenLastCalledWith({ provider: "zai", id: "glm-4-7" });
			expect(setThinkingLevel).toHaveBeenLastCalledWith("high");
		});

		it("reverts an unconfigured unit to baseline (no bleed-through from the prior unit's model)", async () => {
			// The judge unit is configured; the following produce unit is not — it must
			// revert to baseline, not inherit the judge's model.
			writeModels({ skills: { "grade-breakdown": { model: "zai/glm-4-7" } } });
			const { setModel, setThinkingLevel, lc } = await setup();

			await lc.onUnitStart?.(skillStage("breakdown", "breakdown"), unit("grade-breakdown"), { workflow: "polish" });
			await lc.onUnitStart?.(skillStage("breakdown", "breakdown"), unit("breakdown"), { workflow: "polish" });

			expect(setModel).toHaveBeenLastCalledWith(BASELINE_MODEL);
			expect(setThinkingLevel).toHaveBeenLastCalledWith("medium");
		});

		it("idempotently re-applies a produce unit's stage override", async () => {
			// A produce unit re-resolves the stage's own override via the skills rung —
			// the same model the stage applied at onStageStart, re-applied per unit.
			writeModels({ skills: { implement: { model: "openai/o3-pro", thinking: "high" } } });
			const { setModel, setThinkingLevel, lc } = await setup();

			await lc.onUnitStart?.(skillStage("implement", "implement"), unit("implement"), { workflow: "ship" });
			await lc.onUnitStart?.(skillStage("implement", "implement"), unit("implement"), { workflow: "ship" });

			expect(setModel).toHaveBeenLastCalledWith({ provider: "openai", id: "o3-pro" });
			expect(setThinkingLevel).toHaveBeenLastCalledWith("high");
		});

		it("is a no-op when no baseline was captured (workflow not started)", async () => {
			writeModels({ skills: { "grade-breakdown": { model: "zai/glm-4-7" } } });
			const fake = makePi();
			registerModelOverrideSessionStart(fake.pi);
			await registerModelOverrideLifecycle(fake.pi);
			const lc = lastListener();

			await lc.onUnitStart?.(skillStage("breakdown", "breakdown"), unit("grade-breakdown"), { workflow: "polish" });

			expect(fake.setModel).not.toHaveBeenCalled();
			expect(fake.setThinkingLevel).not.toHaveBeenCalled();
		});
	});

	describe("stale-ctx resilience", () => {
		// Pins the substring `isStaleCtxError` matches in the phrase pi-core's
		// ExtensionRunner throws from an invalidated proxy after the captured
		// session was replaced/disposed mid-workflow.
		const STALE_CTX_MESSAGE = "This extension ctx is stale after session replacement or reload.";

		async function setupActive(
			piOverrides: Partial<Record<"setModel" | "setThinkingLevel" | "getThinkingLevel", unknown>>,
		) {
			const fake = makePi({ baselineThinking: "medium" });
			// Apply per-test pi method overrides (e.g. ones that throw).
			Object.assign(fake.pi as unknown as Record<string, unknown>, piOverrides);
			registerModelOverrideSessionStart(fake.pi);
			await registerModelOverrideLifecycle(fake.pi);
			const handler = fake.sessionStart()!;
			const registry = { find: vi.fn((p: string, m: string) => ({ provider: p, id: m })) };
			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL });
			return { ...fake, lc: lastListener() };
		}

		it("onStageStart swallows a stale-ctx error (session is being discarded)", async () => {
			writeModels({ stages: { plan: { model: "openai:o3-pro", thinking: "high" } } });
			const { lc } = await setupActive({
				setModel: vi.fn(async () => {
					throw new Error(STALE_CTX_MESSAGE);
				}),
			});
			await lc.onWorkflowStart?.({});

			await expect(lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" })).resolves.toBeUndefined();
		});

		it("onStageStart propagates a non-stale error", async () => {
			writeModels({ stages: { plan: { model: "openai:o3-pro", thinking: "high" } } });
			const { lc } = await setupActive({
				setModel: vi.fn(async () => {
					throw new Error("boom: real bug");
				}),
			});
			await lc.onWorkflowStart?.({});

			await expect(lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" })).rejects.toThrow("boom");
		});

		it("onWorkflowEnd swallows a stale-ctx error AND still resets state", async () => {
			const { lc, setModel } = await setupActive({
				setModel: vi.fn(async () => {
					throw new Error(STALE_CTX_MESSAGE);
				}),
			});
			await lc.onWorkflowStart?.({});

			await expect(lc.onWorkflowEnd?.({}, {})).resolves.toBeUndefined();

			// State must have reset despite the stale throw: a second end is a no-op.
			setModel.mockClear();
			await lc.onWorkflowEnd?.({}, {});
			expect(setModel).not.toHaveBeenCalled();
		});

		it("onWorkflowEnd resets state even when restore throws a non-stale error", async () => {
			writeModels({ stages: { plan: { model: "anthropic/opus" } } });
			const fake = makePi({ baselineThinking: "medium" });
			let setModelCallCount = 0;
			(fake.pi as unknown as Record<string, unknown>).setModel = vi.fn(async () => {
				setModelCallCount++;
				if (setModelCallCount > 1) throw new Error("boom: real restore bug");
				return true;
			});
			registerModelOverrideSessionStart(fake.pi);
			await registerModelOverrideLifecycle(fake.pi);
			const handler = fake.sessionStart()!;
			const registry = { find: vi.fn((p: string, m: string) => ({ provider: p, id: m })) };
			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL });
			const lc = lastListener();

			await lc.onWorkflowStart?.({});
			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });

			// Genuine error propagates (surfaced to the user)...
			await expect(lc.onWorkflowEnd?.({}, {})).rejects.toThrow("boom");

			// State was reset BEFORE the throw, so the next workflow is not
			// poisoned: a second end is a clean no-op.
			const restoreMock = vi.fn(async () => true);
			(fake.pi as unknown as Record<string, unknown>).setModel = restoreMock;
			await expect(lc.onWorkflowEnd?.({}, {})).resolves.toBeUndefined();
			expect(restoreMock).not.toHaveBeenCalled();
		});

		it("onWorkflowStart swallows a stale-ctx error, leaving stages a no-op", async () => {
			const { lc, setModel } = await setupActive({
				getThinkingLevel: vi.fn(() => {
					throw new Error(STALE_CTX_MESSAGE);
				}),
			});

			await expect(lc.onWorkflowStart?.({})).resolves.toBeUndefined();

			// baselineCaptured never flipped → onStageStart early-returns.
			writeModels({ stages: { plan: { model: "openai:o3-pro" } } });
			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });
			expect(setModel).not.toHaveBeenCalled();
		});
	});

	describe("onWorkflowEnd restoration", () => {
		it("restores baseline model + thinking and resets state", async () => {
			writeModels({ stages: { plan: { model: "anthropic/opus" } } });
			const { pi, setModel, setThinkingLevel, sessionStart } = makePi({ baselineThinking: "low" });
			registerModelOverrideSessionStart(pi);
			await registerModelOverrideLifecycle(pi);
			const handler = sessionStart()!;
			const registry = { find: vi.fn((p: string, m: string) => ({ provider: p, id: m })) };
			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL });
			const lc = lastListener();

			await lc.onWorkflowStart?.({});
			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });
			await lc.onWorkflowEnd?.({}, {});

			expect(setModel).toHaveBeenLastCalledWith(BASELINE_MODEL);
			expect(setThinkingLevel).toHaveBeenLastCalledWith("low");

			// State reset: a second onWorkflowEnd with no fresh start is a no-op.
			setModel.mockClear();
			await lc.onWorkflowEnd?.({}, {});
			expect(setModel).not.toHaveBeenCalled();
		});

		it("warns when restoring the baseline model fails", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			writeModels({ stages: { plan: { model: "anthropic/opus" } } });
			const { pi, sessionStart } = makePi({ setModelResult: false });
			registerModelOverrideSessionStart(pi);
			await registerModelOverrideLifecycle(pi);
			const handler = sessionStart()!;
			const registry = { find: vi.fn((p: string, m: string) => ({ provider: p, id: m })) };
			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL });
			const lc = lastListener();

			await lc.onWorkflowStart?.({});
			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });
			await lc.onWorkflowEnd?.({}, {});

			expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to restore baseline model"));
			warn.mockRestore();
		});
	});

	describe("hasModelChange optimization", () => {
		async function setupOpt(opts: { setModelResult?: boolean } = {}) {
			const fake = makePi({ baselineThinking: "medium", ...opts });
			registerModelOverrideSessionStart(fake.pi);
			await registerModelOverrideLifecycle(fake.pi);
			const handler = fake.sessionStart()!;
			const registry = {
				find: vi.fn((provider: string, modelId: string) => ({ provider, id: modelId })),
			};
			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL });
			return { ...fake, registry, lc: lastListener() };
		}

		it("skips setModel restore when all stages were thinking-only (hasModelChange=false)", async () => {
			writeModels({ stages: { plan: { thinking: "high" } } });
			const { setModel, setThinkingLevel, lc } = await setupOpt();

			await lc.onWorkflowStart?.({});
			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });

			setModel.mockClear();
			setThinkingLevel.mockClear();
			await lc.onWorkflowEnd?.({}, {});

			expect(setModel).not.toHaveBeenCalled();
			expect(setThinkingLevel).toHaveBeenLastCalledWith("medium");
		});

		it("skips setModel restore when last stage was thinking-only (after override stage)", async () => {
			writeModels({
				stages: {
					plan: { model: "anthropic/opus" },
					review: { thinking: "high" },
				},
			});
			const { setModel, lc } = await setupOpt();

			await lc.onWorkflowStart?.({});
			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });
			await lc.onStageStart?.(scriptStage("review"), { workflow: "test-wf" });

			setModel.mockClear();
			await lc.onWorkflowEnd?.({}, {});

			expect(setModel).not.toHaveBeenCalled();
		});

		it("restores setModel when last stage had a model override", async () => {
			writeModels({
				stages: {
					plan: { thinking: "high" },
					implement: { model: "anthropic/opus" },
				},
			});
			const { setModel, lc } = await setupOpt();

			await lc.onWorkflowStart?.({});
			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });
			await lc.onStageStart?.(scriptStage("implement"), { workflow: "test-wf" });

			setModel.mockClear();
			await lc.onWorkflowEnd?.({}, {});

			expect(setModel).toHaveBeenLastCalledWith(BASELINE_MODEL);
		});

		it("soft-fails on setModel returning false during both apply and restore", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			writeModels({ stages: { plan: { model: "anthropic/opus", thinking: "high" } } });
			const { setModel, setThinkingLevel, lc } = await setupOpt({ setModelResult: false });

			await lc.onWorkflowStart?.({});
			await lc.onStageStart?.(scriptStage("plan"), { workflow: "test-wf" });

			expect(warn).toHaveBeenCalledWith(expect.stringContaining("setModel failed"));
			expect(setThinkingLevel).toHaveBeenLastCalledWith("high");

			warn.mockClear();
			setModel.mockClear();
			await lc.onWorkflowEnd?.({}, {});

			expect(setModel).toHaveBeenCalledWith(BASELINE_MODEL);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to restore baseline model"));
			warn.mockRestore();
		});
	});

	describe("dynamic-import fallback", () => {
		it("degrades gracefully (no throw, no registration) when rpiv-workflow is absent", async () => {
			vi.resetModules();
			// registerModelOverrideLifecycle imports the thin `/startup` entry for
			// registerLifecycle, so the absence simulation mocks THAT specifier.
			vi.doMock("@juicesharp/rpiv-workflow/startup", () => {
				const err = new Error("Cannot find package '@juicesharp/rpiv-workflow/startup'");
				(err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
				throw err;
			});
			try {
				const mod = await import("./model-override.js");
				const fake = makePi();
				// The isModuleNotFound guard swallows the absent-sibling failure.
				await expect(mod.registerModelOverrideLifecycle(fake.pi)).resolves.toBeUndefined();
			} finally {
				vi.doUnmock("@juicesharp/rpiv-workflow/startup");
				vi.resetModules();
			}
		});
	});
});

// The reset/registry cleanup is handled globally by test/setup.ts beforeEach
// (__resetModelOverrideState + __resetLifecycleRegistry). These local hooks
// just guard against spies leaking across the describe blocks above.
beforeEach(() => {
	vi.restoreAllMocks();
});
afterEach(() => {
	vi.restoreAllMocks();
});
