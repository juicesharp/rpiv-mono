/**
 * jiti-based loader for user-authored workflows.
 *
 * Layered merge: `built-in` ← `user` ← `project`. Within each non-built-in
 * layer, pack files merge first (alpha-sorted filename), then the
 * config file — so the file the user wrote by hand wins over any packs
 * they installed.
 *
 * Paths (per layer):
 *   user    — config  `~/.config/rpiv-workflow/config.ts`
 *             packs   `~/.config/rpiv-workflow/packs/*.ts`
 *   project — config  `<cwd>/.rpiv/workflows/config.ts`
 *             packs   `<cwd>/.rpiv/workflows/packs/*.ts`
 *
 * Config file — accepts three default-export shapes:
 *   1. A single `Workflow`               — single-entry namespace
 *   2. `Workflow[]`                      — multi-entry, default required if > 1
 *   3. `{ workflows, default? }`         — full envelope, explicit default
 *
 * Pack file — accepts only `Workflow | Workflow[]`. The envelope form
 * is rejected because `default` lives in the config file (one source of
 * truth per layer).
 *
 * `default` cascades layer-by-layer (project config > user config >
 * first registered workflow in insertion order). When no workflows are
 * registered at all, `default` is `undefined` and `command.ts` surfaces
 * a "no workflows registered" notify instead of running anything. Within
 * a layer only the config file can set `default`.
 *
 * jiti loads `.ts` directly — no build step required of users. Loader
 * failures (file throws on import, exports the wrong shape) are captured as
 * `LoadIssue`s; the loader itself never throws to its caller.
 *
 * SECURITY NOTE — `jiti.import` synchronously evaluates every overlay
 * file's top-level code on first load and on every edit (mtime-driven
 * invalidation via `cache.ts`). The threat boundary is the same as
 * `npm install` (post-install scripts), `tsx some-script.ts`, or any
 * tool that respects `<cwd>` configuration: Pi already operates in a
 * context that implicitly trusts the current working directory. Users
 * running Pi in a freshly-cloned untrusted repo should diff
 * `.rpiv/workflows/config.ts` and `.rpiv/workflows/packs/*.ts`
 * (the config file + pack files) before running `/wf`.
 *
 * Module map:
 *   ./issues.ts           — LoadIssue + Issue (the layer/path-attributed wrapper)
 *   ./skill-contract-phase.ts — provider flush/drain + effective registry + derivers
 *   ./paths.ts            — OverlayPaths + per-layer path helpers
 *   ./shape-guards.ts     — isWorkflow, isEnvelope, describe
 *   ./normalize.ts        — normalizeDefaultExport + NormalizeResult
 *   ./merge.ts            — LoadAccumulator, LayerOutcome, loadLayer, mergeOverlay, loadError
 *   ./legacy.ts           — legacy-layout advisories (notices + probes)
 *   ./resolve-default.ts  — resolveDefault (first-workflow fallback)
 *   ./cache.ts            — mtime-keyed jiti import cache + __resetLoadCache
 */

import type { Workflow } from "../api.js";
import { flushBuiltInProviders, getBuiltIns } from "../built-ins.js";
import type { ConfigLayer } from "../layers.js";
import type { SkillContractMap } from "../skill-contract.js";
import { validateWorkflow } from "../validate-workflow.js";
import { applySkillAliases } from "./alias.js";
import type { Issue } from "./issues.js";
import { pushLegacyNotices } from "./legacy.js";
import { type LoadAccumulator, loadLayer } from "./merge.js";
import { projectOverlayPaths, userOverlayPaths } from "./paths.js";
import { resolveDefault } from "./resolve-default.js";
import { applySkillContractPhase } from "./skill-contract-phase.js";

// ===========================================================================
// Public types
// ===========================================================================

export type { ConfigLayer } from "../layers.js";
export { aliasSkills } from "./alias.js";
export { __resetLoadCache } from "./cache.js";
export type { Issue, LoadIssue, LoadIssueOrigin } from "./issues.js";
export type { OverlayPaths } from "./paths.js";
export { projectOverlayPaths, userOverlayPaths } from "./paths.js";

export interface LoadedWorkflows {
	workflows: readonly Workflow[];
	/**
	 * Resolved default workflow name. `undefined` when no layer registered any
	 * workflows — consumers must handle this (see `command.ts`'s
	 * "no workflows registered" path).
	 */
	default: string | undefined;
	/** Which layer each merged workflow name came from. */
	workflowSources: ReadonlyMap<string, ConfigLayer>;
	/** Every layer that registered at least one workflow, low-to-high. */
	layers: readonly ConfigLayer[];
	/** Aggregated load + validation issues. Errors block the runner; warnings are advisory. */
	issues: readonly Issue[];
	/**
	 * The merged, applied skill-alias map (project over user, per-key) — always
	 * present, `{}` when no layer declared `skillAliases`. `/wf` preview renders
	 * this as a banner; every dispatching stage in `workflows` already reflects
	 * the remap.
	 */
	skillAliases: Readonly<Record<string, string>>;
	/**
	 * Effective skill-contract registry: injected `declared` contracts merged
	 * OVER `harvested` ones (derived from stage usage). Required field, empty
	 * `Map` when no contract was declared or harvestable.
	 */
	skillContracts: SkillContractMap;
}

// ===========================================================================
// Public lookup helpers
// ===========================================================================

/**
 * Lookup a workflow by name in a merged `LoadedWorkflows`. Anticipates
 * the "rerun by name" / `listRuns` past-runs API that will share the
 * lookup; consolidated here so future callers don't reach back into
 * `loaded.workflows.find(...)` ad-hoc.
 */
export function findWorkflow(loaded: LoadedWorkflows, name: string): Workflow | undefined {
	return loaded.workflows.find((w) => w.name === name);
}

// ===========================================================================
// Orchestrator
// ===========================================================================

/**
 * Load every active layer, merge by workflow name, validate, and return the
 * resolved set. Never throws — load + validation errors flow through `issues`.
 */
export async function loadWorkflows(cwd: string): Promise<LoadedWorkflows> {
	// Flush lazy built-in providers before reading the registry — lets siblings
	// defer constructing definitions to first `/wf` (the earliest reader).
	await flushBuiltInProviders();

	const acc: LoadAccumulator = {
		issues: [],
		workflowMap: new Map(),
		sources: new Map(),
		sourcePaths: new Map(),
	};
	const layers: ConfigLayer[] = getBuiltIns().length > 0 ? ["built-in"] : [];

	for (const w of getBuiltIns()) {
		acc.workflowMap.set(w.name, w);
		acc.sources.set(w.name, "built-in");
		acc.sourcePaths.set(w.name, undefined);
	}

	const userPaths = userOverlayPaths();
	const userOutcome = await loadLayer(userPaths, "user", acc);
	if (userOutcome.contributed) layers.push("user");

	const projectOutcome = await loadLayer(projectOverlayPaths(cwd), "project", acc);
	if (projectOutcome.contributed) layers.push("project");

	// One-time legacy migration advisories — each independent, each a warning
	// (advisory, never blocks the run). The new `.rpiv/workflows/` (project) and
	// `~/.config/rpiv-workflow/config.ts` (user) locations are the only ones
	// read; these probes point the user at each move so nothing is silently
	// ignored / stranded.
	pushLegacyNotices(cwd, userPaths, acc);

	// Merge + apply skill aliases (project overrides user per key) to every
	// workflow — built-ins included — BEFORE the validation loop, so the
	// aliased workflows are validated and preview / JSONL / the runtime
	// skill-registry preflight all observe the final skill. The runner is
	// untouched. No-op warnings attribute to the source layer that actually
	// declared the key — see `applySkillAliases` in `./alias.ts`.
	const skillAliases = applySkillAliases(acc, userOutcome, projectOutcome);

	// Skill-contract phase: flush providers, surface their failures +
	// collisions (attributed to "framework", not a config layer), build the
	// effective registry, run outcome derivers on per-load stage copies. Must
	// precede validation — see `./skill-contract-phase.ts`.
	const skillContracts = await applySkillContractPhase(acc);

	// Validate every merged workflow once. Validation runs even on built-in so
	// that a future built-in regression surfaces in the same channel as user
	// errors. Each issue is attributed to the exact file the surviving workflow
	// came from (pack or config) so `/wf` previews can render
	// `[<layer> config (<path>)] workflow "X": ...` errors.
	for (const w of acc.workflowMap.values()) {
		const layer = acc.sources.get(w.name) ?? "built-in";
		const path = acc.sourcePaths.get(w.name);
		for (const v of validateWorkflow(w, { skillContracts }))
			acc.issues.push({ ...v, kind: "validation", layer, path });
	}

	const defaultName = resolveDefault(projectOutcome.configDefault, userOutcome.configDefault, acc);

	return {
		workflows: [...acc.workflowMap.values()],
		default: defaultName,
		workflowSources: acc.sources,
		layers,
		issues: acc.issues,
		skillAliases,
		skillContracts,
	};
}
