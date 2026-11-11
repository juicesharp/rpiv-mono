/**
 * Extension points — composition comparator and outcome deriver registries.
 *
 * Per-channel `CompositionComparator` and `OutcomeDeriverFn` registries,
 * both anchored on `Symbol.for` global slots (same pattern as `registry.ts`).
 */

import type { Workflow } from "../api.ts";
import { globalSlot } from "../internal-utils.ts";
import type { CompositionComparator, SkillContractMap } from "../skill-contract.ts";

const COMPARATORS_KEY = Symbol.for("@juicesharp/rpiv-workflow:composition-comparators");
const DERIVERS_KEY = Symbol.for("@juicesharp/rpiv-workflow:outcome-derivers");
const BUCKETS_KEY = Symbol.for("@juicesharp/rpiv-workflow:bucket-kind-mappings");

/**
 * A callback that derives `Outcome` outcomes for `produces` stages from the
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
 *
 * `bucketKindMappings` is the consumer-registered `artifactKind → bucket`
 * extension table (see `registerBucketKindMapping`), passed by the loader so
 * derivers stay pure functions of their arguments.
 */
export type OutcomeDeriverFn = (
	workflows: Iterable<Workflow>,
	skillContracts: SkillContractMap,
	onIssue: (message: string, severity: "error" | "warning") => void,
	bucketKindMappings: ReadonlyMap<string, string>,
) => void;

/** channel name → consumer-supplied composition comparator. */
export const getCompositionComparators = globalSlot(COMPARATORS_KEY, () => new Map<string, CompositionComparator>());

/**
 * Register a per-channel composition comparator. The framework invokes the
 * comparator through the ONE shared `adjudicateChannel` rule (composition.ts)
 * for any consumer that declares `consumes.reads[channelName]` with a `meta`
 * requirement, but never interprets the `meta` it compares —
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
 * Register an outcome deriver — a callback that auto-wires `Outcome`
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
 * with the merged workflow map and effective skill contracts. The loader
 * shallow-copies every workflow's stage records BEFORE invoking derivers, so
 * deriver mutations land on per-load copies — never on shared built-ins or
 * mtime-cached overlay objects — and a contract change between loads always
 * re-derives. The deriver is idempotent (`if (stage.outcome) continue`), so
 * re-running on already-derived stages is safe. Internal — not on the public
 * barrel.
 */
export function getOutcomeDerivers(): OutcomeDeriverFn[] {
	return getDerivers();
}

/** Live registry slot — module-private; all mutation goes through the registrars below. */
const getLiveBucketKindMappings = globalSlot(BUCKETS_KEY, () => new Map<string, string>());

/**
 * artifactKind → bucket name mappings registered by consumers. Returns a
 * defensive copy (same posture as `getSkillContracts`) — mutating the result
 * does not touch the registry; use `registerBucketKindMapping`.
 */
export function getBucketKindMappings(): Map<string, string> {
	return new Map(getLiveBucketKindMappings());
}

/**
 * Register a mapping from an artifactKind to a bucket name for outcome
 * derivation. Extends the hardcoded BUCKET_BY_KIND table — user-installed
 * skills with novel artifactKind values can register their own mappings.
 * Idempotent on artifactKind (re-register replaces). Anchored on a
 * `Symbol.for` slot like the rest of the registry, so it survives Pi's
 * double module-load.
 */
export function registerBucketKindMapping(artifactKind: string, bucket: string): void {
	getLiveBucketKindMappings().set(artifactKind, bucket);
}

/**
 * Partial reset (comparator + deriver + bucket-kind registries). The barrel's
 * `__resetSkillContracts` calls `__resetContractRegistry` plus this.
 */
export function __resetExtensionPoints(): void {
	getCompositionComparators().clear();
	getDerivers().length = 0;
	getLiveBucketKindMappings().clear();
}
