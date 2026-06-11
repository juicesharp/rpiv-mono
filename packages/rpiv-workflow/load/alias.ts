/**
 * Declarative skill-name remapping, applied once at load time.
 *
 * `aliasSkills(w, aliases)` rewrites every dispatching stage whose effective
 * skill (resolved via `resolveSkill(stage, stageName)`) has an alias entry, materialising the
 * `skill` field on stages that relied on the stage-key default. Because the
 * remap happens in the loader — before validation and before the runner ever
 * sees the workflow — `/wf` preview, JSONL audit, and the runtime
 * skill-registry preflight all observe the final skill for free; the runner
 * needs no change.
 *
 * Invariants:
 *   - One hop only — looks up `aliases[effective]`, never `aliases[target]`.
 *     No transitive chains, no cycles.
 *   - `run` / `prompt` stages are skipped — they don't dispatch a `/skill:`.
 *     (`fanout` / `iterate` stages carry neither `run` nor `prompt`, so they
 *     ARE dispatching stages and get aliased.)
 *   - Never mutates its input. Returns `w` by reference when nothing changed,
 *     so the shared process-wide built-in registry (anchored on a `globalThis`
 *     slot) is never mutated in place; a changed workflow is a new frozen copy.
 */

import type { Workflow } from "../api.js";
import { isDispatchingStage, resolveSkill } from "../chain-state.js";
import type { LayerOutcome, LoadAccumulator } from "./merge.js";

// `isDispatchingStage` lives beside `resolveSkill` in chain-state.ts (the
// validator and harvest consume it without reaching into load/); re-exported
// here for existing consumers of the old path.
export { isDispatchingStage } from "../chain-state.js";

export function aliasSkills(w: Workflow, aliases: Record<string, string>): Workflow {
	if (!aliases || Object.keys(aliases).length === 0) return w;
	let changed = false;
	const stages: typeof w.stages = {};
	for (const [name, stage] of Object.entries(w.stages)) {
		const dispatches = isDispatchingStage(stage); // only /skill: stages
		const effective = resolveSkill(stage, name);
		const target = aliases[effective];
		if (dispatches && target && target !== effective) {
			stages[name] = { ...stage, skill: target }; // materialise implicit skill
			changed = true;
		} else {
			stages[name] = stage;
		}
	}
	return changed ? Object.freeze({ ...w, stages }) : w; // never mutate shared built-ins
}

/**
 * Apply skill-alias remapping to every workflow in the accumulator.
 *
 * Merges `userOutcome.skillAliases` and `projectOutcome.skillAliases` per-key
 * (project wins), snapshots the pre-remap dispatched-skill set so no-op
 * warnings compare against skills authors actually wrote (not alias targets
 * freshly introduced by this very remap), then rewrites every workflow via
 * `aliasSkills`. The runner is untouched — by the time `runWorkflow` runs
 * every `stage.skill` already reflects the final target.
 *
 * No-op warnings attribute to the source layer: each layer's alias map is
 * walked separately so a user-layer typo points at `~/.config/rpiv-workflow/`
 * and a project-layer typo points at `<cwd>/.rpiv/workflows/`. A key declared
 * in BOTH layers and no-op in both emits two warnings (one per layer) so the
 * user fixes both files.
 *
 * Mutates `acc.workflowMap` and `acc.issues` in place (same precedent as
 * `loadLayer`). Returns the merged alias map for the
 * `LoadedWorkflows.skillAliases` envelope; `{}` when no layer declared any.
 */
export function applySkillAliases(
	acc: LoadAccumulator,
	userOutcome: LayerOutcome,
	projectOutcome: LayerOutcome,
): Record<string, string> {
	const userAliases = userOutcome.skillAliases ?? {};
	const projectAliases = projectOutcome.skillAliases ?? {};
	const merged: Record<string, string> = { ...userAliases, ...projectAliases };
	if (Object.keys(merged).length === 0) return merged;

	// Snapshot the pre-remap dispatched-skill set so the "no-op alias" warning
	// compares against the skills authors actually wrote — not alias targets
	// freshly introduced by this very remap.
	const dispatchedBefore = new Set<string>();
	for (const w of acc.workflowMap.values()) {
		for (const [stageName, stage] of Object.entries(w.stages)) {
			if (isDispatchingStage(stage)) dispatchedBefore.add(resolveSkill(stage, stageName));
		}
	}
	for (const [name, w] of acc.workflowMap) acc.workflowMap.set(name, aliasSkills(w, merged));

	// Per-source-layer no-op attribution: walk each layer's map separately so
	// each warning points at the file that actually declared the key. A key
	// declared by BOTH layers and no-op in both emits two warnings — one per
	// layer — so the user fixes both files.
	for (const [layer, map] of [
		["user", userAliases],
		["project", projectAliases],
	] as const) {
		for (const key of Object.keys(map)) {
			if (!dispatchedBefore.has(key)) {
				acc.issues.push({
					kind: "load",
					layer,
					severity: "warning",
					message: `skillAliases: "${key}" matches no dispatched skill in any workflow (no-op).`,
				});
			}
		}
	}
	return merged;
}
