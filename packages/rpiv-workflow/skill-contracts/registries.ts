/**
 * Composition comparator and outcome deriver registries.
 *
 * Per-channel `CompositionComparator` and `OutcomeDeriverFn` registries,
 * both anchored on `Symbol.for` global slots (same pattern as `registry.ts`).
 */

import type { Workflow } from "../api.js";
import { globalSlot } from "../internal-utils.js";
import type { CompositionComparator, SkillContractMap } from "../skill-contract.js";

const COMPARATORS_KEY = Symbol.for("@juicesharp/rpiv-workflow:composition-comparators");
const DERIVERS_KEY = Symbol.for("@juicesharp/rpiv-workflow:outcome-derivers");

/**
 * A callback that derives `OutputSpec` outcomes for `produces` stages from the
 * skill contract registry. Registered by a consumer (e.g. rpiv-pi) that owns
 * the ontology (the `artifactKind → bucket` normalization table). The loader
 * invokes drained derivers after `buildEffectiveContracts` and before the
 * validation loop, so derived outcomes satisfy the `produces`-without-`outcome`
 * guard.
 *
 * Implementations mutate `stage.outcome` in place on stages that lack an
 * explicit outcome. The framework stays ontology-blind — it never reads
 * `meta.artifactKind` itself.
 *
 * `onIssue` lets the deriver report warnings (e.g. user-defined workflow with
 * missing artifactKind). The callback maps directly to `acc.issues.push(...)`;
 * the deriver only populates `message` and `severity` — the loader sets `kind`
 * and `layer`.
 */
export type OutcomeDeriverFn = (
	workflows: Iterable<Workflow>,
	skillContracts: SkillContractMap,
	onIssue: (message: string, severity: "error" | "warning") => void,
) => void;

/** channel name → consumer-supplied composition comparator. */
export const getCompositionComparators = globalSlot(COMPARATORS_KEY, () => new Map<string, CompositionComparator>());

/**
 * Register a per-channel composition comparator. The framework invokes the
 * comparator at all three adjudication points for any consumer that declares
 * `consumes.reads[channelName]`, but never interprets the `meta` it compares —
 * the channel's ontology is the consumer's. Per-channel
 * (not a single global comparator) so different consumers own different channels
 * without collision. Idempotent on channel name (re-register replaces). Anchored
 * on a `Symbol.for` slot like the rest of the registry, so it survives Pi's
 * double module-load.
 */
export function registerCompositionComparator(channelName: string, comparator: CompositionComparator): void {
	getCompositionComparators().set(channelName, comparator);
}

const getDerivers = globalSlot(DERIVERS_KEY, () => [] as OutcomeDeriverFn[]);

/**
 * Register an outcome deriver — a callback that auto-wires `OutputSpec`
 * outcomes onto `produces` stages from the skill contract registry. The
 * loader drains and invokes all registered derivers after
 * `buildEffectiveContracts` and before the validation loop. Register before
 * the first `/wf load`.
 *
 * rpiv-pi uses this to derive `rpivBucketOutcome(bucket)` from
 * `produces.meta.artifactKind` via its `BUCKET_BY_KIND` normalization table,
 * keeping the framework ontology-blind.
 */
export function registerOutcomeDeriver(deriver: OutcomeDeriverFn): void {
	getDerivers().push(deriver);
}

/**
 * Peek at registered outcome derivers (non-draining). `loadWorkflows` calls
 * this on every load after `buildEffectiveContracts` and invokes each deriver
 * with the merged workflow map and effective skill contracts. Derivers must
 * re-run on every load because their effects (mutating `stage.outcome`) live
 * on per-load workflow objects — fresh objects from cache re-imports carry no
 * outcome. The deriver is idempotent (`if (stage.outcome) continue`), so
 * re-running on already-derived stages is safe. Internal — not on the public
 * barrel.
 */
export function getOutcomeDerivers(): OutcomeDeriverFn[] {
	return getDerivers();
}

/**
 * Partial reset (comparator + deriver registries). The barrel's
 * `__resetSkillContracts` calls `__resetRegistry` plus this.
 */
export function __resetRegistries(): void {
	getCompositionComparators().clear();
	getDerivers().length = 0;
}
