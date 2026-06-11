/**
 * Public authoring surface for rpiv workflows — a BARREL since the M9 split.
 * Users import everything they need (`defineWorkflow`, `produces`, `acts`,
 * `defineRoute`, `gate`, `STOP`, `marksReadsData`, schema adapters, plus the
 * type vocabulary `Workflow` / `StageDef` / `EdgeFn` / `EdgeTarget` /
 * `EdgeContext`) from `@juicesharp/rpiv-workflow`.
 *
 * A `Workflow` is a typed graph: a named entry point, a stage table, and an
 * edge table that maps each stage to either another stage name, the sentinel
 * `STOP`, or an `EdgeFn` that picks at runtime. Edges live INSIDE each
 * workflow.
 *
 * Module map (each concept has ONE home; this file re-exports, never
 * declares):
 *   ./stage-def.ts   — StageDef union + arms, Workflow, StageSchema,
 *                      script/prompt primitives, the produces/acts/terminal
 *                      factories
 *   ./loop-def.ts    — the loop vocabulary (LoopDef kinds, JudgedRepetition,
 *                      VerifySpec, Unit, contexts, LOOP_KINDS); constructors
 *                      stay in control-flow.ts
 *   ./routing-dsl.ts — EdgeFn/EdgeTarget/STOP, defineRoute, gate, the
 *                      READS_DATA / ROUTE_NOTE markers
 */

export * from "./loop-def.js";
export type { Outcome } from "./output-spec.js";
export * from "./routing-dsl.js";
export * from "./stage-def.js";
