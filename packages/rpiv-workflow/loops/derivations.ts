/**
 * Per-stage derivations — the ONE consults the live + resume paths key off:
 * `effectiveLoopOf` (loop-vs-verify shape), `freezesEntryArgsOf` (the round-0
 * producer-arg rule), `judgeSlotOf` (the raw judge slot), `forEachJudgeChannel`
 * (the verdict-channel walk). Runner-free — safe on `registration`.
 */

import type { LoopDef, StageDef } from "../api.js";
import { type AnyJudge, isPanel } from "../judge.js";
import { LOOP_DEFAULTS } from "./constructors.js";
import { panelVerdictChannel } from "./panel.js";
import { synthesizeVerifyLoop } from "./verify.js";

/**
 * THE round-0-entry-arg predicate — one spelling of "which kinds freeze a
 * producer arg." Consulted by the three live/resume entry sites
 * (`run-stage.ts`, `resume.ts`, `resume-loop.ts`) instead of re-spelling
 * `loop.kind === "assess"`, so live and resume can no longer drift on the rule.
 */
export const freezesEntryArgsOf = (loop: LoopDef): boolean => LOOP_DEFAULTS[loop.kind].freezesEntryArgs;

/**
 * THE loop-or-verify consult — the one derivation of "does this stage run
 * through the loop driver, and with what spec." Consulted by `tryLoop`
 * (live), the resume fold's generation open, and `resumeLoopStage`, so the
 * three can never disagree about a verify stage's loop shape.
 */
export function effectiveLoopOf(def: StageDef): LoopDef | undefined {
	if (def.loop) return def.loop;
	return def.verify ? synthesizeVerifyLoop(def.verify) : undefined;
}

/**
 * THE judge-SLOT-of-stage derivation — the RAW `AnyJudge` (a single `Judge` or
 * an N-member `PanelJudge`) a stage carries, before any member collapse.
 * Panel-aware sites (the load gate's channel rules, `publishedNamesOf`) read
 * the whole slot through this.
 */
export function judgeSlotOf(stage: StageDef): AnyJudge | undefined {
	return stage.loop?.kind === "assess" ? stage.loop.judge : stage.verify?.judge;
}

/**
 * Enumerate the verdict channels a stage's judge slot publishes, each with the
 * skill that SIGNS it — `undefined` for the manufactured panel-fold channel
 * (`panelVerdictChannel`), which is data-only and carries no producer contract.
 * THE single judge-publisher walk: `publishedNamesOf` (load reachability —
 * consumes EVERY channel) and `checkReadsChannelCompat`'s publisher index
 * (contract adjudication — consumes only SIGNED channels) both read it, so a
 * panel-member channel can no longer be seen by one and missed by the other.
 */
export function forEachJudgeChannel(
	stage: StageDef,
	name: string,
	visit: (channel: string, signingSkill: string | undefined) => void,
): void {
	const slot = judgeSlotOf(stage);
	if (!slot) return;
	if (isPanel(slot)) {
		for (const m of slot.members) if (m?.outcome?.name) visit(m.outcome.name, m.skill);
		visit(panelVerdictChannel(slot, name), undefined); // manufactured fold — unsigned
	} else if (slot.outcome?.name) {
		visit(slot.outcome.name, slot.skill);
	}
}
