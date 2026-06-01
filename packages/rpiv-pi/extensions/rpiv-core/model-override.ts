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
 * Uses pi (ExtensionAPI) from closure — not WorkflowContext/WorkflowHost —
 * because pi persists across session replacements and is never invalidated.
 *
 * Both modelRegistry AND the current model are captured from session_start's
 * ExtensionContext (which exposes them) and stored in module scope, because
 * LifecycleContext (received by lifecycle listeners) exposes neither.
 *
 * Dynamic import of rpiv-workflow with isModuleNotFound guard — graceful
 * degradation when the sibling is not installed.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseModelKey } from "@juicesharp/rpiv-config";
import { getStageModelConfig, loadModelsConfig } from "./models-config.js";
import { isModuleNotFound } from "./utils.js";

/** First parameter type of pi.setModel() — avoids importing Pi's Model<Api> generic. */
type CapturedModel = Parameters<ExtensionAPI["setModel"]>[0];

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
let baseline: { thinking: string; model: CapturedModel | undefined } | undefined;
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
function resolveModel(modelStr?: string): CapturedModel | undefined {
	if (!modelStr || !capturedModelRegistry) return undefined;
	const parsed = parseModelKey(modelStr);
	if (!parsed) return undefined;
	return capturedModelRegistry.find(parsed.provider, parsed.modelId) as CapturedModel | undefined;
}

/**
 * Re-assert the captured baseline (model + thinking). Used at workflow end to
 * restore the user's on-disk default. baseline.model is already a Model object
 * captured from session_start — no registry resolution needed. Soft-fails on
 * setModel returning false. (Unconfigured stages compose against the baseline
 * inline in onStageStart rather than calling this.)
 */
async function applyBaseline(
	pi: ExtensionAPI,
	base: { thinking: string; model: CapturedModel | undefined },
): Promise<void> {
	if (base.model !== undefined) {
		const ok = await pi.setModel(base.model);
		if (!ok) {
			console.warn("[rpiv-pi] failed to restore baseline model — proceeding on current model");
		}
	}
	pi.setThinkingLevel(base.thinking as ThinkingLevel);
}

// ---------------------------------------------------------------------------
// Lifecycle registration — registers onWorkflowStart/onStageStart/onWorkflowEnd.
// Dynamic import of rpiv-workflow with isModuleNotFound guard.
// ---------------------------------------------------------------------------

/**
 * pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
 * proxy after session replacement/reload. Match the stable substring.
 */
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

/**
 * Run pi model/thinking mutations, swallowing ONLY the stale-ctx error pi-core
 * throws when the captured session was replaced/disposed mid-run (e.g.
 * auto-compaction disposing the runner while a stage is in flight). Once the
 * session is gone the override is moot — the replacement session_start rebuilds
 * state — so there is nothing to apply. Any OTHER error (bad model key,
 * setModel rejected, real plumbing bug) is genuine and must propagate so the
 * lifecycle dispatcher surfaces it to the user.
 */
async function applyOrSkipIfStale(fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (e) {
		if (!isStaleCtxError(e)) throw e;
	}
}

/**
 * Register the stage model override lifecycle listener with rpiv-workflow.
 * Call from index.ts with pi — NOT from registerBuiltInWorkflows.
 */
export async function registerModelOverrideLifecycle(pi: ExtensionAPI): Promise<void> {
	try {
		const { registerLifecycle } = await import("@juicesharp/rpiv-workflow");

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
						thinking: pi.getThinkingLevel(),
						model: capturedModel,
					};
					baselineCaptured = true; // freezes capturedModel until onWorkflowEnd
				});
			},

			onStageStart: async (stage: { name: string }, _ctx: unknown) => {
				// NOTE: parameter order is (stage: StageRef, ctx: LifecycleContext)
				// stage.name is the workflow graph key ("research", "plan", etc.)
				if (!baselineCaptured || !baseline) return;

				const config = loadModelsConfig();
				const override = getStageModelConfig(config, stage.name);

				// Compose the EFFECTIVE config per-field against the baseline so a
				// field the override doesn't set falls back to the captured
				// baseline — NEVER to whatever the previous stage left active.
				// This is what makes D7's "no bleedthrough" hold even for a
				// thinking-only override with no `defaults` model.
				//   - override.model is a "provider:modelId" string → resolve via registry
				//   - baseline.model is an already-resolved Model object
				let effectiveModel = baseline.model;
				const baselineThinking = baseline.thinking;
				if (override?.model !== undefined) {
					const resolved = resolveModel(override.model);
					if (resolved) {
						effectiveModel = resolved;
					} else {
						console.warn(
							`[rpiv-pi] model not found: ${override.model} (stage "${stage.name}") — using baseline model`,
						);
					}
				}
				// Apply to the captured pi. If the session was replaced/disposed
				// mid-workflow (e.g. auto-compaction), pi is a dead proxy and these
				// throw the stale-ctx error — swallow it: the override is moot for a
				// discarded session, and surfacing it as a lifecycle warning is pure
				// noise the user can't act on.
				await applyOrSkipIfStale(async () => {
					if (effectiveModel !== undefined) {
						const ok = await pi.setModel(effectiveModel);
						if (!ok) {
							console.warn(
								`[rpiv-pi] setModel failed for stage "${stage.name}" (no API key?) — proceeding on current model`,
							);
						}
					}

					pi.setThinkingLevel((override?.thinking ?? baselineThinking) as ThinkingLevel);
				});
			},

			onWorkflowEnd: async () => {
				if (!baselineCaptured || !baseline) return;

				// Restore baseline model + thinking. setModel persists to disk,
				// so this is what keeps the user's global default intact. If the
				// session was replaced mid-run pi is stale and this throws — swallow
				// it: a discarded session has nothing to restore, and the replacement
				// session_start already rebuilt from the on-disk default. State MUST
				// still reset regardless, so a future workflow starts clean.
				await applyOrSkipIfStale(() => applyBaseline(pi, baseline!));

				// Reset state for next workflow
				baseline = undefined;
				baselineCaptured = false;
			},
		});
	} catch (err) {
		if (isModuleNotFound(err)) return; // sibling absent — /rpiv-setup guides the user
		throw err;
	}
}
