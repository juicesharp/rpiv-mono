/**
 * Test-only / framework-internal surface.
 *
 * Exports below are NOT part of the package's authoring or embedding
 * contract. They exist solely for:
 *
 *   - rpiv-pi's regression test that exercises `recordStage` directly
 *     (asserting the JSONL append + stageNumber monotonicity).
 *   - `test/setup.ts`'s per-worker `beforeEach` reset of module-level
 *     singleton state (the built-in workflow registry, the jiti import
 *     cache).
 *
 * Anything that consumers can rely on for production work lives on
 * `./index.js`. This file is reachable as
 * `@juicesharp/rpiv-workflow/internal` via the package's `exports`
 * field — keep that path stable so the rpiv-pi test + repo-wide
 * setup don't break.
 *
 * Adding a new export here is a signal you have test-coupling to
 * production state. Reach for it sparingly; prefer making the
 * production module itself idempotent across `beforeEach` resets.
 *
 * KNOWN DEBT (deliberately deferred): most of these exist because the
 * built-in/contract registries are process-global singletons (a deliberate
 * choice — siblings register across package-instance boundaries via
 * `Symbol.for` slots). Making them instantiable and threading an instance
 * through `loadWorkflows` would let tests construct fresh registries and
 * shrink this file toward zero; it's an API-design change that must be
 * coordinated with rpiv-pi's internal-subpath regression test, so it ships
 * in a follow-up minor, not the pre-release window.
 */

export { recordStage } from "./audit.js";
export { __resetBuiltIns, flushBuiltInProviders, getBuiltIns } from "./built-ins.js";
export { __resetLifecycleRegistry } from "./events.js";
export { __resetWorkflowExecutionHost } from "./execution-host.js";
export { __resetLoadCache } from "./load/cache.js";
export {
	__resetSkillContracts,
	buildEffectiveContracts,
	drainSkillContractCollisions,
	drainSkillContractProviderErrors,
	flushSkillContractProviders,
	getBucketKindMappings,
	getCompositionComparators,
	getSkillContracts,
	harvestStageContracts,
	registerBucketKindMapping,
} from "./skill-contracts/index.js";
// Layout-coupled path helpers — test fixtures that WRITE synthetic run files
// need them; production consumers use the opaque `runFileFor` instead.
export { runsDir, stateFilePath } from "./state/index.js";
// Type-only: lets external test fixtures construct the full mutable run state
// for direct `recordStage` calls. Production consumers read `RunView` instead.
export type { RunState } from "./types.js";
