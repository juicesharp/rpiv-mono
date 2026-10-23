/**
 * rpiv-workflow — ultra-thin startup-registration entry (~9ms): only the
 * lifecycle + built-in registrars a sibling wires up at extension load, with no
 * loader/DSL/runner graph. Pair `registerBuiltInsProvider` with a thunk that
 * dynamically imports your definitions so they build on first `/wf`, not startup.
 */

export { registerBuiltIns, registerBuiltInsProvider } from "./built-ins.ts";
export { registerLifecycle } from "./events.ts";
export { registerWorkflowExecutionHost } from "./execution-host.ts";
export {
	getBucketKindMappings,
	registerBucketKindMapping,
	registerCompositionComparator,
	registerOutcomeDeriver,
	registerSkillContracts,
	registerSkillContractsProvider,
} from "./skill-contracts/index.ts";
export { summarizeRun } from "./state/index.ts";
