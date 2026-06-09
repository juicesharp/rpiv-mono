/**
 * Composition queries — can one skill's output feed another's input?
 *
 * Conservative structural compatibility checks using `isSchemaCompatible` for
 * the data channel and per-channel `CompositionComparator` for named-channel
 * reads. Returns `{ ok: true }` when either schema is absent/opaque
 * (not provably incompatible).
 */

import { isSchemaCompatible } from "../schema-compat.js";
import type { SchemaCompatResult, SkillContractMap } from "../skill-contract.js";
import { getCompositionComparators } from "./registries.js";
import { getSkillContracts } from "./registry.js";

/**
 * Can a producer skill's `produces.data` feed a consumer skill's `consumes.data`?
 * Conservative (via `isSchemaCompatible`): returns `{ ok: true }` when either
 * schema is absent/opaque (not provably incompatible).
 *
 * IMPORTANT: the default `contracts` is the GLOBAL registry
 * (`getSkillContracts()`), which holds only `declared` + `injected` contracts —
 * NOT the `harvested` ones, which exist solely on `LoadedWorkflows.skillContracts`
 * (built per load, never written back to the global). So the zero-arg call sees a
 * weaker map than the loader's own edge-compat pass and will degrade to
 * `{ ok: true }` for any harvest-only skill. For the effective (declared ⊕
 * harvested) view an agent should pass `loaded.skillContracts` explicitly.
 */
export function canCompose(
	producerSkill: string,
	consumerSkill: string,
	contracts: SkillContractMap = getSkillContracts(),
): SchemaCompatResult {
	const producerContract = contracts.get(producerSkill);
	const consumerContract = contracts.get(consumerSkill);
	// Data channel: a provable data mismatch is decisive.
	const producerData = producerContract?.produces?.data;
	const consumerData = consumerContract?.consumes?.data;
	if (producerData && consumerData) {
		const dataCompat = isSchemaCompatible(producerData, consumerData);
		if (!dataCompat.ok) return dataCompat;
	}
	// Named-channel (reads) compat: consult per-channel comparators for the
	// consumer's declared reads channels. Degrades to `{ ok: true }` when no comparator
	// is registered or the producer has no `produces` spec. Only adjudicates channels
	// where the consumer has explicitly declared a meta requirement (readSpec.meta
	// present) — without it there is no kind to compare, and invoking the comparator
	// for a channel the producer may not publish would be a false-reject risk for
	// multi-channel consumers like `revise` (reads ["plans","reviews"]).
	const produces = producerContract?.produces;
	const consumes = consumerContract?.consumes;
	if (produces && consumes?.reads) {
		const comparators = getCompositionComparators();
		for (const channel of Object.keys(consumes.reads)) {
			const comparator = comparators.get(channel);
			if (!comparator) continue;
			const readSpec = consumes.reads[channel];
			if (!readSpec?.meta) continue; // no declared kind requirement — degrade
			const compat = comparator(produces, consumes, channel);
			if (!compat.ok) return compat;
		}
	}
	return { ok: true };
}

/**
 * Every known skill whose `consumes` is not provably incompatible with `skill`'s
 * `produces` — the generator's search-space narrowing. Sorted for determinism.
 * Same default-map caveat as `canCompose`: pass `loaded.skillContracts` for
 * the effective (declared ⊕ harvested) view, else only declared/injected skills
 * are considered. Conservative by design — absent/opaque schemas count as
 * compatible, so this excludes only PROVABLE data-channel mismatches.
 */
export function legalNextSkills(skill: string, contracts: SkillContractMap = getSkillContracts()): string[] {
	const next: string[] = [];
	for (const candidate of contracts.keys()) {
		if (canCompose(skill, candidate, contracts).ok) next.push(candidate);
	}
	return next.sort();
}
