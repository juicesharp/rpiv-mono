/**
 * Shared layer-vocabulary for the workflow loader + validator.
 *
 * Lives in its own module so `load.ts` (loader / merge) and `validate-workflow.ts`
 * (issue attribution) can both reference the same union without a circular
 * import. `load.ts` depends on `validate-workflow.ts` for `validateWorkflow`, so
 * declaring `ConfigLayer` here keeps the dependency direction strict and
 * eliminates the silent-drift risk of two parallel string-literal unions.
 */

import { assertNever } from "./internal-utils.js";

export type ConfigLayer = "built-in" | "user" | "project";

/**
 * Single source for layer → display string. Wrap every interpolation site
 * (`${layer}` in template strings, banner builders, issue prefixes) in this
 * helper so adding a new `ConfigLayer` value surfaces as a compile error at
 * every consumer, not just at the loader's switch. The current display
 * form is the layer name verbatim — keep that invariant if you change it.
 */
export function renderConfigLayer(layer: ConfigLayer): string {
	switch (layer) {
		case "built-in":
			return "built-in";
		case "user":
			return "user";
		case "project":
			return "project";
		default:
			return assertNever(layer);
	}
}
