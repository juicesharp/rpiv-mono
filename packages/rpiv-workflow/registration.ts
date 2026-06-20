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
	type AssessLoop,
	acts,
	type CapPolicy,
	type DefineRouteOptions,
	defineRoute,
	defineWorkflow,
	type EdgeContext,
	type EdgeFn,
	type EdgeTarget,
	type FanoutContext,
	type FanoutFn,
	type FanoutLoop,
	type FeedForwardContext,
	fanin,
	gate,
	type IterateContext,
	type IterateFn,
	type IterateLoop,
	type JudgedRepetition,
	type LoopDef,
	type MatchOptions,
	type MatchValue,
	marksReadsData,
	match,
	ON_INVALID_VALUES,
	type OnInvalid,
	type ProducesScriptFn,
	type PromptFn,
	type PromptStage,
	produces,
	READS_DATA,
	type ResultProjection,
	type ScriptContext,
	type ScriptStage,
	SESSION_POLICIES,
	type SessionPolicy,
	type SkillStage,
	STAGE_KINDS,
	STOP,
	type StageDef,
	type StageKind,
	type StageRead,
	type StageSchema,
	terminal,
	type Unit,
	type UnitRole,
	type UnitSelector,
	type VerifySpec,
	type Workflow,
} from "./api.js";
export { registerBuiltIns, registerBuiltInsProvider } from "./built-ins.js";
// The shared dispatch predicate (and SkillStage type guard) — public so
// extension points that key on a stage's skill identity (outcome derivers,
// contract tooling) apply the same gate the loader/validator/harvest use.
export { isDispatchingStage } from "./chain-state.js";
export {
	type LifecycleContext,
	type LifecycleListeners,
	type LoopCapInfo,
	type LoopStartInfo,
	registerLifecycle,
	type StageRef,
	type UnitEvent,
} from "./events.js";
export {
	type Artifact,
	type ArtifactHandle,
	fs,
	handleToString,
	inline,
	opaque,
	url,
} from "./handle.js";
export type {
	ModelSelection,
	WorkflowHost,
	WorkflowHostContext,
	WorkflowSessionContext,
} from "./host.js";
// Only the contract data types are public — they're referenced by kept public
// signatures (`JsonSchemaCapable` ← `typeboxSchema`, `JsonSchemaObject` ←
// `ConsumesSpec`/`ProducesSpec.data`, `SchemaCompatResult` ← `canCompose`). The
// low-level json-schema and schema-compat FUNCTIONS stay package-private (no
// consumer needs them); internal callers import them from their source modules
// directly.
export type { JsonSchemaCapable, JsonSchemaObject } from "./json-schema.js";
export {
	type AnyJudge,
	type FoldFn,
	isPanel,
	type Judge,
	type JudgeContext,
	type JudgePromptFn,
	judge,
	judgeShapeIssues,
	type NamedOutcome,
	type PanelJudge,
	type PromptJudge,
	panelMembers,
	type SkillJudge,
} from "./judge.js";
export type { ConfigLayer, Issue, LoadedWorkflows, LoadIssue, OverlayPaths } from "./load/index.js";
export { aliasSkills, loadWorkflows, projectOverlayPaths, userOverlayPaths } from "./load/index.js";
export {
	type AnyJudgeSpec,
	all,
	any,
	assess,
	DEFAULT_ASSESS_MAX,
	describeFlow,
	fanout,
	iterate,
	type JudgeSpec,
	judgeSlotSpecOf,
	judgeSpecOf,
	type LoopSpec,
	loopSpecOf,
	majority,
	PANEL_VERDICT,
	PANEL_VERDICT_OUTCOME,
	type PanelJudgeSpec,
	type PanelSpec,
	type PanelVerdict,
	panel,
	panelShapeIssues,
	panelSpecOf,
	type StageShape,
	verify,
	verifyShapeIssues,
} from "./loop-constructors.js";
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
export type { Output, OutputMeta, RunView, Verdict } from "./output.js";
// Producer-side surface — `output-spec.ts` is the ONE canonical import path
// for collector/parser/outcome authoring types (`output.ts` keeps only the
// envelope). `OutputSpec` is the deprecated pre-rename alias of `Outcome`.
export {
	type ArtifactCollector,
	type ArtifactParser,
	type CollectCtx,
	type CollectResult,
	defineCollector,
	defineParser,
	type Outcome,
	type OutputSpec,
	type ParseCtx,
	type ParseResult,
	type SnapshotCtx,
} from "./output-spec.js";
export { eq, gt, gte, lt, lte, type NumericPredicate, type Predicate } from "./predicates.js";
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
	getBucketKindMappings,
	legalNextSkills,
	type OutcomeDeriverFn,
	registerBucketKindMapping,
	registerCompositionComparator,
	registerOutcomeDeriver,
	registerSkillContracts,
	registerSkillContractsProvider,
} from "./skill-contracts/index.js";
export {
	type LoopCapRow,
	listArtifacts,
	listRuns,
	type RunSummary,
	readHeader,
	readLastStage,
	readLoopCaps,
	resolveRun,
	// Storage layout stays private: `runFileFor` is the one OPAQUE path
	// projection; `runsDir`/`stateFilePath` moved to the test-only internal
	// subpath so external code can't synthesize layout-coupled paths.
	runFileFor,
	type SessionRef,
	STATE_SCHEMA_VERSION,
	type WorkflowHeader,
	type WorkflowStage,
} from "./state/index.js";
export { DEFAULT_TRIGGER, type RunTrigger } from "./triggers.js";
export { typeboxSchema } from "./typebox-adapter.js";
// `RunState` is deliberately NOT here — it became runner-private when user
// contexts switched to the deep-readonly `RunView` (T3). Test fixtures that
// must construct one import it from `@juicesharp/rpiv-workflow/internal`.
export type { RunTermination } from "./types.js";
export { type SchemaValidationFailure, validateOutputData } from "./validate-output.js";
export {
	type ValidationIssueCode,
	validateWorkflow,
	type WorkflowValidationIssue,
} from "./validate-workflow.js";
