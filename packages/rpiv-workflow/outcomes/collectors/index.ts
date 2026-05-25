/**
 * Bundled collectors — universal primitives + ergonomic wrappers +
 * composition helpers. Re-exported through `outcomes/index.ts` and
 * surfaced to authors via the package's top-level barrel.
 *
 * The framework ships ONLY host-agnostic collectors — no Pi tool-name
 * defaults, no `.rpiv/artifacts/` defaults, no domain helpers
 * (Linear/S3/Notion). Convention layers live in sibling packages
 * (`rpiv-pi` ships `rpivArtifactCollector` / `rpivBucketCollector`).
 */

export { type DirectoryPathCollectorOpts, directoryPathCollector } from "./directory-path.js";
export { type ToolCall, type ToolCallCollectorOpts, toolCallCollector } from "./tool-call.js";
export { type TranscriptPathCollectorOpts, transcriptPathCollector } from "./transcript-path.js";
export { unionCollectors } from "./union.js";
export { type UrlCollectorOpts, urlCollector } from "./url.js";
export {
	type WorkspaceDiffCollectorOpts,
	type WorkspaceDiffSnapshot,
	workspaceDiffCollector,
} from "./workspace-diff.js";
