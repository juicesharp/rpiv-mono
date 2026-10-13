/**
 * Snapshot of which SIBLINGS are loaded in this process — the runtime half of
 * sibling detection (#216); package-checks.ts unions it with the settings file.
 * Reads a structural slice of `ExtensionAPI`, so it imports no Pi value.
 */

import type { LoadedSiblingSources } from "./package-checks.js";
import { SIBLINGS } from "./siblings.js";

/** The structural slice of `ExtensionAPI` the snapshot reads (Pi ≥ 0.80.1 carries `sourceInfo` on both). */
export interface LoadedSourcesReader {
	getAllTools(): ReadonlyArray<{ sourceInfo?: { path?: string } }>;
	getCommands(): ReadonlyArray<{ source?: string; sourceInfo?: { path?: string } }>;
}

/**
 * Snapshot what is loaded right now. Call after extensions have loaded
 * (session_start, a command handler). Only extension commands count — a skill
 * or prompt file whose path happens to contain a sibling's name proves nothing.
 * Fail-soft: an unexpected host shape yields an empty snapshot, which reduces
 * detection to the settings-only rule.
 */
export function readLoadedSiblingSources(pi: LoadedSourcesReader): LoadedSiblingSources {
	const extensionPaths: string[] = [];
	try {
		for (const tool of pi.getAllTools()) {
			if (tool.sourceInfo?.path) extensionPaths.push(tool.sourceInfo.path);
		}
		for (const command of pi.getCommands()) {
			if (command.source === "extension" && command.sourceInfo?.path) extensionPaths.push(command.sourceInfo.path);
		}
	} catch {
		extensionPaths.length = 0;
	}
	const markers = new Set<string>();
	const slots = globalThis as Record<symbol, unknown>;
	for (const s of SIBLINGS) {
		if (s.marker && slots[Symbol.for(s.marker)] !== undefined) markers.add(s.marker);
	}
	return { extensionPaths, markers };
}
