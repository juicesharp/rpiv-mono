/**
 * Default extractor for agent-end nodes.
 *
 * Returns a side-effect manifest inheriting the prior artifact_path.
 * Used for action skills (commit, implement) where the work IS the side effect.
 */

import type { ExtractorCtx, ExtractorResult } from "../manifest.js";

/**
 * Extract a manifest payload for an agent-end node.
 *
 * Always succeeds — agent-end nodes don't produce artifacts. The payload
 * inherits the prior stage's artifact_path so the chain's path-propagation
 * invariant holds when an action skill sits between two artifact-emit skills.
 */
export function sideEffectExtractor(ctx: ExtractorCtx): ExtractorResult {
	return {
		payload: {
			kind: "side-effect",
			artifact_path: ctx.state.artifactPath,
			data: {},
		},
	};
}
