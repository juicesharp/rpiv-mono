/**
 * rpiv-workflow — Pi extension entry point.
 *
 * Registers the `/wf` slash command and (optionally) exposes the workflow
 * runtime as a programmatic API for sibling packages that want to
 * contribute built-in workflows via `registerBuiltIns(...)`.
 *
 * Skill-agnostic: the runner sends `/skill:<name>` via Pi's native skill
 * dispatch — workflows can name any skill installed in Pi's search path
 * (`~/.pi/agent/skills/`, `<cwd>/.pi/skills/`, or settings-declared
 * `skillPaths[]`). This package ships ZERO built-in workflows. Bundles
 * like `@juicesharp/rpiv-pi` opt in by calling `registerBuiltIns(...)`
 * from their own extension entry.
 *
 * ─── Public surface, grouped by audience ────────────────────────────────
 *
 *   1. Authoring DSL — `./api.js`, `./typebox-adapter.js`
 *      What a `workflows.config.ts` author imports to declare a workflow:
 *      `defineWorkflow`, `artifact`, `action`, `threshold`, `Workflow`,
 *      `NodeDef`, `EdgeFn`, `EdgeTarget`, `EdgeContext`, `NodeSchema`,
 *      `CompletionStrategy`, `SessionPolicy`, `definePredicate`,
 *      `defineStatePredicate`, `READS_FRONTMATTER`, the runtime-mirror
 *      `*_VALUES` arrays, and `typeboxSchema` (the TypeBox adapter).
 *
 *   2. Runner (programmatic embedders) — `./runner/index.js`
 *      Drive a workflow from outside `/wf`: `runWorkflow`,
 *      `RunWorkflowOptions`, `RunWorkflowResult`.
 *
 *   3. Loader (programmatic embedders) — `./load/index.js`
 *      Materialise the merged workflow registry: `loadWorkflows`,
 *      `LoadedWorkflows`, `Issue`, `LoadIssue`, `ConfigLayer`,
 *      `OverlayPaths`, `projectOverlayPaths`, `userOverlayPaths`.
 *
 *   4. Built-in registry (sibling packages) — `./built-ins.js`
 *      Contribute workflows to the lowest config layer:
 *      `registerBuiltIns`, `getBuiltIns`.
 *
 *   5. Manifest envelope + bundled outcomes — `./manifest.js`,
 *      `./outcomes/index.js`
 *      Inter-stage data channel (`Manifest<K, D>`, `ManifestMeta`) +
 *      bundled outcomes (`artifactMdOutcome`, `sideEffectOutcome`,
 *      `gitCommitOutcome`, `GitCommitData`, `gitHeadSnapshot`,
 *      `GitHeadSnapshot`).
 *
 *   6. Custom-outcome authoring surface — `./manifest.js`
 *      `Outcome<Baseline, Kind, Data>`, `ExtractCtx`, `ExtractPayload`,
 *      `ExtractResult`, `ExtractFn`, `BaselineCtx`, `BaselineFn`.
 *
 *   7. Validation surfaces — `./validate-workflow.js`,
 *      `./validate-manifest.js`
 *      `validateWorkflow`, `WorkflowValidationIssue`,
 *      `validateManifestData`, `SchemaValidationFailure`.
 *
 *   8. Persistence (low-level — JSONL inspect) — `./state/index.js`
 *      Read past runs at `<cwd>/.rpiv/workflows/<run-id>.jsonl`:
 *      `listRuns`, `readHeader`, `readLastStage`, `listArtifacts`,
 *      `resolveStateFile`, `resolveWorkflowsDir`, `RunSummary`,
 *      `WorkflowHeader`, `WorkflowStage`. `recordStage` (from
 *      `./audit.js`) is exposed only for rpiv-pi's `[I3]` regression
 *      test; runner owns row writes — embedders never need it.
 *
 *   9. Runtime types — `./types.js`
 *      `RunContext`, `RunState`.
 *
 * Per-module deep imports (`from "@juicesharp/rpiv-workflow/api.js"`)
 * are NOT supported across the package boundary.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowCommand } from "./command.js";

export {
	action,
	artifact,
	COMPLETION_STRATEGIES,
	type CompletionStrategy,
	definePredicate,
	defineStatePredicate,
	defineWorkflow,
	type EdgeContext,
	type EdgeFn,
	type EdgeTarget,
	type FanoutContext,
	type FanoutFn,
	type FanoutUnit,
	type NodeDef,
	type NodeSchema,
	ON_VALIDATION_FAILURE_VALUES,
	type OnValidationFailure,
	READS_FRONTMATTER,
	SESSION_POLICIES,
	type SessionPolicy,
	threshold,
	type Workflow,
} from "./api.js";
export { recordStage } from "./audit.js";
export { getBuiltIns, registerBuiltIns } from "./built-ins.js";
export type { ConfigLayer, Issue, LoadedWorkflows, LoadIssue, OverlayPaths } from "./load/index.js";
export { loadWorkflows, projectOverlayPaths, userOverlayPaths } from "./load/index.js";
export type {
	BaselineCtx,
	BaselineFn,
	ExtractCtx,
	ExtractFn,
	ExtractPayload,
	ExtractResult,
	Manifest,
	ManifestMeta,
	Outcome,
} from "./manifest.js";
export {
	artifactMdOutcome,
	type GitCommitData,
	type GitHeadSnapshot,
	gitCommitOutcome,
	gitHeadSnapshot,
	sideEffectOutcome,
} from "./outcomes/index.js";
export { type RunWorkflowOptions, type RunWorkflowResult, runWorkflow } from "./runner/index.js";
export {
	listArtifacts,
	listRuns,
	type RunSummary,
	readHeader,
	readLastStage,
	resolveStateFile,
	resolveWorkflowsDir,
	type WorkflowHeader,
	type WorkflowStage,
} from "./state/index.js";
export { typeboxSchema } from "./typebox-adapter.js";
export type { RunContext, RunState } from "./types.js";
export { type SchemaValidationFailure, validateManifestData } from "./validate-manifest.js";
export { validateWorkflow, type WorkflowValidationIssue } from "./validate-workflow.js";

export default function (pi: ExtensionAPI): void {
	registerWorkflowCommand(pi);
}
