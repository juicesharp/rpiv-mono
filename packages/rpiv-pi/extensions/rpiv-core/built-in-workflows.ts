/**
 * Composition barrel for the built-in `/wf` workflows shipped with rpiv-pi.
 * Each workflow's `defineWorkflow` graph lives in its own module under
 * `./workflows/` — build / vet / polish / ship — wiring the cross-workflow
 * gate and prompt factories from `./workflows/shared.ts`; `metaWorkflow`
 * rides in from `./meta/presets.js`. This file only composes the array and
 * re-exports the ship fanout surface the tests import: the load specifier
 * (register-built-in-workflows.ts's guarded dynamic import) and the
 * `builtInWorkflows` named export are the stable contract.
 */

import type { Workflow } from "@juicesharp/rpiv-workflow/registration";
import { metaWorkflow } from "./meta/presets.js";
import { buildWorkflow } from "./workflows/build.js";
import { polishWorkflow } from "./workflows/polish.js";
import { shipWorkflow } from "./workflows/ship.js";
import { vetWorkflow } from "./workflows/vet.js";

export { SHIP_DIMENSION_FANOUT, SHIP_DIMENSIONS, shipGatePasses, shipVerdictOutcome } from "./built-ins/index.js";

// Position 0 is load-bearing: `build` is the default `/wf` workflow when no
// project/user config sets one (resolve-default.ts resolves
// `Map.keys().next().value`), so it MUST stay first in this array.
export const builtInWorkflows: readonly Workflow[] = [
	buildWorkflow,
	vetWorkflow,
	polishWorkflow,
	shipWorkflow,
	metaWorkflow,
];
