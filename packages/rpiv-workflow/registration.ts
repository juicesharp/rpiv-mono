/**
 * rpiv-workflow — runner-free public surface: the entire API EXCEPT the
 * execution engine (`./runner/index.js`, ~530ms), which lives only on the main
 * `./index.ts` (`export * from here` + the runner). Siblings that touch
 * rpiv-workflow at startup (registering built-ins/lifecycle, authoring
 * definitions, listing workflows) import this so they never drag the runner onto
 * the startup path. Dependencies flow runner → leaf, so this can't pull it.
 */

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
export { registerBuiltIns, registerBuiltInsProvider } from "./built-ins.js";
export {
	type ControlFlowSpec,
	describeFlow,
	type FanoutSpec,
	fanoutOver,
	fanoutSpecOf,
	type IterateSpec,
	iterateOver,
	iterateSpecOf,
	type SpeccedFanoutFn,
	type SpeccedIterateFn,
	type StageShape,
	type UnitSelector,
} from "./control-flow.js";
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
// Only the contract data types are public — they're referenced by kept public
// signatures (`JsonSchemaCapable` ← `typeboxSchema`, `JsonSchemaObject` ←
// `ConsumesSpec`/`ProducesSpec.data`, `SchemaCompatResult` ← `canCompose`). The
// low-level json-schema and schema-compat FUNCTIONS stay package-private (no
// consumer needs them); internal callers import them from their source modules
// directly.
export type { JsonSchemaCapable, JsonSchemaObject } from "./json-schema.js";
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
export type {
	ConsumesReadSpec,
	ConsumesSpec,
	ContractSource,
	ProducesSpec,
	SchemaCompatResult,
	SkillContract,
	SkillContractMap,
} from "./skill-contract.js";
export {
	canCompose,
	legalNextSkills,
	type OutcomeDeriverFn,
	registerCompositionComparator,
	registerOutcomeDeriver,
	registerSkillContracts,
	registerSkillContractsProvider,
} from "./skill-contracts/index.js";
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
