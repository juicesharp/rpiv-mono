/**
 * Chain-state authorities — the ONLY exported way to read or advance the
 * rolling artifact/output slots a run carries from stage to stage, plus the
 * shared stage-identity derivations the runtime and the load-time validators
 * must agree on.
 *
 * Every helper here is consumed by BOTH the live chain and the resume fold
 * (or by both the runtime and load-time validation), so each is a
 * single-construction-site guard: live and resume can't drift, runtime and
 * load can't disagree. Generic, domain-free utilities live in
 * `internal-utils.ts`; anything in this file is workflow-chain domain logic.
 */

import type { PromptFn, StageDef } from "./api.js";
import { type Artifact, handleToString } from "./handle.js";
import type { Output } from "./output.js";
import type { RunState } from "./types.js";

/**
 * Canonical accessor for "the primary artifact the chain is currently
 * carrying." Reads the rolling slot maintained by the runner —
 * produces stages update it on success; side-effect stages leave it
 * alone. Replaces the load-bearing single-string artifact_path mirror
 * from the pre-collector shape.
 */
export function currentPrimaryArtifact(state: RunState): Artifact | undefined {
	return state.primaryArtifact;
}

/**
 * Resolve the `state.named` key a produces stage appends its `Output`
 * envelope onto. Two layers of fallback, in priority order:
 *   1. `stage.outcome?.name` — categorical name carried by the outcome.
 *   2. The stage's record key — always defined.
 *
 * Single source of truth for the key derivation so the skill-stage path
 * and the script-stage path stay in lockstep, and so `validateWorkflow`
 * can compute the same key set at load time.
 */
export function resolvePublishName(def: StageDef, stageName: string): string {
	return def.outcome?.name ?? stageName;
}

/**
 * Resolve a stage's effective skill — the contract-registry key. Twin of
 * `resolvePublishName`. Single source of truth so the runtime resolution
 * (`resolveStage`) and the load-time lookups (`validate-workflow.ts`) key the
 * registry identically and can't drift.
 */
export function resolveSkill(def: StageDef, stageName: string): string {
	return def.skill ?? stageName;
}

/**
 * A stage dispatches a `/skill:<name>` exactly when it carries neither a `run`
 * (script body) nor a `prompt` (raw-text body). `fanout`/`iterate` stages carry
 * neither, so they ARE dispatching stages. The shared predicate for every site
 * that treats `resolveSkill`'s result as a REAL skill identity — the alias
 * remap + its no-op warning, contract harvest, and the validator's contract
 * lookups must all agree, or a script/prompt stage whose record key matches a
 * registered skill inherits that skill's contract by accident.
 */
export function isDispatchingStage(stage: StageDef): boolean {
	return stage.run == null && stage.prompt == null;
}

/**
 * Resolve a stage's `prompt` dispatch text — the COMPLETE user message a
 * prompt stage sends (no `/skill:` prefix, no implicit arg). The dynamic form
 * receives the same `ScriptContext` script stages get. The ONE resolver for
 * every prompt-dispatch site: the single-shot path (stage-lifecycle) and the
 * loop driver's round-0 producer (loop.ts) — resolved at dispatch time, never
 * persisted, so a `PromptFn` on a loop stage joins the loop determinism
 * contract (deterministic w.r.t. the fold-replayed state). Lives here (not
 * runner/) so loop.ts consumes it cycle-free — same posture as
 * `stageEntryArgs` below.
 */
export async function resolveStagePrompt(prompt: string | PromptFn, cwd: string, state: RunState): Promise<string> {
	if (typeof prompt === "string") return prompt;
	return prompt({ cwd, input: state.output, state });
}

/**
 * The single arg-projection authority: the string a stage's
 * `/skill:<name> <args>` prompt carries, derived purely from
 * (def, stageName, startStage, state). Five cases in priority order:
 *   0. A prompt-dispatch stage (`def.prompt` set) owns its WHOLE message —
 *      no skill args exist; returns `""` (never `undefined`: the missing-input
 *      refusal arms below must not fire for a stage that doesn't consume the
 *      rolling primary or named reads). The round-0 producer message of a
 *      prompt-dispatch loop is `resolveStagePrompt`, not this projection.
 *   1. The start stage receives `originalInput` (the user's brief).
 *   2. A stage opting out of inheritance (`inheritsArtifacts: false`,
 *      i.e. authored via `terminal()`) also receives `originalInput`.
 *   3. A stage with `reads: [...]` receives the labelled multi-flag form
 *      `--<name1> <handle1> --<name2> <handle2> …` — each name resolves
 *      against `state.named[name].at(-1)`; a multi-artifact entry repeats
 *      the flag.
 *   4. Otherwise: the rolling primary artifact's handle string.
 *
 * Returns `undefined` (instead of non-null-asserting) when a required
 * projection input is missing — the rolling primary is unset, or a `reads`
 * name has no published entry. The LIVE path never sees `undefined`: the
 * preflights (`ensureUpstreamArtifact` / `ensureNamedReads`) guarantee the
 * inputs before `inputForStage` delegates here. The RESUME fold freezes this
 * value at loop-generation open, where replayed state is byte-identical to
 * live loop entry (THE REPLAY CONTRACT); `undefined` there means a
 * truncated/corrupted trail and becomes a recorded refusal.
 */
export function stageEntryArgs(
	def: StageDef,
	stageName: string,
	startStage: string,
	state: RunState,
): string | undefined {
	if (def.prompt !== undefined) return "";
	if (stageName === startStage) return state.originalInput;
	if (def.inheritsArtifacts === false) return state.originalInput;
	if (def.reads?.length) {
		const parts: string[] = [];
		for (const name of def.reads) {
			const latest = state.named[name]?.at(-1);
			if (!latest) return undefined;
			for (const artifact of latest.artifacts) {
				parts.push(`--${name}`, handleToString(artifact.handle));
			}
		}
		return parts.join(" ");
	}
	const primary = currentPrimaryArtifact(state);
	return primary === undefined ? undefined : handleToString(primary.handle);
}

/**
 * The single authority for "a completed produces stage mutates the rolling
 * artifact state." Called by the live skill path (sessions/sessions.ts), the
 * live script path (runner/script-stage.ts), and state reconstruction
 * (runner/resume.ts) — keeping all three in lockstep (parity-tested).
 *
 * Scope: primary slot + named-publish registry ONLY. `state.output` and
 * `state.stagesCompleted` advance through `applyStageSuccess`
 * (audit-rows.ts), which delegates here for the artifact slots.
 *
 *   - kind "produces"            → first artifact wins the rolling slot; the
 *                                  full Output appends onto state.named[key].
 *   - inheritsArtifacts === false → clear the slot (terminal()).
 *   - other side-effect          → leave the slot untouched.
 */
export function applyCompletedStage(state: RunState, def: StageDef, stageName: string, output: Output): void {
	if (def.kind === "produces") {
		const next = output.artifacts[0];
		if (next) state.primaryArtifact = next;
		const key = resolvePublishName(def, stageName);
		let slot = state.named[key];
		if (!slot) {
			slot = [];
			state.named[key] = slot;
		}
		slot.push(output);
		return;
	}
	if (def.inheritsArtifacts === false) {
		state.primaryArtifact = undefined;
	}
}
