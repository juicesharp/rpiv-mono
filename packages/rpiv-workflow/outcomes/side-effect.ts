/**
 * Default outcome for side-effect stages — and the framework's
 * "no artifacts produced" primitive.
 *
 * Collector always returns `{ kind: "ok", artifacts: [] }`. The chain
 * semantics (see `runner/stage-lifecycle.ts:inputForStage`) then
 * inherit the upstream artifact list forward — an action skill
 * between two produces skills doesn't need its own collector.
 *
 * No parser: with `artifacts: []` the manifest's `data` is the empty
 * list and `kind` is the literal `"artifacts"`. Stages that need a
 * different discriminator wire their own outcome.
 *
 * No snapshot — side-effect stages have no pre-stage state to capture.
 */

import type { ArtifactCollector, OutputSpec } from "../outcome-types.js";

/** Collector primitive: always returns zero artifacts, never fatal. */
export const noopCollector: ArtifactCollector = {
	collect: () => ({ kind: "ok", artifacts: [] }),
};

export const sideEffectOutcome: OutputSpec = {
	collector: noopCollector,
};
