/**
 * Directory-path collector — `transcriptPathCollector` wrapped with the
 * common `<dir>/<filename>.<ext>` regex idiom so authors don't write
 * the regex themselves.
 *
 * Use when the convention is "all outputs land under one folder"
 * (`docs/adr/`, `outputs/`, `.scratch/runs/`). Universal — every
 * project has directories.
 *
 * For more exotic shapes (per-run nesting, multiple acceptable
 * directories, custom filename rules) drop down to
 * `transcriptPathCollector({ pattern })` and supply the regex directly.
 */

import type { ArtifactCollector } from "../../output-spec.js";
import { transcriptPathCollector } from "./transcript-path.js";

export interface DirectoryPathCollectorOpts {
	/** cwd-relative directory the agent's announced path must sit under (e.g. `"docs/adr"`). */
	dir: string;
	/**
	 * Optional file extension filter (no leading dot — `"md"`, `"json"`,
	 * etc.). Defaults to any common alphanumeric extension.
	 */
	ext?: string;
}

export function directoryPathCollector(opts: DirectoryPathCollectorOpts): ArtifactCollector {
	if (typeof opts.dir !== "string" || opts.dir.length === 0) {
		throw new Error("directoryPathCollector: `dir` is required and must be a non-empty string");
	}
	const escapedDir = escapeRegex(opts.dir);
	const extPart = opts.ext ? escapeRegex(opts.ext) : "[a-zA-Z0-9]+";
	const pattern = new RegExp(`${escapedDir}/[\\w.-]+\\.${extPart}`, "g");
	return transcriptPathCollector({ pattern });
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
