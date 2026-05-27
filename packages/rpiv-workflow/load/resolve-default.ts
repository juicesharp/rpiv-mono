/**
 * Default workflow resolution. Project config default wins over user
 * config default; if neither layer set one, the first workflow in
 * insertion order (low-to-high layer: built-in → user → project) is
 * returned. When no workflows are registered at all, returns `undefined`
 * — `command.ts` surfaces this as a "no workflows registered" notify
 * rather than running anything.
 *
 * Only the config file in each layer can set `default` — pack
 * `default` fields are hard-rejected at normalisation. An explicit
 * `default` that doesn't name an existing workflow records an error and
 * falls through to the next layer.
 *
 * Historic note: this used to fall back to a hard-coded `"mid"` sentinel,
 * which encoded an rpiv-pi-specific bias inside a skill-agnostic package.
 * Siblings that want to ship a preferred default set it via the
 * config-file envelope at their own load time.
 */

import type { ConfigLayer } from "../layers.js";
import { type LoadAccumulator, loadError } from "./merge.js";

export function resolveDefault(
	projectDefault: string | undefined,
	userDefault: string | undefined,
	acc: LoadAccumulator,
): string | undefined {
	const candidates: Array<{ name: string | undefined; layer: ConfigLayer }> = [
		{ name: projectDefault, layer: "project" },
		{ name: userDefault, layer: "user" },
	];

	for (const { name, layer } of candidates) {
		if (!name) continue;
		if (acc.workflowMap.has(name)) return name;
		loadError(acc, layer, undefined, `default workflow "${name}" (from ${layer} config) is not declared`);
	}

	// Last resort: first workflow in insertion order. `Map.keys().next().value`
	// is `undefined` for an empty map — callers must handle the "no workflows
	// registered" case explicitly.
	return acc.workflowMap.keys().next().value;
}
