/**
 * The loader's skill-contract phase — everything between "workflows are
 * merged + aliased" and "validation runs": flush the lazy contract
 * providers, surface their recorded failures and cross-owner collisions,
 * build the effective registry (declared ⊕ harvested), and invoke the
 * registered outcome derivers against per-load stage copies.
 *
 * Extracted from `loadWorkflows` so the orchestrator reads as a
 * sequence of phases. Every issue this phase emits is attributed to
 * `"framework"` — these are failures of provider/deriver machinery, not of
 * any config file.
 */

import { formatError } from "../internal-utils.js";
import type { SkillContractMap } from "../skill-contract.js";
import {
	buildEffectiveContracts,
	drainSkillContractCollisions,
	drainSkillContractProviderErrors,
	flushSkillContractProviders,
	getBucketKindMappings,
	getOutcomeDerivers,
} from "../skill-contracts/index.js";
import type { LoadAccumulator } from "./merge.js";

/**
 * Run the phase against the merged accumulator. Mutates `acc` (issues +
 * per-load stage copies when derivers will run) and returns the effective
 * contract registry the validation loop and the runner consume.
 *
 * Must run BEFORE the validation loop: `checkEdgeSchemaCompat` needs the
 * registry, and derivers must have wired `outcome`s before the
 * produces-without-outcome rule fires.
 */
export async function applySkillContractPhase(acc: LoadAccumulator): Promise<SkillContractMap> {
	// Flush lazy contract providers before reading the registry. Each provider
	// throw was RECORDED (not propagated) — drain and surface as issues so the
	// loader keeps its never-throws contract without swallowing the failure.
	await flushSkillContractProviders();
	for (const err of drainSkillContractProviderErrors()) {
		acc.issues.push({
			kind: "load",
			layer: "framework",
			message: `skill-contract provider failed: ${formatError(err)}`,
			severity: "warning",
		});
	}
	// Cross-owner contract collisions — last-writer still wins, but the
	// divergence is no longer silent.
	for (const message of drainSkillContractCollisions()) {
		acc.issues.push({ kind: "load", layer: "framework", message, severity: "warning" });
	}

	// Effective registry: a NEW map (harvested gap-fill first, declared
	// overriding per skill) — never mutates the shared global registry.
	const skillContracts = buildEffectiveContracts([...acc.workflowMap.values()]);

	// Deriver mutations (`stage.outcome = ...`) must land on PER-LOAD copies,
	// never on shared sources: built-ins live in a process-global registry and
	// unchanged overlay files come back BY REFERENCE from the mtime cache, so an
	// in-place mutation would pin this load's derived outcome onto every future
	// load — the deriver's `if (stage.outcome) continue` idempotency guard would
	// then skip re-derivation even after a contract change. Shallow-copy each
	// workflow's stage records first (same `{...stage}` copy `aliasSkills` uses).
	if (getOutcomeDerivers().length > 0) {
		for (const [name, w] of acc.workflowMap) {
			acc.workflowMap.set(name, {
				...w,
				stages: Object.fromEntries(Object.entries(w.stages).map(([k, s]) => [k, { ...s }])),
			});
		}
	}
	for (const deriver of getOutcomeDerivers()) {
		try {
			deriver(
				acc.workflowMap.values(),
				skillContracts,
				(message, severity) => {
					acc.issues.push({ kind: "load", layer: "framework", severity, message });
				},
				getBucketKindMappings(),
			);
		} catch (err) {
			acc.issues.push({
				kind: "load",
				layer: "framework",
				severity: "error",
				message: `outcome deriver failed: ${formatError(err)}`,
			});
		}
	}

	return skillContracts;
}
