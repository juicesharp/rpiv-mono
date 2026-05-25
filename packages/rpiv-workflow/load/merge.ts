/**
 * Per-layer + per-file loading and merge. Owns the `LoadAccumulator`
 * struct (mutable bag of state threaded through the layer/file/merge
 * helpers) and the `LayerOutcome` return shape.
 *
 * `loadLayer` walks the drop-in directory then the canonical file,
 * calling `mergeOverlay` for each successful parse. `mergeOverlay`
 * writes into the accumulator's maps in place — the canonical file's
 * workflows win over drop-ins of the same name because the canonical
 * pass runs second.
 *
 * Load-error issues construct via `loadError` so the `Issue` shape is
 * centralised.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Workflow } from "../api.js";
import type { ConfigLayer } from "../layers.js";
import { cachedImport } from "./cache.js";
import type { Issue } from "./index.js";
import { type FileKind, normalizeDefaultExport, type ParsedConfig } from "./normalize.js";
import type { OverlayPaths } from "./paths.js";
import { formatError } from "./shape-guards.js";

/**
 * Mutable bag of state threaded through `loadLayer` → `loadOverlayFile`
 * → `mergeOverlay`. Each helper writes into `acc.issues` /
 * `acc.workflowMap` / `acc.sources` / `acc.sourcePaths` in place;
 * `loadWorkflows` reads them at the end to project the public
 * `LoadedWorkflows` envelope.
 *
 * Lives in a struct so future loader features add fields here rather
 * than threading another mutable parameter through three call layers.
 */
export interface LoadAccumulator {
	issues: Issue[];
	workflowMap: Map<string, Workflow>;
	sources: Map<string, ConfigLayer>;
	sourcePaths: Map<string, string | undefined>;
}

/**
 * What a per-layer load returns to the orchestrator. `contributed`
 * controls the `LoadedWorkflows.layers` banner; `canonicalDefault`
 * feeds `resolveDefault` (drop-in files don't set defaults — see
 * `normalizeDefaultExport`'s drop-in hard-reject).
 */
export interface LayerOutcome {
	contributed: boolean;
	canonicalDefault: string | undefined;
}

export function loadError(acc: LoadAccumulator, layer: ConfigLayer, path: string | undefined, message: string): void {
	acc.issues.push({ kind: "load", layer, path, severity: "error", message });
}

/**
 * Load one layer's drop-ins (alpha-sorted) then its canonical file, merging
 * into the accumulator in that order so the canonical file's workflows win
 * over drop-ins of the same name. The returned `LayerOutcome.canonicalDefault`
 * carries the canonical file's `default` field (or `undefined`) — drop-in
 * `default` fields are rejected at normalisation, so they never participate
 * in default resolution.
 *
 * `LayerOutcome.contributed` is `false` only when neither the canonical
 * file nor any drop-in existed; that signals to `loadWorkflows` not to
 * append the layer to the `layers` banner.
 */
export async function loadLayer(paths: OverlayPaths, layer: ConfigLayer, acc: LoadAccumulator): Promise<LayerOutcome> {
	let contributed = false;
	let canonicalDefault: string | undefined;

	for (const dropInPath of enumerateDropIns(paths.dropInDir)) {
		const parsed = await loadOverlayFile(dropInPath, layer, acc, "drop-in");
		if (!parsed) continue;
		mergeOverlay(parsed, layer, dropInPath, acc);
		contributed = true;
	}

	if (existsSync(paths.canonical)) {
		const canonicalParsed = await loadOverlayFile(paths.canonical, layer, acc, "canonical");
		if (canonicalParsed) {
			mergeOverlay(canonicalParsed, layer, paths.canonical, acc);
			canonicalDefault = canonicalParsed.default;
			contributed = true;
		}
	}

	return { contributed, canonicalDefault };
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

async function loadOverlayFile(
	path: string,
	layer: ConfigLayer,
	acc: LoadAccumulator,
	kind: FileKind,
): Promise<ParsedConfig | undefined> {
	let raw: unknown;
	try {
		raw = await cachedImport(path);
	} catch (e) {
		loadError(acc, layer, path, `failed to import ${path}: ${formatError(e)}`);
		return undefined;
	}

	const parsed = normalizeDefaultExport(raw, kind);
	if (parsed.kind === "err") {
		loadError(acc, layer, path, parsed.error);
		return undefined;
	}
	return parsed.value;
}

function mergeOverlay(parsed: ParsedConfig, layer: ConfigLayer, path: string, acc: LoadAccumulator): void {
	for (const w of parsed.workflows) {
		acc.workflowMap.set(w.name, w);
		acc.sources.set(w.name, layer);
		acc.sourcePaths.set(w.name, path);
	}
}
