/**
 * jiti-based loader for user-authored workflows.
 *
 * Layered merge: `built-in` ← `user` (`~/.config/rpiv/config.ts`) ← `project`
 * (`<cwd>/rpiv.config.ts`). Higher layers override lower layers by workflow
 * name. `defaultPreset` (now `default`) cascades the same way.
 *
 * Three accepted default-export shapes per overlay file:
 *   1. A single `Workflow`              — single-entry namespace
 *   2. `Workflow[]`                     — multi-entry, default required if > 1
 *   3. `{ workflows, default? }`        — full envelope, explicit default
 *
 * jiti loads `.ts` directly — no build step required of users. Loader
 * failures (file throws on import, exports the wrong shape) are captured as
 * `LoadIssue`s; the loader itself never throws to its caller.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "@juicesharp/rpiv-config";
import { createJiti } from "jiti";
import type { Workflow } from "./api.js";
import { builtInWorkflows } from "./built-in.js";
import { type ValidationIssue, validateWorkflow } from "./validate.js";

// ===========================================================================
// Public types
// ===========================================================================

export type ConfigLayer = "built-in" | "user" | "project";

export interface LoadIssue {
	kind: "load";
	layer: ConfigLayer;
	path?: string;
	severity: "error" | "warning";
	message: string;
}

export type Issue = LoadIssue | (ValidationIssue & { kind: "validation" });

export interface LoadedWorkflows {
	workflows: readonly Workflow[];
	default: string;
	/** Which layer each merged workflow name came from. */
	workflowSources: ReadonlyMap<string, ConfigLayer>;
	/** Every layer that contributed, low-to-high. Always starts with "built-in". */
	layers: readonly ConfigLayer[];
	/** Aggregated load + validation issues. Errors block the runner; warnings are advisory. */
	issues: readonly Issue[];
}

// ===========================================================================
// Paths
// ===========================================================================

/** Project overlay: `<cwd>/rpiv.config.ts`. */
export function projectConfigPath(cwd: string): string {
	return join(cwd, "rpiv.config.ts");
}

/** User overlay: `~/.config/rpiv/config.ts`. */
export const USER_CONFIG_PATH = configPath("rpiv", "config.ts");

// ===========================================================================
// Loader
// ===========================================================================

/** Default workflow name when no overlay specifies one — matches the historic "mid". */
export const FALLBACK_DEFAULT_WORKFLOW = "mid";

const jiti = createJiti(import.meta.url, {
	// Bypass jiti's module cache so /reload picks up edits without restart.
	moduleCache: false,
	fsCache: false,
});

interface ParsedConfig {
	workflows: Workflow[];
	default?: string;
}

/**
 * Load every active layer, merge by workflow name, validate, and return the
 * resolved set. Never throws — load + validation errors flow through `issues`.
 */
export async function loadWorkflows(cwd: string): Promise<LoadedWorkflows> {
	const issues: Issue[] = [];
	const layers: ConfigLayer[] = ["built-in"];

	// Built-in is always the base layer.
	const workflowMap = new Map<string, Workflow>();
	const sources = new Map<string, ConfigLayer>();
	for (const w of builtInWorkflows) {
		workflowMap.set(w.name, w);
		sources.set(w.name, "built-in");
	}

	const userPath = USER_CONFIG_PATH;
	const userParsed = existsSync(userPath) ? await loadOverlay(userPath, "user", issues) : undefined;
	if (userParsed) {
		layers.push("user");
		mergeOverlay(userParsed, "user", workflowMap, sources);
	}

	const projectPath = projectConfigPath(cwd);
	const projectParsed = existsSync(projectPath) ? await loadOverlay(projectPath, "project", issues) : undefined;
	if (projectParsed) {
		layers.push("project");
		mergeOverlay(projectParsed, "project", workflowMap, sources);
	}

	// Validate every merged workflow once. Validation runs even on built-in so
	// that a future built-in regression surfaces in the same channel as user errors.
	// Each issue is enriched with its source layer + file path so command.ts can
	// render Astro-style `(rpiv.config.ts) workflow "ship": ...` errors.
	const layerPath = (l: ConfigLayer): string | undefined =>
		l === "project" ? projectPath : l === "user" ? userPath : undefined;
	for (const w of workflowMap.values()) {
		const layer = sources.get(w.name) ?? "built-in";
		const path = layerPath(layer);
		for (const v of validateWorkflow(w)) issues.push({ ...v, kind: "validation", layer, path });
	}

	const defaultName = resolveDefault(projectParsed, userParsed, workflowMap, issues);

	return {
		workflows: [...workflowMap.values()],
		default: defaultName,
		workflowSources: sources,
		layers,
		issues,
	};
}

// ---------------------------------------------------------------------------
// Overlay loading
// ---------------------------------------------------------------------------

async function loadOverlay(path: string, layer: ConfigLayer, issues: Issue[]): Promise<ParsedConfig | undefined> {
	let raw: unknown;
	try {
		raw = await jiti.import(path, { default: true });
	} catch (e) {
		issues.push({
			kind: "load",
			layer,
			path,
			severity: "error",
			message: `failed to import ${path}: ${formatError(e)}`,
		});
		return undefined;
	}

	const parsed = normalizeDefaultExport(raw);
	if ("error" in parsed) {
		issues.push({ kind: "load", layer, path, severity: "error", message: parsed.error });
		return undefined;
	}
	return parsed.value;
}

interface NormalizeOk {
	value: ParsedConfig;
}
interface NormalizeErr {
	error: string;
}

/**
 * Accept three default-export shapes per the design doc:
 *   - single `Workflow`
 *   - `Workflow[]`
 *   - `{ workflows: Workflow[]; default?: string }`
 */
function normalizeDefaultExport(raw: unknown): NormalizeOk | NormalizeErr {
	if (isWorkflow(raw)) return { value: { workflows: [raw] } };
	if (Array.isArray(raw)) {
		if (!raw.every(isWorkflow)) {
			return { error: "default export array must contain only Workflow objects" };
		}
		// A bare Workflow[] omits the `default` slot; with more than one entry
		// there's no unambiguous pick. Require the envelope form so the choice
		// is explicit. (Single-entry arrays are accepted — only one workflow
		// to default to.)
		if (raw.length > 1) {
			return {
				error:
					"default-export `Workflow[]` with more than one entry must be wrapped as " +
					'`{ workflows: [...], default: "<name>" }` so the default workflow is explicit',
			};
		}
		return { value: { workflows: raw as Workflow[] } };
	}
	if (isEnvelope(raw)) {
		if (!raw.workflows.every(isWorkflow)) {
			return { error: "default-export `workflows` must contain only Workflow objects" };
		}
		return { value: { workflows: raw.workflows, default: raw.default } };
	}
	return {
		error:
			"default export must be a Workflow, Workflow[], or { workflows: Workflow[]; default?: string } — " +
			`got ${describe(raw)}`,
	};
}

interface Envelope {
	workflows: Workflow[];
	default?: string;
}

function isWorkflow(v: unknown): v is Workflow {
	return (
		!!v &&
		typeof v === "object" &&
		typeof (v as { name?: unknown }).name === "string" &&
		typeof (v as { start?: unknown }).start === "string" &&
		!!(v as { nodes?: unknown }).nodes &&
		!!(v as { edges?: unknown }).edges
	);
}

function isEnvelope(v: unknown): v is Envelope {
	return (
		!!v &&
		typeof v === "object" &&
		Array.isArray((v as { workflows?: unknown }).workflows) &&
		(typeof (v as { default?: unknown }).default === "string" || (v as { default?: unknown }).default === undefined)
	);
}

function describe(v: unknown): string {
	if (v === null) return "null";
	if (v === undefined) return "undefined";
	if (Array.isArray(v)) return "an array";
	return typeof v;
}

function formatError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Merge + default resolution
// ---------------------------------------------------------------------------

function mergeOverlay(
	parsed: ParsedConfig,
	layer: ConfigLayer,
	workflowMap: Map<string, Workflow>,
	sources: Map<string, ConfigLayer>,
): void {
	for (const w of parsed.workflows) {
		workflowMap.set(w.name, w);
		sources.set(w.name, layer);
	}
}

/**
 * Project default wins over user default wins over built-in `mid`. An
 * explicit `default` that doesn't name an existing workflow records an
 * error and falls through to the next layer.
 */
function resolveDefault(
	project: ParsedConfig | undefined,
	user: ParsedConfig | undefined,
	workflowMap: Map<string, Workflow>,
	issues: Issue[],
): string {
	const candidates: Array<{ name: string | undefined; layer: ConfigLayer }> = [
		{ name: project?.default, layer: "project" },
		{ name: user?.default, layer: "user" },
	];

	for (const { name, layer } of candidates) {
		if (!name) continue;
		if (workflowMap.has(name)) return name;
		issues.push({
			kind: "load",
			layer,
			severity: "error",
			message: `default workflow "${name}" (from ${layer} config) is not declared`,
		});
	}

	if (workflowMap.has(FALLBACK_DEFAULT_WORKFLOW)) return FALLBACK_DEFAULT_WORKFLOW;

	// Last resort: first workflow we have. workflowMap is non-empty because
	// built-in workflows always populate it.
	const first = workflowMap.keys().next().value;
	return first ?? FALLBACK_DEFAULT_WORKFLOW;
}
