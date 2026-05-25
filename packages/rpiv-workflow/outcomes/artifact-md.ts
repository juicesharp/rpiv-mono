/**
 * Default outcome for artifact-emit nodes.
 *
 * Uses the existing extractArtifactPath regex to find the artifact path in
 * the transcript, then parses frontmatter from the file on disk via
 * parseFrontmatter (from pi-coding-agent). Files without frontmatter produce
 * data: {}.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { ARTIFACT_PATH_DESCRIPTION } from "../artifacts-layout.js";
import { resolveUnderCwd } from "../internal-utils.js";
import type { Outcome } from "../manifest.js";
import { extractArtifactPath } from "../transcript.js";

/** Error when the stage produced no artifact path in the transcript. */
const ERR_NO_ARTIFACT_PATH = (skill: string) =>
	`${skill} finished without producing a ${ARTIFACT_PATH_DESCRIPTION} path`;

/** Error when the agent announced a path that doesn't exist on disk. */
const ERR_FILE_MISSING = (path: string) => `agent announced ${path} but file does not exist on disk`;

/**
 * Extract a manifest for an artifact-emit node.
 *
 * Resolution order:
 * 1. Extract artifact path from transcript via regex (existing path-locator).
 * 2. If no path found → fatal (stage must produce an artifact).
 * 3. If path found but file doesn't exist → fatal (agent announced but never wrote).
 * 4. If file exists → parse frontmatter, return artifact-md manifest.
 *
 * No `baseline` — artifact-emit nodes have no pre-stage state to capture.
 * Frontmatter is `Record<string, unknown>` because parseFrontmatter
 * narrows from arbitrary YAML; downstream nodes that read it should
 * declare an `inputSchema` for typed narrowing.
 */
export const artifactMdOutcome: Outcome<undefined, "artifact-md", Record<string, unknown>> = {
	extract(ctx) {
		const artifactPath = extractArtifactPath(ctx.branch, ctx.branchOffset);

		if (!artifactPath) {
			return { kind: "fatal", message: ERR_NO_ARTIFACT_PATH(ctx.skill) };
		}

		const absolutePath = resolveUnderCwd(ctx.cwd, artifactPath);

		if (!existsSync(absolutePath)) {
			return { kind: "fatal", message: ERR_FILE_MISSING(artifactPath) };
		}

		const content = readFileSync(absolutePath, "utf-8");
		const { frontmatter } = parseFrontmatter(content);

		return {
			kind: "ok",
			payload: {
				kind: "artifact-md",
				artifact_path: artifactPath,
				data: frontmatter && typeof frontmatter === "object" ? frontmatter : {},
			},
		};
	},
};
