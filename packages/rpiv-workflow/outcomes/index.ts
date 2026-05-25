/**
 * Barrel re-exports for the bundled outcomes + their primitive parts.
 *
 * `artifactMdOutcome` is deliberately NOT bundled here — the
 * `.rpiv/artifacts/<bucket>/<file>.md` layout is an rpiv-pi convention,
 * not a framework truth. rpiv-pi ships its own `rpivArtifactMdOutcome`
 * (and `rpivArtifactCollector` / `rpivBucketCollector` helpers) built on
 * top of the framework primitives re-exported from `./collectors` and
 * `./parsers`.
 */

export * from "./collectors/index.js";
export {
	type GitCommitData,
	type GitHeadSnapshot,
	gitCommitCollector,
	gitCommitOutcome,
	gitCommitParser,
	gitHeadSnapshot,
} from "./git-commit.js";
export * from "./parsers/index.js";
export { noopCollector, sideEffectOutcome } from "./side-effect.js";
