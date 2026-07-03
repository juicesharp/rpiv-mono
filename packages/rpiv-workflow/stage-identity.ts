/**
 * Stage-identity derivations — the pure projections off a `StageDef` that the
 * runtime and the load-time validators must agree on (effective skill, publish
 * name, dispatch-vs-body classification).
 *
 * A dependency-free LEAF (imports only `StageDef`/`SkillStage` TYPES): so the
 * definition/compile-time context (`load/`, `validate/`, `skill-contracts/harvest`)
 * can consume these without importing `chain-state.ts` — a RUNTIME-STATE module
 * (it imports `RunState` and houses `applyCompletedStage(state, …)` mutators).
 * Co-locating these projections there forced a structural edge from the loader +
 * validators into the execution context, enforced by nothing but convention.
 * `chain-state.ts` re-exports them so its own runtime callers keep one import.
 */

import type { SkillStage, StageDef } from "./api.js";

/**
 * Resolve the `state.named` key a produces stage appends its `Output`
 * envelope onto. Two layers of fallback, in priority order:
 *   1. `stage.outcome?.name` — categorical name carried by the outcome.
 *   2. The stage's record key — always defined.
 *
 * Single source of truth for the key derivation so the skill-stage path
 * and the script-stage path stay in lockstep, and so `validateWorkflow`
 * can compute the same key set at load time.
 */
export function resolvePublishName(def: StageDef, stageName: string): string {
	return def.outcome?.name ?? stageName;
}

/**
 * Resolve a stage's effective skill — the contract-registry key. Twin of
 * `resolvePublishName`. Single source of truth so the runtime resolution
 * (`resolveStage`) and the load-time lookups (`validate-workflow.ts`) key the
 * registry identically and can't drift.
 */
export function resolveSkill(def: StageDef, stageName: string): string {
	return def.skill ?? stageName;
}

/**
 * A stage dispatches a `/skill:<name>` exactly when it carries neither a `run`
 * (script body) nor a `prompt` (raw-text body). `fanout`/`iterate` stages carry
 * neither, so they ARE dispatching stages. The shared predicate for every site
 * that treats `resolveSkill`'s result as a REAL skill identity — the alias
 * remap + its no-op warning, contract harvest, and the validator's contract
 * lookups must all agree, or a script/prompt stage whose record key matches a
 * registered skill inherits that skill's contract by accident.
 *
 * A TYPE GUARD since the StageDef union: a positive narrows to
 * `SkillStage`, so callers that wire skill-derived data onto the stage
 * (the alias remap, outcome derivers) get the writable arm.
 */
export function isDispatchingStage(stage: StageDef): stage is SkillStage {
	return stage.run == null && stage.prompt == null;
}
