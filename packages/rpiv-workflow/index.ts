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
 *   1. Authoring DSL — `./api.js`, `./predicates.js`, `./typebox-adapter.js`
 *      What a `workflows.config.ts` author imports to declare a workflow:
 *      `defineWorkflow`, `produces`, `acts`, `terminal`, `defineRoute`, `gate`,
 *      `STOP` (terminal-edge sentinel; `"stop"` literal also valid),
 *      `Workflow`, `StageDef`, `EdgeFn`, `EdgeTarget`, `EdgeContext`,
 *      `StageSchema`, `StageKind`, `SessionPolicy`, `OutputSpec`,
 *      `READS_DATA`, the runtime-mirror `*_VALUES` arrays, the
 *      `gt`/`gte`/`lt`/`lte`/`eq` predicate helpers, and `typeboxSchema`
 *      (the TypeBox adapter).
 *
 *   2. Runner (programmatic embedders) — `./runner/index.js`, `./host.js`
 *      Drive a workflow from outside `/wf`: `runWorkflow` (+ the by-name
 *      sugar `runWorkflowByName`) and `resumeWorkflow` (+ the by-run-id
 *      sugar `resumeWorkflowByRunId`), with `RunWorkflowOptions`,
 *      `RunWorkflowByNameOptions`, `ResumeWorkflowOptions`,
 *      `ResumeWorkflowByRunIdOptions`, and the shared `RunWorkflowResult`.
 *      Every options bag accepts an optional `signal: AbortSignal` for
 *      between-stage cooperative cancellation. Embedders type their host
 *      handles against `WorkflowHost` / `WorkflowHostContext` (the host
 *      ports) — Pi's `ExtensionAPI` / `ExtensionCommandContext` /
 *      `ReplacedSessionContext` structurally satisfy them, so the
 *      values pass through without casting.
 *
 *   3. Loader (programmatic embedders) — `./load/index.js`
 *      Materialise the merged workflow registry: `loadWorkflows`,
 *      `LoadedWorkflows`, `Issue`, `LoadIssue`, `ConfigLayer`,
 *      `OverlayPaths`, `projectOverlayPaths`, `userOverlayPaths`,
 *      `aliasSkills`. Siblings can apply the same remap to a built-in
 *      workflow before handing it to `runWorkflow`.
 *
 *   4. Built-in registry (sibling packages) — `./built-ins.js`
 *      Contribute workflows to the lowest config layer:
 *      `registerBuiltIns`. (`getBuiltIns` is test-only and lives on
 *      `@juicesharp/rpiv-workflow/internal`.)
 *
 *   5. Output envelope + bundled outcomes — `./output.js`,
 *      `./outcomes/index.js`, `./handle.js`
 *      Inter-stage data channel (`Output<K, D>`, `OutputMeta`,
 *      `Artifact`, `ArtifactHandle` + constructors `fs`/`url`/
 *      `opaque`/`inline`/`handleToString`) + bundled outcomes
 *      (`sideEffectOutcome`, `gitCommitOutcome`, `GitCommitData`,
 *      `gitHeadSnapshot`, `GitHeadSnapshot`) + the bundled
 *      collector/parser catalog wireable into any custom `OutputSpec`:
 *        - collectors: `transcriptPathCollector` (regex over assistant
 *          text), `toolCallCollector` (universal tool_use observer),
 *          `workspaceDiffCollector` (git status diff pre/post),
 *          `gitCommitCollector` (commit detection), the wrappers
 *          `directoryPathCollector` / `urlCollector`, plus composition
 *          `unionCollectors` and the empty-list primitive `noopCollector`.
 *        - parsers: `jsonBodyParser` (parses primary fs body),
 *          `gitCommitParser`.
 *      The `.rpiv/artifacts/<bucket>/<file>.md` outcome + the
 *      markdown-frontmatter parser live in `@juicesharp/rpiv-pi`
 *      (`rpivArtifactMdOutcome` / `frontmatterParser`) — those are
 *      rpiv conventions, not framework defaults.
 *
 *   6. Custom-outcome authoring surface — `./output.js`
 *      `OutputSpec<Snapshot, Kind, Data>` (collector + optional parser),
 *      `ArtifactCollector`, `ArtifactParser`, `CollectCtx`,
 *      `CollectResult`, `ParseCtx`, `ParseResult`, `SnapshotCtx`,
 *      `SnapshotFn`. Sugar: `defineCollector` / `defineParser`.
 *
 *   7. Validation surfaces — `./validate-workflow.js`,
 *      `./validate-output.js`
 *      `validateWorkflow`, `WorkflowValidationIssue`,
 *      `validateOutputData`, `SchemaValidationFailure`.
 *
 *   8. Persistence (low-level — JSONL inspect) — `./state/index.js`
 *      Read past runs at `<cwd>/.rpiv/workflows/runs/<run-id>.jsonl`:
 *      `listRuns`, `readHeader`, `resolveRun` (run-id → header; today an
 *      alias of `readHeader`), `readLastStage`, `listArtifacts`,
 *      `stateFilePath`, `runsDir`, `RunSummary`,
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
 *   • `WorkflowHost`     — registry-level (default export + continue sends)
 *   • `WorkflowHostContext`  — per-command ctx for `runWorkflow`; also the
 *                          base shape of the replacement ctx delivered to
 *                          `newSession`'s `withSession` callback.
 *                          `sendUserMessage` is optional at the type level
 *                          (the outer command ctx omits it); the runtime
 *                          guarantees it is present inside `withSession`.
 *   • `WorkflowSessionContext` — the narrower subtype delivered inside
 *                          `withSession`, where `sendUserMessage` is
 *                          GUARANTEED present (optional → required).
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
import { type DocsProtocolHost, registerDocsProtocol } from "./docs-protocol.js";
import type { WorkflowHost } from "./host.js";

export {
	type ActsScriptFn,
	acts,
	type DefineRouteOptions,
	defineRoute,
	defineWorkflow,
	type EdgeContext,
	type EdgeFn,
	type EdgeTarget,
	type FanoutContext,
	type FanoutFn,
	type FanoutUnit,
	gate,
	type IterateContext,
	type IterateFn,
	type IterateUnit,
	marksReadsData,
	ON_INVALID_VALUES,
	type OnInvalid,
	type ProducesScriptFn,
	type PromptFn,
	produces,
	READS_DATA,
	type ScriptContext,
	SESSION_POLICIES,
	type SessionPolicy,
	STAGE_KINDS,
	STOP,
	type StageDef,
	type StageKind,
	type StageSchema,
	terminal,
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
export type { WorkflowHost, WorkflowHostContext, WorkflowSessionContext } from "./host.js";
export { type LifecycleContext, type LifecycleListeners, registerLifecycle, type StageRef } from "./lifecycle.js";
export type { ConfigLayer, Issue, LoadedWorkflows, LoadIssue, OverlayPaths } from "./load/index.js";
export { aliasSkills, loadWorkflows, projectOverlayPaths, userOverlayPaths } from "./load/index.js";
export {
	type DirectoryPathCollectorOpts,
	directoryPathCollector,
	type GitCommitData,
	type GitHeadSnapshot,
	gitCommitCollector,
	gitCommitOutcome,
	gitCommitParser,
	gitHeadSnapshot,
	jsonBodyParser,
	noopCollector,
	sideEffectOutcome,
	type ToolCall,
	type ToolCallCollectorOpts,
	type TranscriptPathCollectorOpts,
	toolCallCollector,
	transcriptPathCollector,
	type UrlCollectorOpts,
	unionCollectors,
	urlCollector,
	type WorkspaceDiffCollectorOpts,
	type WorkspaceDiffSnapshot,
	workspaceDiffCollector,
} from "./outcomes/index.js";
export type {
	ArtifactCollector,
	ArtifactParser,
	CollectCtx,
	CollectResult,
	Output,
	OutputMeta,
	OutputSpec,
	ParseCtx,
	ParseResult,
	SnapshotCtx,
	SnapshotFn,
} from "./output.js";
export { defineCollector, defineParser } from "./output-spec.js";
export { eq, gt, gte, lt, lte, type Predicate } from "./predicates.js";
export {
	type ResumeWorkflowByRunIdOptions,
	type ResumeWorkflowOptions,
	type RunWorkflowByNameOptions,
	type RunWorkflowOptions,
	type RunWorkflowResult,
	resumeWorkflow,
	resumeWorkflowByRunId,
	runWorkflow,
	runWorkflowByName,
} from "./runner/index.js";
export {
	listArtifacts,
	listRuns,
	type RunSummary,
	readHeader,
	readLastStage,
	resolveRun,
	runsDir,
	stateFilePath,
	type WorkflowHeader,
	type WorkflowStage,
} from "./state/index.js";
export { DEFAULT_TRIGGER, type RunTrigger } from "./triggers.js";
export { typeboxSchema } from "./typebox-adapter.js";
export type { RunState } from "./types.js";
export { type SchemaValidationFailure, validateOutputData } from "./validate-output.js";
export { validateWorkflow, type WorkflowValidationIssue } from "./validate-workflow.js";

/**
 * Local intersection of the two host ports this extension's `default`
 * function needs. `WorkflowHost` covers the workflow-command surface;
 * `DocsProtocolHost` covers the `on("before_agent_start", ...)` hook used
 * to prepend the docs-protocol block. Pi's `ExtensionAPI` structurally
 * satisfies both; programmatic embedders keep using the narrower
 * `WorkflowHost` port, so this alias stays local — not re-exported.
 */
type ExtensionHost = WorkflowHost & DocsProtocolHost;

export default function (host: ExtensionHost): void {
	registerWorkflowCommand(host);
	registerDocsProtocol(host);
}
