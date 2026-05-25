/**
 * Runtime shape guards + small formatting helpers used during default-export
 * normalisation. `isWorkflow` / `isEnvelope` narrow `unknown` default exports
 * to the structural shapes `normalizeDefaultExport` accepts; `describe` /
 * `formatError` synthesize human-readable strings for load-issue messages.
 */

import type { Workflow } from "../api.js";

export interface Envelope {
	workflows: Workflow[];
	default?: string;
}

export function isWorkflow(v: unknown): v is Workflow {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.name === "string" &&
		typeof o.start === "string" &&
		typeof o.nodes === "object" &&
		o.nodes !== null &&
		typeof o.edges === "object" &&
		o.edges !== null
	);
}

export function isEnvelope(v: unknown): v is Envelope {
	if (!v || typeof v !== "object") return false;
	return Array.isArray((v as Record<string, unknown>).workflows);
}

export function describe(v: unknown): string {
	if (v === null) return "null";
	if (v === undefined) return "undefined";
	if (Array.isArray(v)) return "an array";
	return typeof v;
}

export function formatError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
