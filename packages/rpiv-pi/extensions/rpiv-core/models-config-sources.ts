/**
 * models-config-sources — shared key-universe gatherers for the models.json
 * surfaces. Used by the /rpiv-models picker (to populate pickers) and the
 * session_start warn-on-miss validator (to detect typo'd keys).
 *
 *   - bundledAgentNames(): agent keys      ← BUNDLED_AGENTS_DIR readdir
 *   - skillCommandNames(pi): skill keys    ← pi.getCommands() source==="skill"
 *   - loadWorkflowMap(cwd): workflow→stages ← rpiv-workflow loadWorkflows
 */

import { readdirSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BUNDLED_AGENTS_DIR } from "./paths.js";

/** Bundled-agent names (filenames sans `.md`), sorted. `[]` if the dir is unreadable. */
export function bundledAgentNames(): string[] {
	try {
		return readdirSync(BUNDLED_AGENTS_DIR)
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.slice(0, -3))
			.sort();
	} catch {
		return [];
	}
}

/** Registered skill names (post `skill:` prefix strip), sorted — live registry. */
export function skillCommandNames(pi: ExtensionAPI): string[] {
	return pi
		.getCommands()
		.filter((c: { source?: string }) => c.source === "skill")
		.map((c: { name: string }) => (c.name.startsWith("skill:") ? c.name.slice("skill:".length) : c.name))
		.sort();
}

/** Map workflow name → sorted stage names. */
export async function loadWorkflowMap(cwd: string): Promise<Record<string, string[]>> {
	// rpiv-workflow's `loadWorkflows` returns `{ workflows: [] }` for the
	// no-sibling case (does NOT throw), so an `isModuleNotFound` catch would
	// be unreachable AND would silently swallow genuine load failures. Real
	// errors propagate to the caller, which decides how to surface them.
	// Runner-free `/registration` entry — only the loader is needed, never the
	// ~530ms engine.
	const wf = await import("@juicesharp/rpiv-workflow/registration");
	const loaded = await wf.loadWorkflows(cwd);
	const map: Record<string, string[]> = {};
	for (const w of loaded.workflows) {
		map[w.name] = Object.keys(w.stages ?? {}).sort();
	}
	return map;
}
