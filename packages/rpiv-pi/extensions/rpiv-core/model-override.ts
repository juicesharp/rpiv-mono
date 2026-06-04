/**
 * model-override — Stage-level model/effort override via rpiv-workflow lifecycle.
 *
 * Registers a lifecycle listener that resolves per-stage model/effort overrides
 * from models.json and applies setModel/setThinkingLevel before each stage.
 * Baseline { model, thinking } is snapshotted at onWorkflowStart and restored
 * at onWorkflowEnd. Restoring the model is MANDATORY: setModel persists to the
 * on-disk settings file (runtime-traced), so an unrestored override permanently
 * rewrites the user's global default model.
 *
 * Uses pi (ExtensionAPI) from closure — not WorkflowHostContext/WorkflowHost —
 * because pi persists across session replacements and is never invalidated.
 *
 * Both modelRegistry AND the current model are captured from session_start's
 * ExtensionContext (which exposes them) and stored in module scope, because
 * LifecycleContext (received by lifecycle listeners) exposes neither.
 *
 * Dynamic import of rpiv-workflow with isModuleNotFound guard — graceful
 * degradation when the sibling is not installed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseModelKey } from "@juicesharp/rpiv-config";
import { loadModelsConfig, type ModelThinkingLevelValue, resolveStageModel } from "./models-config.js";
import { isModuleNotFound, isStaleCtxError } from "./utils.js";

/** First parameter type of pi.setModel() — avoids importing Pi's Model<Api> generic. */
export type CapturedModel = Parameters<ExtensionAPI["setModel"]>[0];

// ---------------------------------------------------------------------------
// Shared types — used by both the workflow path and the skill-bracket path.
// ---------------------------------------------------------------------------

/**
 * Baseline snapshot captured at the start of an override scope (workflow or
 * skill bracket). Restored at scope end. `hasModelChange` tracks whether a
 * non-baseline override model was resolved and setModel was called — when
 * false, `restoreBaseline` skips the `setModel` call (avoiding an unnecessary
 * disk write for thinking-only overrides). `setModel` persists to the on-disk
 * settings file, so restoring is MANDATORY when a model change was applied.
 */
export interface BaselineSnapshot {
	thinking: ModelThinkingLevelValue;
	model: CapturedModel | undefined;
	hasModelChange: boolean;
}

// ---------------------------------------------------------------------------
// Module-level state — captured from session_start, used by lifecycle listeners.
// Reset by __resetModelOverrideState() in test/setup.ts.
// ---------------------------------------------------------------------------

/** Captured modelRegistry from session_start ExtensionContext. */
let capturedModelRegistry: { find(provider: string, modelId: string): unknown } | undefined;

/**
 * Current model captured from session_start ExtensionContext.model. Refreshed
 * only while NO workflow is active (!baselineCaptured) so a stage's own
 * newSession (which may re-fire session_start with the override model) can't
 * pollute the baseline we restore at workflow end.
 */
let capturedModel: CapturedModel | undefined;

/**
 * Baseline snapshot — set at workflow start, restored at workflow end.
 * Captures BOTH thinking and model: setModel persists to the on-disk settings
 * file (runtime-confirmed), so failing to restore the model permanently
 * rewrites the user's global default.
 */
let baseline: BaselineSnapshot | undefined;
let baselineCaptured = false;

/** Test reset — wired into test/setup.ts beforeEach. */
export function __resetModelOverrideState(): void {
	capturedModelRegistry = undefined;
	capturedModel = undefined;
	baseline = undefined;
	baselineCaptured = false;
}

// ---------------------------------------------------------------------------
// session_start hook — capture modelRegistry from ExtensionContext.
// ExtensionContext (unlike LifecycleContext) has modelRegistry.
// This hook runs on every session_start, refreshing the captured reference.
// ---------------------------------------------------------------------------

export function registerModelOverrideSessionStart(pi: ExtensionAPI): void {
	pi.on(
		"session_start",
		async (_event: unknown, ctx: { modelRegistry?: typeof capturedModelRegistry; model?: CapturedModel }) => {
			if (ctx.modelRegistry) {
				capturedModelRegistry = ctx.modelRegistry;
			}
			// ExtensionContext.model is the current model (LifecycleContext lacks it).
			// Only capture while no workflow is active — a stage's newSession can
			// re-fire session_start with the override model, which must NOT become
			// the restore baseline.
			if (!baselineCaptured && ctx.model !== undefined) {
				capturedModel = ctx.model;
			}
		},
	);
}

// ---------------------------------------------------------------------------
// Model resolution — uses captured modelRegistry, not lifecycle context.
// ---------------------------------------------------------------------------

/** Resolve model string to Model object via captured modelRegistry. */
export function resolveModel(modelStr?: string): CapturedModel | undefined {
	if (!modelStr || !capturedModelRegistry) return undefined;
	const parsed = parseModelKey(modelStr);
	if (!parsed) return undefined;
	return capturedModelRegistry.find(parsed.provider, parsed.modelId) as CapturedModel | undefined;
}

// ---------------------------------------------------------------------------
// Lifecycle registration — registers onWorkflowStart/onStageStart/onWorkflowEnd.
// Dynamic import of rpiv-workflow with isModuleNotFound guard.
// ---------------------------------------------------------------------------

/**
 * Run pi model/thinking mutations, swallowing ONLY the stale-ctx error pi-core
 * throws when the captured session was replaced/disposed mid-run (e.g.
 * auto-compaction disposing the runner while a stage is in flight). Once the
 * session is gone the override is moot — the replacement session_start rebuilds
 * state — so there is nothing to apply. Any OTHER error (bad model key,
 * setModel rejected, real plumbing bug) is genuine and must propagate so the
 * lifecycle dispatcher surfaces it to the user.
 */
export async function applyOrSkipIfStale(fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (e) {
		if (!isStaleCtxError(e)) throw e;
	}
}

// ---------------------------------------------------------------------------
// Shared apply/restore helpers — consumed by both override paths.
// ---------------------------------------------------------------------------

interface ApplyEffectiveModelOpts {
	/** Canonical "provider/modelId" string from config override. Resolved internally via registry. */
	overrideModel: string | undefined;
	/** Already-resolved baseline Model object from session_start capture. */
	baselineModel: CapturedModel | undefined;
	/** Override thinking level from config. `undefined` = no override, use baseline. */
	overrideThinking: ModelThinkingLevelValue | undefined;
	/** Baseline thinking level captured at scope start. */
	baselineThinking: ModelThinkingLevelValue;
	/** Human-readable label for warning messages (e.g. `stage "plan"` or `/skill:commit`). */
	label: string;
	/**
	 * When true (workflow path): on override-miss, re-apply baseline model via setModel
	 * to enforce the D7 no-bleedthrough invariant (unconfigured stages revert to baseline,
	 * not the previous stage's override). When false (bracket path): on override-miss,
	 * skip setModel entirely (one-shot arm, nothing to undo).
	 */
	setBaselineModel: boolean;
}

/**
 * Apply an effective model + thinking override. Resolves the override model
 * string via the captured registry, composes against the baseline, and applies
 * via `pi.setModel` + `pi.setThinkingLevel`.
 *
 * Returns `{ hasModelChange: boolean }` — true when a non-baseline override
 * model was resolved in the registry and `setModel` was called (regardless of
 * `setModel`'s boolean return — even on soft-fail, the caller should track
 * that an override was attempted so the restore path mirrors the apply).
 * Baseline-fallback applies (when `setBaselineModel=true`) do NOT set
 * `hasModelChange=true`.
 *
 * Soft-fails (warns, proceeds) when:
 *   - override model string fails registry resolution → uses baseline
 *   - `setModel` returns false (e.g. missing API key) → proceeds on current
 */
export async function applyEffectiveModel(
	pi: ExtensionAPI,
	opts: ApplyEffectiveModelOpts,
): Promise<{ hasModelChange: boolean }> {
	let hasModelChange = false;

	if (opts.overrideModel !== undefined) {
		const resolved = resolveModel(opts.overrideModel);
		if (resolved) {
			const ok = await pi.setModel(resolved);
			if (!ok) {
				console.warn(`[rpiv-pi] setModel failed for ${opts.label} (no API key?) — proceeding on current model`);
			}
			hasModelChange = true;
		} else {
			console.warn(`[rpiv-pi] model not found: ${opts.overrideModel} (${opts.label}) — using baseline model`);
		}
	}

	// When no override model resolved: either re-apply baseline (workflow: D7
	// no-bleedthrough) or skip setModel entirely (bracket: one-shot arm).
	if (!hasModelChange && opts.setBaselineModel && opts.baselineModel !== undefined) {
		const ok = await pi.setModel(opts.baselineModel);
		if (!ok) {
			console.warn(`[rpiv-pi] setModel failed for ${opts.label} (no API key?) — proceeding on current model`);
		}
	}

	pi.setThinkingLevel(opts.overrideThinking ?? opts.baselineThinking);

	return { hasModelChange };
}

/**
 * Restore the baseline model + thinking at the end of an override scope.
 * Skips `setModel` when `base.hasModelChange === false` — pi.setModel persists
 * to the on-disk settings file even when called with the same value, so the
 * skip avoids an unnecessary disk write for thinking-only overrides.
 * Always restores thinking level.
 * Soft-fails (warns, proceeds) when `setModel` returns false.
 */
export async function restoreBaseline(pi: ExtensionAPI, base: BaselineSnapshot): Promise<void> {
	if (base.hasModelChange && base.model !== undefined) {
		const ok = await pi.setModel(base.model);
		if (!ok) {
			console.warn("[rpiv-pi] failed to restore baseline model — proceeding on current model");
		}
	}
	pi.setThinkingLevel(base.thinking);
}

/**
 * Register the stage model override lifecycle listener with rpiv-workflow.
 * Call from index.ts with pi — NOT from registerBuiltInWorkflows.
 */
export async function registerModelOverrideLifecycle(pi: ExtensionAPI): Promise<void> {
	try {
		// Thin `/startup` entry (~8ms) — keeps the loader/DSL/runner off startup.
		const { registerLifecycle } = await import("@juicesharp/rpiv-workflow/startup");

		registerLifecycle({
			onWorkflowStart: async () => {
				// Snapshot baseline thinking + model. LifecycleContext lacks
				// ctx.model, so model comes from capturedModel (set by the
				// session_start handler while no workflow was active).
				// getThinkingLevel reads the captured pi, which can be stale if the
				// session was already replaced — bail quietly if so, leaving
				// baselineCaptured false so later stages early-return.
				await applyOrSkipIfStale(() => {
					baseline = {
						thinking: pi.getThinkingLevel() as ModelThinkingLevelValue,
						model: capturedModel,
						hasModelChange: false,
					};
					baselineCaptured = true; // freezes capturedModel until onWorkflowEnd
				});
			},

			onStageStart: async (stage: { name: string; skill?: string }, ctx: { workflow: string }) => {
				// Parameter shape mirrors rpiv-workflow's lifecycle:
				//   - StageRef ("skill"|"script" arm) carries `name` (workflow graph key)
				//     and (on the "skill" arm) `skill` (post-alias target, see
				//     `load/alias.ts:44-46`).
				//   - LifecycleContext carries `workflow` (the active workflow's name,
				//     fed in by `defineWorkflow({ name })` or built-in registration).
				// `stage.skill` is `undefined` for script stages — `resolveStageModel`
				// handles that by skipping the skills cascade rung.
				if (!baselineCaptured || !baseline) return;

				const config = loadModelsConfig();
				const override = resolveStageModel(config, {
					workflow: ctx.workflow,
					stage: stage.name,
					skill: stage.skill,
				});

				// Apply effective model + thinking via the shared helper.
				// setBaselineModel=true enforces the D7 no-bleedthrough invariant:
				// unconfigured stages revert to baseline, not the previous stage's override.
				await applyOrSkipIfStale(async () => {
					const { hasModelChange } = await applyEffectiveModel(pi, {
						overrideModel: override?.model,
						baselineModel: baseline!.model,
						overrideThinking: override?.thinking,
						baselineThinking: baseline!.thinking,
						label: `stage "${stage.name}"`,
						setBaselineModel: true,
					});
					baseline!.hasModelChange = hasModelChange;
				});
			},

			onWorkflowEnd: async () => {
				if (!baselineCaptured || !baseline) return;
				const base = baseline;
				// Reset state BEFORE attempting restore so a GENUINE (non-stale)
				// throw from restoreBaseline can't leave baselineCaptured=true and
				// poison every future workflow (each onStageStart would think a
				// workflow is active; the skill-bracket would defer forever). The
				// stale-ctx case is swallowed by applyOrSkipIfStale either way.
				// Mirrors skill-bracket.ts agent_end's clear-before-restore.
				baseline = undefined;
				baselineCaptured = false;

				// Restore baseline model + thinking. restoreBaseline skips setModel
				// when hasModelChange=false (thinking-only overrides), avoiding an
				// unnecessary disk write. setModel persists to disk, so restoring is
				// MANDATORY when a model change was applied. If the session was
				// replaced mid-run pi is stale and this throws — swallow it.
				await applyOrSkipIfStale(() => restoreBaseline(pi, base));
			},
		});
	} catch (err) {
		if (isModuleNotFound(err)) return; // sibling absent — /rpiv-setup guides the user
		throw err;
	}
}

/** Return the captured baseline model from session_start, used by the standalone-skill bracket. */
export function getCapturedModel(): CapturedModel | undefined {
	return capturedModel;
}

/**
 * Return true if a workflow has armed its baseline. The skill-bracket reads
 * this to defer when the workflow path owns restore (Decision 5).
 */
export function isWorkflowBaselineCaptured(): boolean {
	return baselineCaptured;
}
