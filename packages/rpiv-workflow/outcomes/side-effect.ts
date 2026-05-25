/**
 * Default outcome for agent-end nodes.
 *
 * Returns a side-effect manifest inheriting the prior artifact_path.
 * Used for action skills (commit, implement) where the work IS the side effect.
 */

import { currentArtifactPath } from "../internal-utils.js";
import type { Outcome } from "../manifest.js";

/**
 * Extract a manifest payload for an agent-end node.
 *
 * Always succeeds — agent-end nodes don't produce artifacts. The payload
 * inherits the prior stage's artifact_path so the chain's path-propagation
 * invariant holds when an action skill sits between two artifact-emit skills.
 *
 * No `baseline` — side-effect nodes have no pre-stage state to capture.
 */
export const sideEffectOutcome: Outcome<undefined, "side-effect", Record<string, never>> = {
	extract(ctx) {
		return {
			kind: "ok",
			payload: {
				kind: "side-effect",
				artifact_path: currentArtifactPath(ctx.state),
				data: {},
			},
		};
	},
};
