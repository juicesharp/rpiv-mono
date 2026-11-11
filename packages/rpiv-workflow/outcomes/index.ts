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

export * from "./collectors/index.ts";
export {
	type GitCommitData,
	type GitCommitOutput,
	type GitHeadSnapshot,
	gitCommitCollector,
	gitCommitOutcome,
	gitCommitParser,
	gitHeadSnapshot,
} from "./git-commit.ts";
export * from "./parsers/index.ts";
export { noopCollector, sideEffectOutcome } from "./side-effect.ts";
