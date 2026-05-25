/**
 * Test-only / framework-internal surface.
 *
 * Exports below are NOT part of the package's authoring or embedding
 * contract. They exist solely for:
 *
 *   - rpiv-pi's `[I3]` regression test that exercises `recordStage`
 *     directly (asserting the JSONL append + stageNumber monotonicity).
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
 */

export { recordStage } from "./audit.js";
export { __resetBuiltIns, getBuiltIns } from "./built-ins.js";
export { __resetLoadCache } from "./load/cache.js";
