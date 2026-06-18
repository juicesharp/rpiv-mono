/**
 * session-capture — session_start capture of {modelRegistry, uiContext, model}
 * + shared model/effort apply/restore helpers.
 *
 * Captures modelRegistry, the current model, and the foreground UI context from
 * session_start's ExtensionContext (which exposes them) and stores them in
 * module scope. The detached executor (`SdkWorkflowHost`) borrows the captured
 * registry/UI to resolve per-child models at child-session creation; the
 * standalone `/skill:` bracket (skill-bracket.ts) borrows the captured model
 * plus the shared `applyEffectiveModel`/`restoreBaseline` helpers.
 *
 * Restoring the model is MANDATORY: setModel persists to the on-disk settings
 * file (runtime-traced), so an unrestored override permanently rewrites the
 * user's global default model.
 *
 * Uses pi (ExtensionAPI) from closure — not WorkflowHostContext/WorkflowHost —
 * because pi persists across session replacements and is never invalidated.
 */

import type { ExtensionAPI, ExtensionUIContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { parseModelKey } from "@juicesharp/rpiv-config";
import type { ModelThinkingLevelValue } from "./models-config.js";
import { isStaleCtxError } from "./utils.js";

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
// Module-level state — captured from session_start, used by SdkWorkflowHost
// (registry/UI) + the skill bracket (model). Reset by
// __resetSessionCaptureState() in test/setup.ts.
// ---------------------------------------------------------------------------

/**
 * Captured modelRegistry from session_start ExtensionContext. Typed as the
 * NOMINAL `ModelRegistry` (not a structural `{ find }`) so `getCapturedModelRegistry`
 * can hand it to `SdkWorkflowHostDeps.modelRegistry: ModelRegistry` — TS enforces
 * nominal compatibility for classes carrying private members, so a structural
 * shape would be rejected there. `ctx.modelRegistry` already IS one.
 */
let capturedModelRegistry: ModelRegistry | undefined;

/**
 * Captured foreground UI context from session_start. Borrowed by the
 * detached executor factory to bind foreground children to the real human and to
 * tap ESC/Ctrl-C for the run-abort signal. LifecycleContext lacks it, so it is
 * captured here alongside modelRegistry.
 */
let capturedUiContext: ExtensionUIContext | undefined;

/**
 * Current model captured from session_start ExtensionContext.model. Borrowed by
 * the standalone `/skill:` bracket as the restore baseline. Under detachment
 * every stage runs in an isolated child session, so a stage never re-fires the
 * launcher's session_start — the capture stays the real human's current model.
 */
let capturedModel: CapturedModel | undefined;

/** Test reset — wired into test/setup.ts beforeEach. */
export function __resetSessionCaptureState(): void {
	capturedModelRegistry = undefined;
	capturedUiContext = undefined;
	capturedModel = undefined;
}

// ---------------------------------------------------------------------------
// session_start hook — capture modelRegistry from ExtensionContext.
// ExtensionContext (unlike LifecycleContext) has modelRegistry.
// This hook runs on every session_start, refreshing the captured reference.
// ---------------------------------------------------------------------------

export function registerSessionCapture(pi: ExtensionAPI): void {
	pi.on(
		"session_start",
		async (
			_event: unknown,
			ctx: { modelRegistry?: ModelRegistry; model?: CapturedModel; ui?: ExtensionUIContext },
		) => {
			if (ctx.modelRegistry) {
				capturedModelRegistry = ctx.modelRegistry;
			}
			// Foreground UI for the detached executor — the real human's
			// ctx.ui, bound to foreground children and tapped for the abort signal.
			// (No authStorage / resourceLoader on ctx — absent from the SDK
			// ExtensionContext; createAgentSession defaults them per child.)
			if (ctx.ui) {
				capturedUiContext = ctx.ui;
			}
			// ExtensionContext.model is the current model — the restore baseline
			// the /skill: bracket reads. Refreshed on every session_start; under
			// detachment a stage's isolated child never re-fires the launcher's
			// session_start, so this stays the real human's current model.
			if (ctx.model !== undefined) {
				capturedModel = ctx.model;
			}
		},
	);
}

/** Captured nominal `ModelRegistry` from session_start — borrowed by the detached
 *  executor (`SdkWorkflowHost`) so every child resolves models through the same
 *  auth/OAuth-backed registry without a global `pi.setModel` flip. */
export const getCapturedModelRegistry = (): ModelRegistry | undefined => capturedModelRegistry;

/** Captured foreground UI context from session_start — read by the executor
 *  factory to bind foreground children + tap ESC/Ctrl-C for the abort signal. */
export const getCapturedUiContext = (): ExtensionUIContext | undefined => capturedUiContext;

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
// Stale-ctx guard — shared by the skill bracket's apply/restore calls.
// ---------------------------------------------------------------------------

/**
 * Run pi model/thinking mutations, swallowing ONLY the stale-ctx error pi-core
 * throws when the captured session was replaced/disposed mid-run (e.g.
 * auto-compaction disposing the runner while a stage is in flight). Once the
 * session is gone the override is moot — the replacement session_start rebuilds
 * state — so there is nothing to apply. Any OTHER error (bad model key,
 * setModel rejected, real plumbing bug) is genuine and must propagate so the
 * skill bracket surfaces it to the user.
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
	 * to enforce the no-bleedthrough invariant (unconfigured stages revert to baseline,
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

	// When no override model resolved: either re-apply baseline (workflow:
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

/** Return the captured baseline model from session_start, used by the standalone-skill bracket. */
export function getCapturedModel(): CapturedModel | undefined {
	return capturedModel;
}
