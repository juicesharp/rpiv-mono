/**
 * Runtime shape guards + small formatting helpers used during default-export
 * normalisation. `isWorkflow` / `isEnvelope` narrow `unknown` default exports
 * to the structural shapes `normalizeDefaultExport` accepts; `describe`
 * synthesizes human-readable strings for load-issue messages. (`formatError`
 * lives in `../internal-utils.ts` — it's package-wide, not loader-specific.)
 */

import type { Workflow } from "../api.ts";

export interface Envelope {
	workflows?: Workflow[];
	default?: string;
	skillAliases?: Record<string, string>;
}

export function isWorkflow(v: unknown): v is Workflow {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.name === "string" &&
		typeof o.start === "string" &&
		typeof o.stages === "object" &&
		o.stages !== null &&
		typeof o.edges === "object" &&
		o.edges !== null
	);
}

export function isEnvelope(v: unknown): v is Envelope {
	if (!v || typeof v !== "object") return false;
	if (isWorkflow(v)) return false; // a bare Workflow is not an envelope
	const e = v as Record<string, unknown>;
	// An envelope is the config-file shape: it carries `workflows`, and/or the
	// config-only fields `skillAliases` / `default`. (An alias-only config has
	// no `workflows`.)
	return Array.isArray(e.workflows) || "skillAliases" in e || "default" in e;
}

export function describe(v: unknown): string {
	if (v === null) return "null";
	if (v === undefined) return "undefined";
	if (Array.isArray(v)) return "an array";
	return typeof v;
}
