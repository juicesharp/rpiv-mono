/**
 * JSONL state public surface. Internal layout lives in `state.ts`'s
 * header; this barrel re-exports only the symbols the rest of the
 * package consumes.
 */

export type {
	RoutingDecision,
	RunSummary,
	StageStatus,
	WorkflowHeader,
	WorkflowStage,
} from "./state.js";
export {
	appendRoutingDecision,
	appendStage,
	generateRunId,
	listArtifacts,
	listRuns,
	readAllStages,
	readHeader,
	readLastStage,
	readRoutingDecisions,
	stateFilePath,
	workflowsDir,
	writeHeader,
} from "./state.js";
