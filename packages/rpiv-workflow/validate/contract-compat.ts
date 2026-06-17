/**
 * Contract / schema compatibility checks — the validator's only modules that
 * reach into the skill-contract domain (`adjudicateChannel`,
 * `compareDataChannel`, comparator registry) and the JSON-Schema bridge.
 * Kept apart from `stage-rules.ts` because the dependency footprint is
 * entirely different: these checks need the effective contract registry; the
 * stage rules need only the stage records.
 *
 * Enforcement layers (where each contract channel is adjudicated):
 *   - reads / wiring  → LOAD-TIME, complete (`checkReadsChannelCompat`, all
 *                       publishers, errors on signed mismatch — all stage kinds).
 *   - linear `data` + `status` → RUNTIME (`ensureContractInputValid`).
 *   - produces self-check → PRODUCE-TIME (`extraction.ts:effectiveOutputSchema`).
 *
 * Per-stage schema fallback (DECIDED, D4): when a stage carries no contract,
 * `checkEdgeSchemaCompat` falls back to the stage's own
 * `outputSchema`/`inputSchema`. That fallback lives HERE, not in harvest:
 * harvest derives per-SKILL contracts from dispatching stages only
 * (last-writer-wins per skill), while this check is edge-local and must also
 * cover non-dispatching (script/prompt) stages and direct `validateWorkflow`
 * calls that pass no contracts at all.
 */

import { marksReadsData, STOP, type Workflow } from "../api.js";
import { isDispatchingStage, resolvePublishName, resolveSkill } from "../chain-state.js";
import { extractJsonSchema } from "../json-schema.js";
import { judgeOf, loopSpecOf } from "../loop-constructors.js";
import type { ProducesSpec, SkillContractMap } from "../skill-contract.js";
import { adjudicateChannel, compareDataChannel, getCompositionComparators } from "../skill-contracts/index.js";
import { readName } from "../stage-def.js";
import type { IssueReporter } from "./issue.js";

/**
 * Route edges that read `output.data[field]` (i.e. `defineRoute(...)` with
 * the default `readsData: true`, `gate(...)`, and any future factory that
 * auto-attaches the `READS_DATA` marker) should fire on data the source
 * stage has validated against its `outputSchema`. If the schema is absent,
 * the validation-retry loop never runs and the route may read an undefined
 * field — routing decisions silently default.
 *
 * A stage carrying no `outputSchema` is still covered when its dispatched
 * skill declares a contract `produces.data` — output validation sources that
 * schema at runtime (`effectiveOutputSchema` in extraction.ts), so the route
 * fires on validated data. Such stages are exempt from this lint.
 *
 * Routes authored via `defineRoute(targets, fn, { readsData: false })`
 * consult only `state` or `output.meta` and carry no marker — exempt from
 * this lint.
 */
export function checkPredicateSchemas(
	w: Workflow,
	r: IssueReporter,
	skillContracts: SkillContractMap | undefined,
): void {
	for (const [from, target] of Object.entries(w.edges)) {
		if (typeof target === "string") continue;
		if (!marksReadsData(target)) continue;
		const stage = w.stages[from];
		if (!stage || stage.outputSchema) continue;
		// Contract-sourced output schema covers the stage like its own `outputSchema`
		// would — mirror `effectiveOutputSchema`'s fallback (same `resolveSkill` key).
		// Only DISPATCHING stages have a skill identity: a script/prompt stage whose
		// record key matches a registered skill must not inherit its contract.
		const contractData = isDispatchingStage(stage)
			? skillContracts?.get(resolveSkill(stage, from))?.produces?.data
			: undefined;
		if (contractData) continue;
		r.forStage(from)("route-reads-unvalidated-data");
	}
}

/**
 * Load-time compat for the LINEAR `data` channel: for each string edge from→to,
 * compare the producer's `produces.data` to the consumer's `consumes.data`
 * (registry-sourced, falling back to the stage's own output/input schema — see
 * the module header for why the fallback lives here). Warns on a definite
 * mismatch; degrades on predicate/STOP edges and opaque schemas via the shared
 * `compareDataChannel` core (same engine `canCompose` consults — D4).
 *
 * Edge-local is correct here — the rolling primary flows along edges. The
 * many-to-one NAMED (`reads`) channel is handled by `checkReadsChannelCompat`.
 * Runtime mirror: `ensureContractInputValid`.
 */
export function checkEdgeSchemaCompat(
	w: Workflow,
	r: IssueReporter,
	skillContracts: SkillContractMap | undefined,
): void {
	for (const [from, target] of Object.entries(w.edges)) {
		if (typeof target !== "string" || target === STOP) continue; // degrade on predicate/STOP edges
		const fromStage = w.stages[from];
		const toStage = w.stages[target];
		if (!fromStage || !toStage) continue; // unknown stages already reported by edge-target checks
		// Contract lookups only for DISPATCHING stages (script/prompt stages have
		// no skill identity); their own output/input schemas still participate.
		const producerContract = isDispatchingStage(fromStage)
			? skillContracts?.get(resolveSkill(fromStage, from))
			: undefined;
		const consumerContract = isDispatchingStage(toStage)
			? skillContracts?.get(resolveSkill(toStage, target))
			: undefined;

		const producer = producerContract?.produces?.data ?? extractJsonSchema(fromStage.outputSchema);
		const consumer = consumerContract?.consumes?.data ?? extractJsonSchema(toStage.inputSchema);
		const compat = compareDataChannel(producer, consumer);
		if (!compat.ok) {
			r.forStage(from)("edge-schema-incompatible", { to: target, reason: compat.reason ?? "provably incompatible" });
		}
	}
}

/**
 * Reject a `fanout` stage whose dispatched skill declares `interaction:
 * "foreground"` — a fanout runs many parallel units, and a foreground skill
 * needs the single human. A load-time ERROR, the same class as a
 * produces/consumes mismatch (`reads-channel-incompatible`).
 */
export function checkFanoutInteraction(
	w: Workflow,
	r: IssueReporter,
	skillContracts: SkillContractMap | undefined,
): void {
	if (!skillContracts) return; // unsigned project — degrade
	for (const [name, stage] of Object.entries(w.stages)) {
		if (loopSpecOf(stage.loop)?.kind !== "fanout") continue;
		if (!isDispatchingStage(stage)) continue; // no skill identity to read interaction from
		const skill = resolveSkill(stage, name);
		if (skillContracts.get(skill)?.produces?.interaction !== "foreground") continue; // bg / undeclared → ok
		r.forStage(name)("fanout-foreground-skill", { skill });
	}
}

/**
 * Load-time named-channel (`reads`) compat — the COMPLETE authoring gate for
 * `reads:` wiring. For each consumer with `consumes.reads`, adjudicate
 * against EVERY `produces` stage that publishes the channel
 * (`resolvePublishName === channel`), not just the edge predecessor — named
 * channels are many-to-one (loop-backs, non-adjacent producers). The publisher
 * set is statically computable.
 *
 * ERRORS on a clean comparator incompatibility between two SIGNED contracts —
 * the "mechanically reject invalid wirings" guarantee, uniform across all stage
 * kinds, which is why no runtime reads gate is needed. Degrades (never errors)
 * when either side is unsigned or the shared `adjudicateChannel` gate skips
 * (no comparator registered, or the consumer declares no `meta` requirement
 * for the channel); a comparator throw surfaces as a WARNING (author defect —
 * matching the deriver/provider precedent) rather than silently disabling the
 * gate. "No publisher at all" is `checkReadsReferences`'s job, not this one's.
 */
export function checkReadsChannelCompat(
	w: Workflow,
	r: IssueReporter,
	skillContracts: SkillContractMap | undefined,
): void {
	if (!skillContracts) return;
	const comparators = getCompositionComparators();
	if (comparators.size === 0) return; // no adjudicators registered

	// Index signed publishers by channel. `kind === "produces"` mirrors the
	// runtime publish rule (`applyCompletedStage`).
	const publishersByChannel = new Map<string, Array<{ stage: string; produces: ProducesSpec }>>();
	const indexPublisher = (channel: string, stage: string, produces: ProducesSpec): void => {
		const list = publishersByChannel.get(channel);
		if (list) list.push({ stage, produces });
		else publishersByChannel.set(channel, [{ stage, produces }]);
	};
	for (const [name, stage] of Object.entries(w.stages)) {
		// Only DISPATCHING produces stages have a skill identity to sign with —
		// a script/prompt stage named after a registered skill must not become
		// a phantom signed publisher.
		if (stage.kind === "produces" && isDispatchingStage(stage)) {
			const produces = skillContracts.get(resolveSkill(stage, name))?.produces;
			if (produces) indexPublisher(resolvePublishName(stage, name), name, produces);
		}
		// A skill judge is a publisher of its verdict channel; unsigned judges degrade.
		const judge = judgeOf(stage);
		if (judge?.skill && judge.outcome?.name) {
			const produces = skillContracts.get(judge.skill)?.produces;
			if (produces) indexPublisher(judge.outcome.name, name, produces);
		}
	}

	for (const [consumerName, consumer] of Object.entries(w.stages)) {
		if (!consumer.reads?.length) continue;
		// Same dispatching gate as the publisher index — a non-dispatching
		// consumer is unsigned by definition.
		const consumes = isDispatchingStage(consumer)
			? skillContracts.get(resolveSkill(consumer, consumerName))?.consumes
			: undefined;
		if (!consumes?.reads) continue; // unsigned consumer — degrade
		const report = r.forStage(consumerName);
		for (const rawRead of consumer.reads) {
			const channel = readName(rawRead);
			const publishers = publishersByChannel.get(channel);
			if (!publishers) continue; // "no publisher at all" is checkReadsReferences's job
			for (const { stage: producerName, produces } of publishers) {
				// THE shared adjudication rule (`adjudicateChannel`) — same gating and
				// degrade posture as `canCompose`, so the adviser and this load gate
				// can never disagree about one producer/consumer pair.
				const verdict = adjudicateChannel(produces, consumes, channel, comparators);
				if (verdict.kind === "ok" || verdict.kind === "skipped") continue;
				if (verdict.kind === "comparator-threw") {
					// Author-defect in the comparator: surfaced (matching the
					// deriver/provider precedent), never silently disabling the gate.
					report("reads-comparator-threw", { channel, producer: producerName, error: verdict.error });
					continue;
				}
				report("reads-channel-incompatible", {
					channel,
					producer: producerName,
					reason: verdict.reason ?? "named-channel meta incompatibility",
				});
			}
		}
	}
}
