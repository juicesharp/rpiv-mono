/**
 * verdict-outcome — the verdict channel factory every grade/confirm stage
 * shares: `name` is the `state.named` channel the stage's verdicts publish
 * under (slice-verdicts / plan-verdicts / code-verdicts / ship-verdicts), and
 * `sourceChannel` is the channel carrying the artifact under judgment — the
 * disk-first verdict collector resolves the verdict filename's
 * `<basename>__` segment from it. The parser MUST stay — by reference, the
 * parser itself, never a wrapper: when a stage declares no parser, the
 * extraction fallback publishes `data = artifacts` (the raw `Artifact[]` as
 * channel data), which the gate folds' latestChannelData reads and the
 * contract-schema validation both reject.
 *
 * Collection is DISK-FIRST (the grade skill's `<basename>__<dimension>__*.json`
 * naming contract): the newest verdict file written since the unit's snapshot
 * wins; the transcript scan (text + write tool-arguments) is the fallback, and
 * a single composite fatal fires only when all three surfaces miss.
 *
 * Main's shared-instance shape: the factory's returned objects are STATELESS
 * per dispatch (the disk snapshot is captured by the runner per stage-unit and
 * threaded through `ctx`, never stored on the collector), so a grade stage and
 * its confirm twin may share one instance per channel.
 */

import { jsonBodyParser, type Outcome } from "@juicesharp/rpiv-workflow/registration";
import { VERDICT_DIR } from "./shared.js";
import { verdictCollector } from "./verdict-collector.js";

/**
 * The verdict outcome factory: one instance per channel, over the channel
 * carrying the artifact it grades.
 */
export const verdictOutcome = (name: string, sourceChannel: string): Outcome<unknown, "json", unknown> => ({
	name,
	collector: verdictCollector({ dir: VERDICT_DIR, sourceChannel }),
	parser: jsonBodyParser,
});
