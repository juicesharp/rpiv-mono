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
 *   2. Runner (programmatic embedders) — `./runner/index.js`, `./host.js`
 *      Drive a workflow from outside `/wf`: `runWorkflow`,
 *      `RunWorkflowOptions`, `RunWorkflowResult`. Embedders type their
 *      host handles against `WorkflowHost` / `WorkflowCommandHost` /
 *      `WorkflowSessionHost` (the host ports) — Pi's `ExtensionAPI` /
 *      `ExtensionCommandContext` structurally satisfy them, so the
 *      values pass through without casting.
 *
 *   3. Loader (programmatic embedders) — `./load/index.js`
 *      Materialise the merged workflow registry: `loadWorkflows`,
 *      `LoadedWorkflows`, `Issue`, `LoadIssue`, `ConfigLayer`,
 *      `OverlayPaths`, `projectOverlayPaths`, `userOverlayPaths`.
 *
 *   4. Built-in registry (sibling packages) — `./built-ins.js`
 *      Contribute workflows to the lowest config layer:
 *      `registerBuiltIns`. (`getBuiltIns` is test-only and lives on
 *      `@juicesharp/rpiv-workflow/internal`.)
 *
 *   5. Manifest envelope + bundled outcomes — `./manifest.js`,
 *      `./outcomes/index.js`, `./handle.js`
 *      Inter-stage data channel (`Manifest<K, D>`, `ManifestMeta`,
 *      `Artifact`, `ArtifactHandle` + constructors `fs`/`url`/
 *      `opaque`/`inline`/`handleToString`) + bundled outcomes
 *      (`sideEffectOutcome`, `gitCommitOutcome`, `GitCommitData`,
 *      `gitHeadSnapshot`, `GitHeadSnapshot`) + the bundled
 *      resolver/reader catalog wireable into any custom `Outcome`:
 *        - resolvers: `transcriptPathResolver` (regex over assistant
 *          text), `toolCallResolver` (universal tool_use observer),
 *          `workspaceDiffResolver` (git status diff pre/post),
 *          `gitCommitResolver` (commit detection), the wrappers
 *          `directoryPathResolver` / `urlResolver`, plus composition
 *          `unionResolvers` and the empty-list primitive `noopResolver`.
 *        - readers: `jsonBodyReader` (parses primary fs body),
 *          `gitCommitReader`.
 *      The `.rpiv/artifacts/<bucket>/<file>.md` outcome + the
 *      markdown-frontmatter reader live in `@juicesharp/rpiv-pi`
 *      (`rpivArtifactMdOutcome` / `frontmatterReader`) — those are
 *      rpiv conventions, not framework defaults.
 *
 *   6. Custom-outcome authoring surface — `./manifest.js`
 *      `Outcome<Baseline, Kind, Data>` (resolver + optional reader),
 *      `ArtifactResolver`, `ArtifactReader`, `ResolveCtx`,
 *      `ResolveResult`, `ReadCtx`, `ReadResult`, `BaselineCtx`,
 *      `BaselineFn`. Sugar: `defineResolver` / `defineReader`.
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
 *      `WorkflowHeader`, `WorkflowStage`. `recordStage` lives on
 *      `@juicesharp/rpiv-workflow/internal` (test-only — rpiv-pi's
 *      `[I3]` regression test pokes it directly; runner owns row
 *      writes, embedders never need it).
 *
 *   9. Runtime types — `./types.js`
 *      `RunState`.
 *
 * Per-module deep imports (`from "@juicesharp/rpiv-workflow/api.js"`)
 * are NOT supported across the package boundary.
 *
 * ─── Pi-coupling boundary ───────────────────────────────────────────────
 *
 * The package's public type surface names ZERO `@earendil-works/pi-coding-agent`
 * types. Every host capability the runtime needs is declared as a
 * workflow-owned port in `./host.js`:
 *
 *   • `WorkflowHost`         — registry-level (default export + continue sends)
 *   • `WorkflowCommandHost`  — per-command ctx for `runWorkflow`
 *   • `WorkflowSessionHost`  — replacement ctx delivered to `newSession`'s
 *                              `withSession` callback
 *
 * Pi's `ExtensionAPI` / `ExtensionCommandContext` are structurally
 * compatible with these ports — embedders pass their existing Pi handles
 * directly. A future non-Pi host implements the three port interfaces.
 *
 * The package no longer imports any value from
 * `@earendil-works/pi-coding-agent` — `parseFrontmatter` moved to
 * `@juicesharp/rpiv-pi` along with the rpiv-flavoured outcome
 * (`rpivArtifactMdOutcome`). The peer dep stays for `pi-tui` types
 * structural-compatibility only.
 *
 * `host.test.ts` carries a compile-time tripwire that fails immediately
 * if Pi's types drift below the port's required shape.
 */

import { registerWorkflowCommand } from "./command.js";
import type { WorkflowHost } from "./host.js";

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
export { registerBuiltIns } from "./built-ins.js";
export {
	type Artifact,
	type ArtifactHandle,
	fs,
	handleToString,
	inline,
	opaque,
	url,
} from "./handle.js";
export type { WorkflowCommandHost, WorkflowHost, WorkflowSessionHost } from "./host.js";
export type { ConfigLayer, Issue, LoadedWorkflows, LoadIssue, OverlayPaths } from "./load/index.js";
export { loadWorkflows, projectOverlayPaths, userOverlayPaths } from "./load/index.js";
export type {
	ArtifactReader,
	ArtifactResolver,
	BaselineCtx,
	BaselineFn,
	Manifest,
	ManifestMeta,
	Outcome,
	ReadCtx,
	ReadResult,
	ResolveCtx,
	ResolveResult,
} from "./manifest.js";
export { defineReader, defineResolver } from "./outcome-types.js";
export {
	type DirectoryPathResolverOpts,
	directoryPathResolver,
	type GitCommitData,
	type GitHeadSnapshot,
	gitCommitOutcome,
	gitCommitReader,
	gitCommitResolver,
	gitHeadSnapshot,
	jsonBodyReader,
	noopResolver,
	sideEffectOutcome,
	type ToolCall,
	type ToolCallResolverOpts,
	type TranscriptPathResolverOpts,
	toolCallResolver,
	transcriptPathResolver,
	type UrlResolverOpts,
	unionResolvers,
	urlResolver,
	type WorkspaceDiffBaseline,
	type WorkspaceDiffResolverOpts,
	workspaceDiffResolver,
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
export type { RunState } from "./types.js";
export { type SchemaValidationFailure, validateManifestData } from "./validate-manifest.js";
export { validateWorkflow, type WorkflowValidationIssue } from "./validate-workflow.js";

export default function (pi: WorkflowHost): void {
	registerWorkflowCommand(pi);
}
