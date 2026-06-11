/**
 * Harvest — derive skill contracts from how workflow stages USE a skill.
 *
 * The harvested contract is a best-effort cross-check / gap-fill source.
 * Lower authority than a declared frontmatter contract: the loader merges
 * declared OVER harvested. The harvestable surface is the `data` channel
 * (via `extractJsonSchema` on the stage's input/output schemas) plus the
 * framework-native `kind`/`reads`; the opaque `meta` bag is declared-only.
 */

import type { Workflow } from "../api.js";
import { isDispatchingStage, resolveSkill } from "../chain-state.js";
import { extractJsonSchema } from "../json-schema.js";
import type { ConsumesSpec, ProducesSpec, SkillContract } from "../skill-contract.js";
import { getSkillContracts } from "./registry.js";

/**
 * Derive a best-effort `harvested` contract per dispatched skill from how
 * workflow stages USE it — the cross-check / gap-fill source. Lower authority
 * than a declared frontmatter contract: the loader merges declared OVER
 * harvested. The harvestable surface is the `data` channel (via `extractJsonSchema`
 * on the stage's input/output schemas) plus the framework-native `kind`/`reads`;
 * the opaque `meta` bag (e.g. artifactKind) is declared-only — a collector is an
 * opaque function the framework can't introspect. When multiple stages
 * dispatch one skill with divergent schemas, last-writer wins for v1
 * (polymorphic union / drift detection deferred). Reuses `isDispatchingStage`
 * — the shared predicate the alias remap + no-op warning already agree on.
 *
 * LIMITATION: the `data` channel only harvests from schemas that expose
 * their JSON Schema as data — i.e. `typeboxSchema(...)` (and `jsonSchemaToStandard`
 * raw wraps). A stage authored with Zod / Valibot / Arktype has an OPAQUE
 * `~standard` (no `jsonSchema` Converter), so `extractJsonSchema` returns
 * `undefined` and that stage contributes no harvested `data` — only `kind`/`reads`.
 * Such a consumer gets the full benefit by DECLARING contracts (any source) instead
 * of relying on harvest. This is inherent to Standard-Schema adoption, not a bug;
 * it's surfaced (not silent) so authors know why a Zod stage shows no `data`.
 */
export function harvestStageContracts(workflows: readonly Workflow[]): Map<string, SkillContract> {
	const harvested = new Map<string, SkillContract>();
	for (const w of workflows) {
		for (const [stageName, stage] of Object.entries(w.stages)) {
			if (!isDispatchingStage(stage)) continue; // only /skill: stages dispatch a contract-bearing skill
			const skill = resolveSkill(stage, stageName);
			const producesData = extractJsonSchema(stage.outputSchema);
			const consumesData = extractJsonSchema(stage.inputSchema);
			const reads = stage.reads?.length ? Object.fromEntries(stage.reads.map((r) => [r, {}])) : undefined;
			const produces: ProducesSpec | undefined =
				stage.kind === "produces" || producesData
					? { kind: stage.kind, ...(producesData ? { data: producesData } : {}) } // real StageKind ("produces" | "side-effect")
					: undefined;
			const consumes: ConsumesSpec | undefined =
				consumesData || reads
					? { ...(consumesData ? { data: consumesData } : {}), ...(reads ? { reads } : {}) }
					: undefined;
			if (!produces && !consumes) continue;
			harvested.set(skill, {
				source: "harvested",
				...(produces ? { produces } : {}),
				...(consumes ? { consumes } : {}),
			});
		}
	}
	return harvested;
}

/**
 * Build the effective registry the loader hands to validation + the runner:
 * `harvested` gap-fill first, then `declared`/injected contracts override per
 * skill (declared outranks harvested). Returns a NEW map — never mutates the
 * shared global registry returned by `getSkillContracts()`. Co-located with
 * `harvestStageContracts` because the merge precedence is contract-domain logic,
 * not loader plumbing.
 */
export function buildEffectiveContracts(workflows: readonly Workflow[]): Map<string, SkillContract> {
	const effective = new Map(harvestStageContracts(workflows));
	for (const [name, contract] of getSkillContracts()) effective.set(name, contract);
	return effective;
}
