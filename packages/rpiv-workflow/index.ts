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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowCommand } from "./command.js";

// Public API — re-exported so consumers can `import { ... } from "@juicesharp/rpiv-workflow"`
// without reaching into per-module paths.
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
export { nowIso, recordStage } from "./audit.js";
export { __resetBuiltIns, getBuiltIns, registerBuiltIns } from "./built-ins.js";
// Bundled extractors — re-exported so sibling workflows can build commit /
// artifact-md nodes without reaching into per-module paths.
export { artifactMdExtractor, gitCommitExtractor, sideEffectExtractor } from "./extractors/index.js";
export type { ConfigLayer, Issue, LoadedWorkflows, LoadIssue, OverlayPaths } from "./load/index.js";
export { loadWorkflows, projectOverlayPaths, userOverlayPaths } from "./load/index.js";
export type {
	Extractor,
	ExtractorCtx,
	ExtractorPayload,
	ExtractorResult,
	GitCommitData,
	Manifest,
	ManifestMeta,
	SnapshotCtx,
} from "./manifest.js";
export { nextNode } from "./routing.js";
export { type RunWorkflowOptions, type RunWorkflowResult, runWorkflow } from "./runner.js";
export { readLastStage, resolveStateFile, resolveWorkflowsDir } from "./state.js";
export { typeboxSchema } from "./typebox-adapter.js";
export type { RunContext, RunState } from "./types.js";
export { type SchemaValidationFailure, validateManifestData } from "./validate-manifest.js";
export { validateWorkflow, type WorkflowValidationIssue } from "./validate-workflow.js";

export default function (pi: ExtensionAPI): void {
	registerWorkflowCommand(pi);
}
