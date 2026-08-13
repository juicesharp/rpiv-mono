/**
 * Barrel for the extracted built-in-workflows leaf clusters. The monolith
 * `../built-in-workflows.ts` imports its relocated helpers from here. Each
 * re-export targets a `.js` specifier (Node16 ESM, source stays `.ts`).
 */
export {
	closesFence,
	countHeadingsOutsideFences,
	FENCE_LINE_RE,
	fencedSpans,
	forEachLineOutsideFences,
} from "./markdown-fence.js";
export {
	FILE_LINE_CITATION_RE,
	FsArtifact,
	haltPreflight,
	latestFsArtifact,
	MAX_PHASES,
	PhaseRecord,
	readArtifactFile,
	StructureFinding,
	TEST_PATH_RE,
	VERDICT_DIR,
	VERDICT_FAIL_SCORE,
	VERDICT_PASS_SCORE,
	writeStructureVerdict,
} from "./shared.js";
