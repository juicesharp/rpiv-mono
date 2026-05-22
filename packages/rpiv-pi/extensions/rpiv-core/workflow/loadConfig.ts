/**
 * Config loading for the /rpiv workflow command.
 *
 * Reads layered JSON config: project-level at `<cwd>/.rpiv/workflow.json`
 * overrides user-level at `~/.config/rpiv/workflow.json`. Full-replacement
 * semantics (no merge). Validates preset skill names against bundled skills
 * via validateDag(). Fail-soft: malformed or invalid config falls back to
 * built-in WORKFLOW_DAG with warnings.
 *
 * Config file schema:
 * {
 *   "presets": { "my-flow": ["discover", "research", "commit"] },
 *   "defaultPreset": "my-flow"
 * }
 *
 * No ExtensionAPI dependency. Pure functions take explicit paths.
 * No mutable module state — `USER_CONFIG_PATH` is resolved once at import
 * from `process.env.HOME` (homedir is cached repo-wide per worker; see
 * `test/setup.ts`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "@juicesharp/rpiv-config";
import { validateDag, WORKFLOW_DAG, type WorkflowDag } from "./dag.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a workflow config file (presets-only, extensible to edges later). */
export interface WorkflowConfigFile {
	readonly presets?: Record<string, string[]>;
	readonly defaultPreset?: string;
}

/** Result of loading and resolving workflow config. */
export interface LoadedConfig {
	/** The resolved DAG (config presets + built-in edges, or built-in fallback). */
	dag: WorkflowDag;
	/**
	 * Names of every preset in the effective DAG, in insertion order. Exposed
	 * as a Set so callers (parseArgs, formatPresetList) don't reach through
	 * `dag.presets` to compute it — the config is the single source of truth.
	 */
	presetNames: ReadonlySet<string>;
	/** Default preset name from config, or "mid" if none specified. */
	defaultPreset: string;
	/** Non-fatal issues encountered during loading (malformed JSON, validation errors). */
	warnings?: string[];
}

/** Config source — which layer the active config came from. */
export type ConfigSource = "project" | "user" | "built-in";

/** Extended result with source information for help listing. */
export interface LoadedConfigWithSource extends LoadedConfig {
	/** Which config layer is active. */
	source: ConfigSource;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** User-level config path: ~/.config/rpiv/workflow.json */
export const USER_CONFIG_PATH = configPath("rpiv", "workflow.json");

/** Resolve project-level config path relative to cwd. */
export function projectConfigPath(cwd: string): string {
	return join(cwd, ".rpiv", "workflow.json");
}

// ---------------------------------------------------------------------------
// Config file reading
// ---------------------------------------------------------------------------

/**
 * Read and parse a single config file with existsSync guard.
 *
 * Returns `{ data: undefined }` for missing files (no warning).
 * Returns `{ data: undefined, warning }` for malformed/invalid files.
 * Returns `{ data }` for valid JSON objects.
 *
 * Follows the same structural pattern as rpiv-config/config.ts:43-66 but
 * exposes the warning instead of logging to console.warn — the caller decides
 * how to surface diagnostics.
 */
export function readConfigFile(path: string): { data: WorkflowConfigFile | undefined; warning?: string } {
	if (!existsSync(path)) return { data: undefined };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { data: undefined, warning: `Invalid config at ${path}: not a JSON object` };
		}
		return { data: parsed as WorkflowConfigFile };
	} catch (err) {
		return {
			data: undefined,
			warning: `Malformed JSON at ${path}: ${(err as Error).message}`,
		};
	}
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Load and resolve workflow config for a given project directory.
 *
 * Resolution order:
 * 1. Project config at `<cwd>/.rpiv/workflow.json` (wins if present)
 * 2. User config at `~/.config/rpiv/workflow.json`
 * 3. Built-in WORKFLOW_DAG (fallback when no config exists)
 *
 * Validation chain (any failure falls back to WORKFLOW_DAG with warnings,
 * and `source` is reset to `"built-in"` so help listings don't lie about
 * where the active presets came from):
 *   - `presets` must be a record of `string[]` (no nested objects, no
 *     scalars; rejects e.g. `{ "x": "bad" }` which would otherwise iterate
 *     character-by-character through `validateDag`).
 *   - Every preset node must reference a bundled skill (via `validateDag`).
 *   - `defaultPreset` must resolve to a preset that actually exists in the
 *     effective DAG; if not, fall back to the first preset key, or "mid".
 *
 * Fail-soft: never throws. Returns WORKFLOW_DAG with warnings on any error.
 */
export function loadConfig(cwd: string): LoadedConfigWithSource {
	const warnings: string[] = [];

	// 1. Try project-level config
	const project = readConfigFile(projectConfigPath(cwd));
	if (project.warning) warnings.push(project.warning);

	let configFile: WorkflowConfigFile | undefined;
	let source: ConfigSource;

	if (project.data) {
		configFile = project.data;
		source = "project";
	} else {
		// 2. Try user-level config
		const user = readConfigFile(USER_CONFIG_PATH);
		if (user.warning) warnings.push(user.warning);
		configFile = user.data;
		source = configFile ? "user" : "built-in";
	}

	// Helper: any branch that gives up on the config-supplied presets resets
	// `source` to "built-in" so downstream help listings don't claim the DAG
	// came from a layer we just rejected. Uses the shared `warnings` array so
	// any warning pushed by `resolveDefaultPreset` lands in the same place.
	const builtInFallback = (extraWarnings: string[] = []): LoadedConfigWithSource => {
		warnings.push(...extraWarnings);
		return {
			dag: WORKFLOW_DAG,
			presetNames: new Set(Object.keys(WORKFLOW_DAG.presets)),
			defaultPreset: resolveDefaultPreset(WORKFLOW_DAG.presets, configFile?.defaultPreset, warnings),
			source: "built-in",
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	};

	// 3. No config found / no presets section — built-in DAG.
	if (!configFile?.presets || typeof configFile.presets !== "object" || Array.isArray(configFile.presets)) {
		return builtInFallback();
	}

	// 4. Runtime shape check — every preset value must be a string[]. Without
	// this, `validateDag` iterates a stray string character-by-character and
	// emits noisy per-character warnings.
	// Variable is named `stageIds` (not `nodes`) to disambiguate from the
	// DAG's `nodes` table — these strings index INTO that table.
	const shapeErrors: string[] = [];
	for (const [name, stageIds] of Object.entries(configFile.presets)) {
		if (!Array.isArray(stageIds) || !stageIds.every((n) => typeof n === "string")) {
			shapeErrors.push(`Config validation: preset "${name}" must be an array of strings`);
		}
	}
	if (shapeErrors.length > 0) return builtInFallback(shapeErrors);

	// 5. Validate node names against bundled skills. Inherit `nodes` and
	// `edges` from the built-in DAG — Phase 1 only allows users to override
	// `presets`. Custom presets must reference ids already declared in
	// `WORKFLOW_DAG.nodes`; validateDag will flag any preset entry that
	// doesn't (with a "no entry in nodes" error) and we fall back below.
	const configDag: WorkflowDag = {
		edges: WORKFLOW_DAG.edges,
		presets: configFile.presets as Record<string, string[]>,
		nodes: WORKFLOW_DAG.nodes,
	};
	try {
		const errors = validateDag(configDag);
		if (errors.length > 0) {
			return builtInFallback(errors.map((e) => `Config validation: ${e}`));
		}
	} catch (err) {
		return builtInFallback([`Config validation error: ${(err as Error).message}`]);
	}

	// 6. Resolve `defaultPreset` against the effective DAG.
	const defaultPreset = resolveDefaultPreset(configDag.presets, configFile.defaultPreset, warnings);

	return {
		dag: configDag,
		presetNames: new Set(Object.keys(configDag.presets)),
		defaultPreset,
		source,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}

/**
 * Pick a default preset name given the effective preset map.
 *
 * Order:
 *   1. Explicit `requested` value — if it exists in `presets`, use it.
 *   2. The hard-coded "mid" — if it exists (it does for WORKFLOW_DAG fallback).
 *   3. The first key in `presets` (insertion order).
 *   4. The literal "mid" string as a last resort (caller will surface
 *      `Unknown preset` on use, but at least the field is non-empty).
 *
 * Pushes a warning when the explicit `requested` value is dropped, or when
 * "mid" is silently substituted but absent from the effective presets.
 */
function resolveDefaultPreset(
	presets: Record<string, unknown>,
	requested: string | undefined,
	warnings: string[],
): string {
	if (requested && requested in presets) return requested;
	if (requested) {
		warnings.push(`defaultPreset "${requested}" not found in presets — falling back to first preset`);
	}
	if ("mid" in presets) return "mid";
	const first = Object.keys(presets)[0];
	if (first) {
		if (!requested) {
			warnings.push(`No defaultPreset specified and "mid" not in presets — using "${first}"`);
		}
		return first;
	}
	return "mid";
}
