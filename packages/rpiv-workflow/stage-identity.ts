/**
 * Stage-identity derivations — the pure projections off a `StageDef` that the
 * runtime and the load-time validators must agree on (effective skill, publish
 * name, dispatch-vs-body classification, effective output schema).
 *
 * A LEAF on internal edges: it imports only TYPES from `./api.js` and
 * `./skill-contract.js`, plus VALUE helpers from `./json-schema.js` (which is
 * itself a leaf — `@standard-schema/spec` + `typebox` only, no internal `./`
 * imports — so this value edge introduces no cycle). That lets the
 * definition/compile-time context (`load/`, `validate/`, `skill-contracts/harvest`)
 * consume these without importing `chain-state.ts` — a RUNTIME-STATE module
 * (it imports `RunState` and houses `applyCompletedStage(state, …)` mutators).
 * Co-locating these projections there forced a structural edge from the loader +
 * validators into the execution context, enforced by nothing but convention.
 * `chain-state.ts` re-exports them so its own runtime callers keep one import.
 */

import type { SkillStage, StageDef, StageSchema } from "./api.js";
import { isJsonSchemaObject, jsonSchemaToStandard } from "./json-schema.js";
import type { SkillContractMap } from "./skill-contract.js";

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
 * The `state.named` key a SIDE-EFFECT stage publishes its `Output` onto, or
 * `undefined` for the silent majority. Acts stages publish ONLY under an
 * EXPLICIT outcome name — never the record-key fallback produces stages get:
 * defaulting would make every `implement`/`commit`-shaped stage suddenly
 * publish a channel, widening `reads:` semantics for existing graphs. The
 * `Outcome.name` doc has always promised the named slot for "any stage wired
 * with this outcome"; the runtime write honoring it only for `produces` left
 * an acts outcome's channel silently unwritten (a gate folding
 * `state.named.remediation` read a channel that never existed). Twin of
 * `resolvePublishName` — the runtime write (`applyCompletedStage`) and the
 * load-time publish scan (`publishedNamesOf`) both key off this projection.
 */
export function actsPublishName(def: StageDef): string | undefined {
	return def.kind !== "produces" ? def.outcome?.name : undefined;
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
 * Resolve the schema a produces stage's output is validated against: the
 * stage's own `outputSchema` if it declares one (precedence — NOT `??`), else
 * the dispatched skill's contract `produces.data` (sourced from the
 * registered-contract registry threaded onto the session / run).
 *
 * The SINGLE runtime spelling of this predicate. Both RUNTIME call sites
 * consume it — `sessions/extraction.ts` (`shouldValidateOutput` +
 * `retryUntilValid`) and `runner/run-stage.ts` (`gateValidationRedispatch`) — so
 * the two can no longer drift on the precedence order, the contract key, or the
 * fail-soft guard. (The load-time twin in
 * `validate/contract-compat.ts:checkPredicateSchemas` is a separate, stricter
 * `isDispatchingStage`-guarded policy and stays distinct by design.)
 *
 * `resolveSkill(def, stageName)` is the SAME registry key
 * `validate-workflow.ts` and `harvestStageContracts` key the map by — and the
 * same key the prior private twin derived indirectly through `s.skill`
 * (= `resolveSkill` applied once in `resolveStage`).
 *
 * Degrades exactly like the input-side runtime mirror: a non-object /
 * unparseable `produces.data` is treated as absent (no schema), never thrown.
 * Returns `undefined` when neither source supplies a schema.
 */
export function effectiveOutputSchemaOf(
	def: StageDef,
	stageName: string,
	skillContracts: SkillContractMap | undefined,
): StageSchema | undefined {
	if (def.outputSchema) return def.outputSchema;
	const producesData = skillContracts?.get(resolveSkill(def, stageName))?.produces?.data;
	if (!isJsonSchemaObject(producesData)) return undefined;
	return jsonSchemaToStandard(producesData);
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
