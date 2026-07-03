/**
 * Skill-contract registry — global state, providers, and collision tracking.
 *
 * Owns the `Symbol.for`-anchored global slots for the contract registry, lazy
 * providers, failures, collisions, and ownership tracking. The registry is keyed
 * by RESOLVED post-alias skill name (`stage.skill ?? recordKey`), identical to
 * `ensureSkillRegistered` — so a stage's contract lookup follows aliasing for free.
 *
 * Companion modules:
 *   - harvest.ts     — harvestStageContracts + buildEffectiveContracts.
 *   - composition.ts — canCompose + legalNextSkills.
 *   - extension-points.ts — CompositionComparator + OutcomeDeriver registries (consumer extension points).
 */

import { deepEqual, globalSlot, lazyProviderRegistry } from "../internal-utils.js";
import type { SkillContract, SkillContractMap } from "../skill-contract.js";

const REGISTRY_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contracts");
const FAILURES_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contract-failures");
const COLLISIONS_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contract-collisions");
const OWNERS_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contract-owners");

const getRegistry = globalSlot(REGISTRY_KEY, () => new Map<string, SkillContract>());
/** name → owner label of whoever last registered it (for prune-on-reload + collision detection). */
const getOwners = globalSlot(OWNERS_KEY, () => new Map<string, string>());
const getCollisions = globalSlot(COLLISIONS_KEY, () => [] as string[]);
const getFailures = globalSlot(FAILURES_KEY, () => [] as unknown[]);

// Provider lifecycle via the shared `lazyProviderRegistry`. DELIBERATE
// divergence from the built-ins registry: `onError` RECORDS each provider
// throw (drained by `drainSkillContractProviderErrors`) instead of
// propagating. Contract providers read the filesystem / parse frontmatter
// (failure-prone), and `loadWorkflows` must honor its never-throws contract —
// a malformed source degrades to a partial/empty registry instead of crashing
// `/wf`, but the error is NOT swallowed silently: `loadWorkflows` surfaces it
// as a LoadIssue so a buggy provider is debuggable.
const providers = lazyProviderRegistry("@juicesharp/rpiv-workflow:skill-contract-providers", {
	onError: (err) => {
		getFailures().push(err);
	},
});

/**
 * Register one or more skill contracts, keyed by RESOLVED skill name — a flat
 * namespace SHARED by all consumers (the key must equal `stage.skill` for lookup,
 * so it can't be per-consumer-prefixed). Idempotent on name (re-register replaces).
 *
 * `owner` (optional consumer label, e.g. `"rpiv-pi"`) makes two real-world cases
 * safe:
 *   - prune-on-reload — an owner's call is treated as its FULL current
 *     snapshot: any name this owner previously registered but didn't include now
 *     (a skill deleted between `/reload`s) is dropped, so stale contracts don't
 *     linger. Other owners' entries are untouched.
 *   - collision surfacing — a DIFFERENT owner overwriting a name with a
 *     DIVERGENT contract is recorded (drained into a `LoadIssue` by
 *     `loadWorkflows`), turning a silent last-writer-wins into a visible warning.
 * Omit `owner` for the simple additive behaviour (no prune, no ownership claim).
 */
export function registerSkillContracts(contracts: Iterable<readonly [string, SkillContract]>, owner?: string): void {
	const registry = getRegistry();
	const owners = getOwners();
	const incoming = [...contracts];
	const incomingNames = new Set(incoming.map(([name]) => name));
	if (owner !== undefined) {
		for (const [name, prevOwner] of [...owners]) {
			if (prevOwner === owner && !incomingNames.has(name)) {
				registry.delete(name); // this owner dropped the skill — drop its contract
				owners.delete(name);
			}
		}
	}
	for (const [name, contract] of incoming) {
		const existing = registry.get(name);
		const prevOwner = owners.get(name);
		if (existing && prevOwner !== owner && !deepEqual(existing, contract)) {
			getCollisions().push(
				`skill "${name}": contract from ${owner ?? "an anonymous registrant"} overrides a divergent one from ${prevOwner ?? "an anonymous registrant"} (last writer wins)`,
			);
		}
		registry.set(name, contract);
		if (owner !== undefined) owners.set(name, owner);
		else owners.delete(name); // anonymous registration relinquishes any prior ownership claim
	}
}

/**
 * Register a LAZY contract provider. The thunk runs once, on the next
 * `flushSkillContractProviders()` (which `loadWorkflows` awaits before every
 * registry read), letting a sibling defer reading skill frontmatter off
 * startup and onto first `/wf`. Re-registration after `/reload` (Pi re-runs
 * extension entries; these slots survive on `globalThis`) is the supported
 * refresh path — the next load flushes the new provider, whose owner-scoped
 * `registerSkillContracts` call then prunes contracts for skills the owner
 * dropped since.
 */
export function registerSkillContractsProvider(provider: () => void | Promise<void>): void {
	providers.register(provider);
}

/**
 * Run every not-yet-run provider (each runs at most once; providers
 * registered after a flush run on the next one — see `lazyProviderRegistry`).
 * Concurrency-safe (callers await the same promise). Error posture:
 * recorded, not propagated — see the construction comment above.
 */
export function flushSkillContractProviders(): Promise<void> {
	return providers.flush();
}

/**
 * Drain (return + clear) the errors recorded by failed contract providers since
 * the last drain. `loadWorkflows` calls this right after the flush and maps each
 * into a `LoadIssue`, so a provider bug surfaces in `loaded.issues` instead of
 * vanishing. Internal — not on the public barrel.
 */
export function drainSkillContractProviderErrors(): unknown[] {
	return getFailures().splice(0);
}

/**
 * Drain (return + clear) the cross-owner collision messages recorded since the
 * last drain. `loadWorkflows` maps each into a `warning` `LoadIssue`.
 * Internal — not on the public barrel.
 */
export function drainSkillContractCollisions(): string[] {
	return getCollisions().splice(0);
}

/**
 * Read-only snapshot of the registry — consumed by `load/index.ts` + `buildRunContext`.
 * Returns a defensive copy so callers cannot mutate the shared global registry.
 */
export function getSkillContracts(): SkillContractMap {
	return new Map(getRegistry());
}

/**
 * Partial reset (registry + providers + collision state). The barrel's
 * `__resetSkillContracts` calls this plus `extension-points.__resetExtensionPoints`.
 */
export function __resetContractRegistry(): void {
	getRegistry().clear();
	providers.reset();
	getFailures().length = 0;
	getCollisions().length = 0;
	getOwners().clear();
}
