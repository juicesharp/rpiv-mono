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
 *   - registries.ts  — CompositionComparator + OutcomeDeriver registries.
 */

import { deepEqual, globalSlot } from "../internal-utils.js";
import type { SkillContract, SkillContractMap } from "../skill-contract.js";

const REGISTRY_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contracts");
const PROVIDERS_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contract-providers");
const FLUSH_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contract-flush");
const FAILURES_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contract-failures");
const COLLISIONS_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contract-collisions");
const OWNERS_KEY = Symbol.for("@juicesharp/rpiv-workflow:skill-contract-owners");

/** A lazy contributor of skill contracts — run once by `flushSkillContractProviders`. */
type SkillContractsProvider = () => void | Promise<void>;

const getRegistry = globalSlot(REGISTRY_KEY, () => new Map<string, SkillContract>());
const getProviders = globalSlot(PROVIDERS_KEY, () => [] as SkillContractsProvider[]);
/** name → owner label of whoever last registered it (for prune-on-reload + collision detection). */
const getOwners = globalSlot(OWNERS_KEY, () => new Map<string, string>());
const getCollisions = globalSlot(COLLISIONS_KEY, () => [] as string[]);
const getFailures = globalSlot(FAILURES_KEY, () => [] as unknown[]);

/** The memoised flush latch — a Promise once flushed, `undefined` before first flush / after reset. */
function getFlushLatch(): Promise<void> | undefined {
	return (globalThis as Record<symbol, unknown>)[FLUSH_KEY] as Promise<void> | undefined;
}

function setFlushLatch(latch: Promise<void> | undefined): void {
	(globalThis as Record<symbol, unknown>)[FLUSH_KEY] = latch;
}

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
 * Register a LAZY contract provider. The thunk runs once on the first
 * `flushSkillContractProviders()` (which `loadWorkflows` awaits), letting a
 * sibling defer reading skill frontmatter off startup and onto first `/wf`.
 * Register before the first read.
 */
export function registerSkillContractsProvider(provider: SkillContractsProvider): void {
	getProviders().push(provider);
}

/**
 * Run all pending providers once, then memoize. Concurrency-safe (callers await
 * the same promise). DELIBERATE divergence from `flushBuiltInProviders`: each
 * provider is wrapped so a throw is RECORDED (into the failures slot, drained by
 * `drainSkillContractProviderErrors`), not propagated. Contract providers read
 * the filesystem / parse frontmatter (failure-prone), and `loadWorkflows` must
 * honor its never-throws contract — a malformed source degrades to a
 * partial/empty registry instead of crashing `/wf`, but the error is NOT
 * swallowed silently: `loadWorkflows` surfaces it as a `LoadIssue` so a buggy
 * provider is debuggable. Built-in providers are trusted in-process code and so
 * don't need the guard.
 */
export function flushSkillContractProviders(): Promise<void> {
	const existing = getFlushLatch();
	if (existing) return existing;
	const pending = getProviders().splice(0);
	const flush = Promise.all(
		pending.map((p) =>
			Promise.resolve()
				.then(p)
				.catch((err) => {
					getFailures().push(err);
				}),
		),
	).then(() => undefined);
	setFlushLatch(flush);
	return flush;
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
 * `__resetSkillContracts` calls this plus `registries.__resetRegistries`.
 */
export function __resetRegistry(): void {
	getRegistry().clear();
	getProviders().length = 0;
	getFailures().length = 0;
	getCollisions().length = 0;
	getOwners().clear();
	setFlushLatch(undefined);
}
