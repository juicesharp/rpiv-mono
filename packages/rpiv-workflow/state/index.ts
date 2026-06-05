/**
 * JSONL state public surface. Internal layout lives in `state.ts`'s
 * header; this barrel re-exports only the symbols the rest of the
 * package consumes.
 */

export type {
	ClaimResult,
	NamesIndex,
	RoutingDecision,
	RunSummary,
	StageStatus,
	WorkflowHeader,
	WorkflowStage,
} from "./state.js";
export {
	addNameToIndex,
	appendRoutingDecision,
	appendStage,
	claimName,
	generateRunId,
	isValidName,
	listArtifacts,
	listRuns,
	namesFilePath,
	readAllStages,
	readHeader,
	readLastStage,
	readNamesIndex,
	readRoutingDecisions,
	rebuildIndex,
	resolveRun,
	runsDir,
	stateFilePath,
	VALID_NAME,
	writeHeader,
} from "./state.js";
