/**
 * Panel — N independent judges + a vote fold (the adversarial generalization
 * of a single judge). Construction + the canonical verdict surface live here;
 * execution (cursor sub-state, member dispatch, fold-close publish) lands in the
 * runner behind the one `panelMembers` expander.
 */

import { type Static, Type } from "typebox";
import type { StageDef } from "../api.js";
import {
	assertShape,
	brandCanonicalFold,
	type FoldFn,
	type Judge,
	judgeShapeIssues,
	marksCanonicalFold,
	type NamedOutcome,
	type PanelJudge,
} from "../judge.js";
import { noopCollector } from "../outcomes/index.js";
import type { Output } from "../output.js";

/**
 * The canonical fold output shape — what `majority`/`all`/`any` emit and what
 * a downstream `defineRoute`/`gate`/`match` branches on. `agreement` (|majority|
 * / N) is the first-class disagreement signal; `tie` flags an even split. A
 * custom (raw) fold publishes the author's own schema instead (the XOR rule).
 */
export const PANEL_VERDICT = Type.Object({
	pass: Type.Boolean(),
	votes: Type.Object({ pass: Type.Integer(), fail: Type.Integer() }),
	agreement: Type.Number(),
	tie: Type.Boolean(),
});

/** Static type of the canonical {@link PANEL_VERDICT} fold output. */
export type PanelVerdict = Static<typeof PANEL_VERDICT>;

/**
 * Built-in named outcome the CANONICAL path publishes under — the default a
 * sugar panel resolves to (`judge.outcome ?? PANEL_VERDICT_OUTCOME`, wired in
 * the panel-close publish phase). Its `name` is a fallback: the live publish
 * overrides it with the per-stage `<stage>-panel` channel, so distinct panel
 * stages never collide. The collector is a no-op — the fold output is
 * manufactured from the member verdicts (data, not a collected artifact), so
 * nothing is ever collected on this outcome.
 */
export const PANEL_VERDICT_OUTCOME: NamedOutcome = {
	name: "panel-verdict",
	collector: noopCollector,
};

/**
 * Tally the members' per-member `pred` results into the canonical verdict
 * shape. `votes`/`agreement`/`tie` are fold-independent (they describe the
 * split); only `pass` differs per sugar fold, supplied by `passWhen`.
 */
function tally(
	verdicts: readonly Output[],
	pred: (v: Output) => boolean,
	passWhen: (pass: number, fail: number) => boolean,
): PanelVerdict {
	const n = verdicts.length;
	const pass = verdicts.reduce((c, v) => c + (pred(v) ? 1 : 0), 0);
	const fail = n - pass;
	return {
		pass: passWhen(pass, fail),
		votes: { pass, fail },
		agreement: n === 0 ? 0 : Math.max(pass, fail) / n,
		tie: pass === fail,
	};
}

/**
 * Sugar fold — the panel passes iff a STRICT majority of members pass `pred`
 * (an even split is a tie ⇒ fail, surfaced via `tie`/`agreement`). The
 * per-member `pred` interprets each member's OWN verdict schema (no convention
 * on members); the fold's output is the canonical {@link PANEL_VERDICT}. Branded
 * canonical, so pairing it with an explicit `outcome` is a construction error.
 */
export function majority(pred: (v: Output) => boolean): FoldFn {
	return brandCanonicalFold("majority", (verdicts) => tally(verdicts, pred, (pass, fail) => pass > fail));
}

/** Sugar fold — unanimous: the panel passes iff EVERY member passes `pred` (one fail vetoes). */
export function all(pred: (v: Output) => boolean): FoldFn {
	return brandCanonicalFold("all", (verdicts) => tally(verdicts, pred, (pass, fail) => pass > 0 && fail === 0));
}

/** Sugar fold — veto/rescue: the panel passes iff ANY member passes `pred` (one pass carries it). */
export function any(pred: (v: Output) => boolean): FoldFn {
	return brandCanonicalFold("any", (verdicts) => tally(verdicts, pred, (pass) => pass > 0));
}

/**
 * Single rule source for the panel shape — mirrors `judgeShapeIssues` /
 * `verifyShapeIssues`. Returns human-readable violations (empty = valid);
 * `panel()` throws on the first, `validateWorkflow` maps each to a load issue
 * for hand-rolled literals. Takes `unknown` ON PURPOSE: typed call sites are
 * already guarded by the `PanelJudge` type, so everything reaching here is an
 * untyped jiti-loaded literal.
 *
 * Enforces: a non-empty `members` array, each member a VALID single judge with
 * NO nesting (`members` is `Judge[]`), a function `fold`, and the XOR rule
 * (canonical sugar ⊕ `outcome` — exactly one names the verdict schema/channel).
 */
export function panelShapeIssues(candidate: unknown): string[] {
	if (!candidate || typeof candidate !== "object") return ["a panel object is required"];
	const p = candidate as { members?: unknown; fold?: unknown; outcome?: { name?: unknown } };
	const issues: string[] = [];

	if (!Array.isArray(p.members) || p.members.length === 0) {
		issues.push("panel.members must be a non-empty array of judges");
	} else {
		for (const m of p.members) {
			if (m && typeof m === "object" && (m as PanelJudge).kind === "panel") {
				issues.push("panel.members may not nest another panel — members are single judges (skill or prompt)");
				continue;
			}
			for (const issue of judgeShapeIssues(m)) issues.push(`panel member: ${issue}`);
		}
	}

	const foldIsFn = typeof p.fold === "function";
	if (!foldIsFn) {
		issues.push("panel.fold must be a function reducing the member verdicts to the panel's decision");
	}

	// The XOR rule — a sugar fold OWNS the canonical verdict (no `outcome`); a raw
	// fold REQUIRES an `outcome` to name + validate its channel. Never both.
	const isSugar = foldIsFn && marksCanonicalFold(p.fold as FoldFn);
	const hasOutcome = p.outcome !== undefined;
	if (isSugar && hasOutcome) {
		issues.push(
			"a canonical fold (majority/all/any) publishes the built-in PANEL_VERDICT — drop `outcome` (sugar ⊕ outcome)",
		);
	}
	if (foldIsFn && !isSugar && !hasOutcome) {
		issues.push("a custom (raw) fold requires an `outcome` naming + validating its verdict channel (raw ⊕ outcome)");
	}
	if (hasOutcome && !p.outcome?.name) {
		issues.push("panel.outcome must carry a `name` so the folded verdict publishes to its own named channel");
	}

	return issues;
}

/** Authoring input for {@link panel} — the `PanelJudge` minus the injected `kind` discriminator. */
export interface PanelSpec {
	members: readonly Judge[];
	fold: FoldFn;
	outcome?: NamedOutcome;
}

/**
 * Promote a panel literal to a validated `PanelJudge` — injects the
 * `kind: "panel"` discriminator and throws on the first shape issue, so a
 * `panel(...)`-authored value is correct by construction (cf. `judge()` /
 * `defineRoute`). The judge SITES already accept it through the widened
 * `AnyJudge` slot; their member dispatch + fold-close publish arrive in the
 * execution phases, so `assess`/`verify` don't yet route a panel here.
 */
export function panel(spec: PanelSpec): PanelJudge {
	const candidate: PanelJudge = { kind: "panel", ...spec };
	assertShape("panel", panelShapeIssues(candidate));
	return candidate;
}

/**
 * The channel a panel's FOLDED verdict publishes to — the author's
 * `outcome.name` on the custom path, or the `<stage>-panel` convention on the
 * canonical path (sugar fold, no `outcome`). ONE definition so the load gate
 * (`validateWorkflow`) and the panel-close publish (later phases) can never
 * drift on the name. Member verdicts publish to their OWN `outcome.name`
 * channels; this is only the fold's slot.
 */
export function panelVerdictChannel(p: PanelJudge, stageName: string): string {
	return p.outcome?.name ?? `${stageName}-panel`;
}

/**
 * Synthetic `produces` def the panel-close publish lands the FOLDED verdict
 * under — the twin of `judgeStageDef` (which a single MEMBER runs on). The
 * publish channel is resolved ONCE through {@link panelVerdictChannel} and baked
 * into `outcome.name`, so the canonical path's per-stage `<stage>-panel` channel
 * OVERRIDES `PANEL_VERDICT_OUTCOME`'s fallback name (distinct panel stages never
 * collide) and the custom path keeps the author's own `outcome`. The folded
 * Output carries no artifact, so `applyCompletedStage` leaves the rolling primary
 * untouched and only appends to the named channel. ONE construction site —
 * the live publish (`loop.ts`) and the resume fold (`runner/resume.ts`) share it,
 * so the two paths can never drift on the def or the channel.
 */
export function panelVerdictDef(p: PanelJudge, stageName: string): StageDef {
	const base = p.outcome ?? PANEL_VERDICT_OUTCOME;
	return { kind: "produces", outcome: { ...base, name: panelVerdictChannel(p, stageName) }, sessionPolicy: "fresh" };
}
