/**
 * jiti-based loader for user-authored workflows.
 *
 * Layered merge: `built-in` ← `user` ← `project`. Within each non-built-in
 * layer, drop-in files merge first (alpha-sorted filename), then the
 * canonical file — so the file the user wrote by hand wins over any packs
 * they installed via drop-in.
 *
 * Paths (per layer):
 *   user    — canonical  `~/.config/rpiv-workflow/workflows.config.ts`
 *             drop-ins   `~/.config/rpiv-workflow/workflows/*.ts`
 *   project — canonical  `<cwd>/.rpiv-workflow/workflows.config.ts`
 *             drop-ins   `<cwd>/.rpiv-workflow/workflows/*.ts`
 *
 * Canonical file — accepts three default-export shapes:
 *   1. A single `Workflow`              — single-entry namespace
 *   2. `Workflow[]`                     — multi-entry, default required if > 1
 *   3. `{ workflows, default? }`        — full envelope, explicit default
 *
 * Drop-in file — accepts only `Workflow | Workflow[]`. The envelope form
 * is rejected because `default` lives in the canonical file (one source of
 * truth per layer); a drop-in pack that tries to override the default
 * surfaces as a warning and the `default` field is ignored.
 *
 * `default` cascades layer-by-layer (project canonical > user canonical >
 * built-in `mid`); within a layer only the canonical file can set it.
 *
 * jiti loads `.ts` directly — no build step required of users. Loader
 * failures (file throws on import, exports the wrong shape) are captured as
 * `LoadIssue`s; the loader itself never throws to its caller.
 *
 * SECURITY NOTE — `jiti.import` synchronously evaluates every overlay
 * file's top-level code on every `/wf` invocation. The threat boundary
 * is the same as `npm install` (post-install scripts), `tsx some-script.ts`,
 * or any tool that respects `<cwd>` configuration: Pi already operates in
 * a context that implicitly trusts the current working directory. Users
 * running Pi in a freshly-cloned untrusted repo should diff
 * `.rpiv-workflow/workflows.config.ts` and `.rpiv-workflow/workflows/*.ts`
 * before running `/wf`, since each file executes arbitrary TypeScript on
 * load.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "@juicesharp/rpiv-config";
import { createJiti } from "jiti";
import type { Workflow } from "./api.js";
import { getBuiltIns } from "./built-ins.js";
import type { ConfigLayer } from "./layers.js";
import { validateWorkflow, type WorkflowValidationIssue } from "./validate-workflow.js";

// ===========================================================================
// Public types
// ===========================================================================

export type { ConfigLayer } from "./layers.js";

export interface LoadIssue {
	kind: "load";
	layer: ConfigLayer;
	path?: string;
	severity: "error" | "warning";
	message: string;
}

export type Issue = LoadIssue | (WorkflowValidationIssue & { kind: "validation"; layer: ConfigLayer; path?: string });

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

export interface OverlayPaths {
	/** Canonical file — the only place `default` may live. */
	canonical: string;
	/** Drop-in directory — alpha-sorted `*.ts` files merged before canonical. */
	dropInDir: string;
}

/** Project overlay paths under `<cwd>/.rpiv-workflow/`. */
export function projectOverlayPaths(cwd: string): OverlayPaths {
	const root = join(cwd, ".rpiv-workflow");
	return { canonical: join(root, "workflows.config.ts"), dropInDir: join(root, "workflows") };
}

/** User overlay paths under `~/.config/rpiv-workflow/`. */
export function userOverlayPaths(): OverlayPaths {
	return {
		canonical: configPath("rpiv-workflow", "workflows.config.ts"),
		dropInDir: configPath("rpiv-workflow", "workflows"),
	};
}

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

	// `workflowSources` maps name → layer for the public API; `sourcePaths`
	// tracks the exact file each surviving workflow came from so validation
	// issues attribute to the right path (drop-ins vs canonical).
	const workflowMap = new Map<string, Workflow>();
	const sources = new Map<string, ConfigLayer>();
	const sourcePaths = new Map<string, string | undefined>();
	for (const w of getBuiltIns()) {
		workflowMap.set(w.name, w);
		sources.set(w.name, "built-in");
		sourcePaths.set(w.name, undefined);
	}

	const userParsed = await loadLayer(userOverlayPaths(), "user", issues, workflowMap, sources, sourcePaths);
	if (userParsed) layers.push("user");

	const projectParsed = await loadLayer(
		projectOverlayPaths(cwd),
		"project",
		issues,
		workflowMap,
		sources,
		sourcePaths,
	);
	if (projectParsed) layers.push("project");

	// Validate every merged workflow once. Validation runs even on built-in so
	// that a future built-in regression surfaces in the same channel as user
	// errors. Each issue is attributed to the exact file the surviving workflow
	// came from (drop-in or canonical) so `/wf` previews can render
	// `[<layer> config (<path>)] workflow "X": ...` errors.
	for (const w of workflowMap.values()) {
		const layer = sources.get(w.name) ?? "built-in";
		const path = sourcePaths.get(w.name);
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
// Per-layer loading
// ---------------------------------------------------------------------------

/**
 * Load one layer's drop-ins (alpha-sorted) then its canonical file, merging
 * into `workflowMap`/`sources`/`sourcePaths` in that order so the canonical
 * file's workflows win over drop-ins of the same name. Returns the canonical
 * `ParsedConfig` (used only for its `default` field) — drop-in `default`
 * fields are rejected, so they never participate in default resolution.
 *
 * Returns `undefined` only when neither the canonical file nor any drop-in
 * existed; that signals to `loadWorkflows` not to append the layer to the
 * `layers` banner.
 */
async function loadLayer(
	paths: OverlayPaths,
	layer: ConfigLayer,
	issues: Issue[],
	workflowMap: Map<string, Workflow>,
	sources: Map<string, ConfigLayer>,
	sourcePaths: Map<string, string | undefined>,
): Promise<ParsedConfig | undefined> {
	let contributed = false;

	for (const dropInPath of enumerateDropIns(paths.dropInDir)) {
		const parsed = await loadOverlayFile(dropInPath, layer, issues, "drop-in");
		if (!parsed) continue;
		mergeOverlay(parsed, layer, dropInPath, workflowMap, sources, sourcePaths);
		contributed = true;
	}

	let canonicalParsed: ParsedConfig | undefined;
	if (existsSync(paths.canonical)) {
		canonicalParsed = await loadOverlayFile(paths.canonical, layer, issues, "canonical");
		if (canonicalParsed) {
			mergeOverlay(canonicalParsed, layer, paths.canonical, workflowMap, sources, sourcePaths);
			contributed = true;
		}
	}

	return contributed ? (canonicalParsed ?? { workflows: [] }) : undefined;
}

/** Alpha-sorted `*.ts` files directly under `dir`. Empty array if `dir` doesn't exist. */
function enumerateDropIns(dir: string): string[] {
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries
		.filter((name) => name.endsWith(".ts"))
		.sort()
		.map((name) => join(dir, name));
}

// ---------------------------------------------------------------------------
// Per-file loading
// ---------------------------------------------------------------------------

type FileKind = "canonical" | "drop-in";

async function loadOverlayFile(
	path: string,
	layer: ConfigLayer,
	issues: Issue[],
	kind: FileKind,
): Promise<ParsedConfig | undefined> {
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

	const parsed = normalizeDefaultExport(raw, kind);
	if ("error" in parsed) {
		issues.push({ kind: "load", layer, path, severity: "error", message: parsed.error });
		return undefined;
	}
	if (kind === "drop-in" && parsed.value.default !== undefined) {
		issues.push({
			kind: "load",
			layer,
			path,
			severity: "warning",
			message: `drop-in workflow file declared \`default: "${parsed.value.default}"\` — ignored. \`default\` lives only in the canonical workflows.config.ts.`,
		});
		parsed.value.default = undefined;
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
 * Canonical files accept three default-export shapes; drop-ins accept only
 * the first two (`Workflow | Workflow[]`). The envelope form is rejected
 * for drop-ins so authors don't trip the silent "default lives somewhere
 * else" gotcha — the warning at `loadOverlayFile` covers any leaked
 * `default` from a Workflow that someone hand-shaped as `{ workflows, default }`.
 */
function normalizeDefaultExport(raw: unknown, kind: FileKind): NormalizeOk | NormalizeErr {
	if (isWorkflow(raw)) return { value: { workflows: [raw] } };
	if (Array.isArray(raw)) {
		if (raw.length === 0) {
			return { error: "default-export `Workflow[]` must contain at least one Workflow" };
		}
		if (!raw.every(isWorkflow)) {
			return { error: "default export array must contain only Workflow objects" };
		}
		// A bare Workflow[] omits the `default` slot; with more than one entry
		// there's no unambiguous pick. Require the envelope form so the choice
		// is explicit. (Single-entry arrays are accepted — only one workflow
		// to default to.) Drop-ins reject the envelope anyway, so a multi-entry
		// drop-in array gets the same hard error as a canonical one — that's
		// fine; the author should split into one file per workflow.
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
		if (kind === "drop-in") {
			return {
				error:
					"drop-in workflow files must export a `Workflow` or `Workflow[]` — the " +
					"`{ workflows, default? }` envelope is only accepted in the canonical workflows.config.ts.",
			};
		}
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
	path: string,
	workflowMap: Map<string, Workflow>,
	sources: Map<string, ConfigLayer>,
	sourcePaths: Map<string, string | undefined>,
): void {
	for (const w of parsed.workflows) {
		workflowMap.set(w.name, w);
		sources.set(w.name, layer);
		sourcePaths.set(w.name, path);
	}
}

/**
 * Project default wins over user default wins over built-in `mid`. An
 * explicit `default` that doesn't name an existing workflow records an
 * error and falls through to the next layer. Only the canonical file in
 * each layer can set `default` — drop-in `default` fields are stripped at
 * load time.
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
