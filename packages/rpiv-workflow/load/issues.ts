/**
 * The loader's issue vocabulary — a LEAF module so `merge.ts` (and any other
 * pipeline stage) can name the `Issue` shape without importing the
 * orchestrator back.
 *
 * `layer`/`path` attribution lives ONLY here: `validateWorkflow` knows
 * nothing about config layers; the loader is the seam that has both
 * `workflowSources` and the issue list in scope, so it wraps each validation
 * issue with the layer/path of the file the surviving workflow came from.
 */

import type { ConfigLayer } from "../layers.js";
import type { WorkflowValidationIssue } from "../validate/issue.js";

/**
 * Where a load issue originated: one of the config layers, or `"framework"`
 * — the loader's own machinery (skill-contract providers, outcome derivers,
 * collision tracking). The framework origin is honest attribution for
 * errors no config file caused.
 */
export type LoadIssueOrigin = ConfigLayer | "framework";

export interface LoadIssue {
	kind: "load";
	layer: LoadIssueOrigin;
	path?: string;
	severity: "error" | "warning";
	message: string;
}

export type Issue = LoadIssue | (WorkflowValidationIssue & { kind: "validation"; layer: ConfigLayer; path?: string });
