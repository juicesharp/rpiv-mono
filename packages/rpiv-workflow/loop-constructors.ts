/**
 * Loop constructors + introspection — split into the `loops/` modules behind
 * this preserving re-export barrel. The monolith that lived here was
 * decomposed into five disjoint facets:
 *   - `loops/constructors.ts`  — `fanout()` / `iterate()` / `assess()` + the
 *     `LOOP_DEFAULTS` / `VERIFY_LOOP_DEFAULTS` identity tables they consult;
 *   - `loops/verify.ts`        — `verify()` + the `synthesizeVerifyLoop` desugar;
 *   - `loops/panel.ts`         — `panel()` + the canonical fold vocabulary;
 *   - `loops/introspection.ts` — `describeFlow()` + the `loopSpecOf` projections;
 *   - `loops/derivations.ts`   — `effectiveLoopOf` / `freezesEntryArgsOf` /
 *     `judgeSlotOf` / `forEachJudgeChannel` (the per-stage consults).
 *
 * This file keeps the original import path (`./loop-constructors.js`) so the
 * existing consumers (9 production + 8 test importers, plus `registration.ts`)
 * resolve unchanged — a pure re-export surface, no logic. Skill-agnostic and
 * runner-free — safe on `registration`.
 */

export type { UnitSelector } from "./api.js";
export * from "./loops/constructors.js";
export * from "./loops/derivations.js";
export * from "./loops/introspection.js";
export * from "./loops/panel.js";
export * from "./loops/verify.js";
