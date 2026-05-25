/**
 * Default workflow resolution. Project default wins over user default
 * wins over the historic `FALLBACK_DEFAULT_WORKFLOW = "mid"` sentinel;
 * if no candidate matches, the first workflow in insertion order is
 * returned.
 *
 * Only the canonical file in each layer can set `default` — drop-in
 * `default` fields are hard-rejected at normalisation. An explicit
 * `default` that doesn't name an existing workflow records an error
 * and falls through to the next layer.
 *
 * The `FALLBACK_DEFAULT_WORKFLOW = "mid"` constant encodes a historic
 * rpiv-pi-specific bias; removal rides with Phase 11 (L3-03) — a matched
 * rpiv-pi PR will register its preferred default via the envelope at
 * extension load time.
 */

import type { ConfigLayer } from "../layers.js";
import { type LoadAccumulator, loadError } from "./merge.js";

/** Default workflow name when no overlay specifies one — matches the historic "mid". */
export const FALLBACK_DEFAULT_WORKFLOW = "mid";

export function resolveDefault(
	projectDefault: string | undefined,
	userDefault: string | undefined,
	acc: LoadAccumulator,
): string {
	const candidates: Array<{ name: string | undefined; layer: ConfigLayer }> = [
		{ name: projectDefault, layer: "project" },
		{ name: userDefault, layer: "user" },
	];

	for (const { name, layer } of candidates) {
		if (!name) continue;
		if (acc.workflowMap.has(name)) return name;
		loadError(acc, layer, undefined, `default workflow "${name}" (from ${layer} config) is not declared`);
	}

	if (acc.workflowMap.has(FALLBACK_DEFAULT_WORKFLOW)) return FALLBACK_DEFAULT_WORKFLOW;

	// Last resort: first workflow we have. workflowMap is non-empty when at
	// least one layer (built-in or overlay) contributed.
	const first = acc.workflowMap.keys().next().value;
	return first ?? FALLBACK_DEFAULT_WORKFLOW;
}
