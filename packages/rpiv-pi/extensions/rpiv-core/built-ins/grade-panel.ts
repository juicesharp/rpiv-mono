/**
 * The grade panels: the shared tiered panel factory, its build-lane instances,
 * and ship's bespoke tier-independent panel and verdict channel.
 */
import { directoryPathCollector, fanout, handleToString, jsonBodyParser } from "@juicesharp/rpiv-workflow/registration";
import {
	dimensionsToRegrade,
	freshVerdicts,
	GOAL_DIMENSIONS,
	gateRoster,
	gateTier,
	latestVerdictPerDimension,
	PLAN_DIMENSIONS,
	planAuthoredRisks,
	SHIP_DIMENSIONS,
	SLICE_DIMENSIONS,
} from "./gates.js";
import { isSurgicalFix, priorArtifact } from "./priors.js";
import { latestFsArtifact } from "./shared.js";

/**
 * A grade panel: one `grade` session per dimension over the latest artifact on
 * `channel`. Each unit's prompt is the `grade` skill's flags
 * (`--dimension <d> --artifact <path>`); the per-dimension verdicts fold via
 * `allDimensionsPass`. Shared by the slice gate (over `slices`) and the plan +
 * code gates (over `plans`), each on its own `verdictChannel`.
 *
 * The panel grades the tier's ROSTER (`gateTier`/`gateRoster`), over verdicts
 * still FRESH for the current artifact (`freshVerdicts`) — a light run grades
 * two dimensions, a regenerated artifact re-grades from scratch. On a re-grade
 * it emits ONLY the dimensions `dimensionsToRegrade` says still need it (the
 * rest carry their prior passing verdict forward) — but never an EMPTY set: an
 * empty `units()` return falls through to a single dimensionless `grade`
 * dispatch, so when nothing needs re-grading we fall back to the full roster.
 * The route into the stage already skips it entirely when the accumulated
 * verdicts clear the gate (see `plan-cite-check`/`code-cite-check`/`slice-check`
 * edges), so this fallback only fires in the degenerate case where a fix left the
 * cite floor red while every dimension passed.
 *
 * `architecture-fit` is the one dimension `grade` requires a `--context` for: it
 * grades the plan against the research the slices rest on. The build flow always
 * front-loads a `research` stage, so we thread the latest `research` artifact in
 * as `--context` for that dimension only; likewise the latest `goal` artifact
 * threads in as `--goal` for the `GOAL_DIMENSIONS` only. Every other dimension
 * (and the slice gate's `design-readiness`, which never grades fit or
 * goal-completeness) gets the bare flags.
 *
 * A CONFIRM panel (`confirm: true`) additionally threads each still-blocking
 * dimension's latest verdict in as `--prior`: the confirming grader must
 * adjudicate the prior round's findings — uphold or refute each with cited
 * evidence — instead of silently out-voting them (a blind second opinion once
 * rationalized past a checkable fact and its pass overwrote a correct fail at
 * the latest-per-dimension fold). Only PENDING dimensions get the flag: in the
 * degenerate full-roster fallback a carried passing verdict has nothing to
 * adjudicate, and a first grade has no prior at all.
 */
const gradePanelFanout = (
	channel: string,
	dimensions: readonly string[],
	verdictChannel: string,
	{ confirm = false, priorChannel }: { confirm?: boolean; priorChannel?: string } = {},
) =>
	fanout({
		source: channel,
		unit: { by: "dimension-list", pattern: "dimensions" },
		max: dimensions.length,
		units: ({ state, cwd }) => {
			const doc = latestFsArtifact(state, channel);
			if (doc?.handle.kind !== "fs") return [];
			const target = handleToString(doc.handle);
			const research = latestFsArtifact(state, "research");
			const contextFlag = research?.handle.kind === "fs" ? ` --context ${handleToString(research.handle)}` : "";
			const goal = latestFsArtifact(state, "goal");
			const goalFlag = goal?.handle.kind === "fs" ? ` --goal ${handleToString(goal.handle)}` : "";
			const roster = gateRoster(gateTier(state, verdictChannel), dimensions);
			const latest = latestVerdictPerDimension(freshVerdicts(state.named[verdictChannel], target));
			const risks = planAuthoredRisks(state, channel);
			const pending = dimensionsToRegrade(roster, latest, risks);
			// Delta re-grade fallback guard (plan/code gates only — `priorChannel`
			// is unset for the slice gate and both confirm panels). When the snapshot
			// stage published a prior, compare it to the current plan: a SURGICAL
			// amend (touched only sections a failing finding cited, ≤ threshold
			// lines) re-grades only the still-pending dimensions; a NON-surgical
			// amend (broad / out-of-scope / over-threshold / unreadable / unparseable)
			// re-grades the FULL roster — a broad amend may have regressed a passing
			// dimension the carry-forward would otherwise trust. With NO prior
			// (round 1 / first re-grade) the carry-forward applies unchanged. See
			// `isSurgicalFix` for the fail-closed contract.
			const surgical =
				!confirm && priorChannel !== undefined && isSurgicalFix(state, priorChannel, cwd, target, latest, pending);
			const priorPresent = priorChannel !== undefined && priorArtifact(state, priorChannel) !== undefined;
			const priorFlag = (d: string): string => {
				if (!confirm || !pending.includes(d)) return "";
				const handle = latest.get(d)?.artifacts.find((a) => a.handle.kind === "fs")?.handle;
				return handle ? ` --prior ${handleToString(handle)}` : "";
			};
			const carryForward = pending.length > 0 ? pending : roster;
			// A non-surgical result WITH a prior present re-grades the FULL roster;
			// with NO prior the carry-forward applies (never an empty unit set —
			// empty ⇒ single dimensionless grade fall-through).
			const toGrade = surgical ? carryForward : priorPresent ? roster : carryForward;
			return toGrade.map((d) => ({
				prompt: `--dimension ${d} --artifact ${target}${d === "architecture-fit" ? contextFlag : ""}${GOAL_DIMENSIONS.has(d) ? goalFlag : ""}${priorFlag(d)}`,
				label: d,
				id: `${channel}-dim-${d}`,
			}));
		},
	});

const SLICE_DIMENSION_FANOUT = gradePanelFanout("slices", SLICE_DIMENSIONS, "slice-verdicts");
const PLAN_DIMENSION_FANOUT = gradePanelFanout("plans", PLAN_DIMENSIONS, "plan-verdicts", {
	priorChannel: "plan-snapshot",
});
// The post-splice code gate re-grades the SAME `plans` artifact on its own
// `code-verdicts` channel, so its carry-forward reads the code gate's verdicts,
// never the pre-elaborate plan gate's.
const CODE_DIMENSION_FANOUT = gradePanelFanout("plans", PLAN_DIMENSIONS, "code-verdicts", {
	priorChannel: "code-snapshot",
});
// The confirm stages re-run the SAME panel machinery on the SAME verdict
// channel: with the failing dimensions the only ones pending, the panel emits
// exactly the blocking dimensions — one second judgment each, in confirm mode:
// each unit carries the blocking verdict as `--prior`, and the grade skill is
// contract-bound to rule on every prior finding (uphold, or refute with cited
// evidence) so a confirming pass records WHY the fail died instead of silently
// out-voting it at the latest-per-dimension fold.
// Distinct fanout instances (not aliases) so each stage owns its loop object.
const PLAN_CONFIRM_FANOUT = gradePanelFanout("plans", PLAN_DIMENSIONS, "plan-verdicts", { confirm: true });
const CODE_CONFIRM_FANOUT = gradePanelFanout("plans", PLAN_DIMENSIONS, "code-verdicts", { confirm: true });

/**
 * Ship's grade panel — a bespoke `fanout({...})` mirroring `gradePanelFanout`'s
 * body but binding the roster to `SHIP_DIMENSIONS` DIRECTLY (no
 * `gateRoster(gateTier(...))` wrap) and dropping the confirm / `priorChannel`
 * / surgical-fix machinery ship's single-pass grade does not carry. Kept: the
 * `latestFsArtifact` guard (no plan → no units), the dimension-keyed
 * `--context` (architecture-fit only, sourced from the front-loaded `research`
 * artifact), the `--goal` flag for `GOAL_DIMENSIONS` (completeness/
 * correctness), and the `freshVerdicts` / `latestVerdictPerDimension` /
 * `dimensionsToRegrade` carry-forward so a re-grade emits only still-pending
 * dimensions. Tier-independence is structural: the roster never shrinks, so a
 * light run still grades `architecture-fit`. Ship-only addition: the
 * correctness unit carries `--cite-check <verdict>` when the deterministic
 * citation floor recorded findings — advisory by construction here, since a
 * blocking finding STOPs at the cite gate before grade ever runs — so the
 * grader adjudicates them rather than leaving them unread.
 */
export const SHIP_DIMENSION_FANOUT = fanout({
	source: "plans",
	unit: { by: "dimension-list", pattern: "dimensions" },
	max: SHIP_DIMENSIONS.length,
	units: ({ state }) => {
		const doc = latestFsArtifact(state, "plans");
		if (doc?.handle.kind !== "fs") return [];
		const target = handleToString(doc.handle);
		const research = latestFsArtifact(state, "research");
		const contextFlag = research?.handle.kind === "fs" ? ` --context ${handleToString(research.handle)}` : "";
		const goal = latestFsArtifact(state, "goal");
		const goalFlag = goal?.handle.kind === "fs" ? ` --goal ${handleToString(goal.handle)}` : "";
		// The floor's findings (advisory by construction — see the fanout doc
		// above) thread as `--cite-check`; no findings ⇒ no flag.
		const cite = latestFsArtifact(state, "plan-cite-check");
		const citeFindings = (state.named["plan-cite-check"]?.at(-1)?.data as { findings?: unknown[] } | undefined)
			?.findings;
		const citeFlag =
			cite?.handle.kind === "fs" && Array.isArray(citeFindings) && citeFindings.length > 0
				? ` --cite-check ${handleToString(cite.handle)}`
				: "";
		// Tier-independent roster: SHIP_DIMENSIONS verbatim — never gateRoster(gateTier(...)).
		const roster = SHIP_DIMENSIONS;
		const latest = latestVerdictPerDimension(freshVerdicts(state.named["ship-verdicts"], target));
		const risks = planAuthoredRisks(state, "plans");
		const pending = dimensionsToRegrade(roster, latest, risks);
		const carryForward = pending.length > 0 ? pending : roster;
		return carryForward.map((d) => ({
			prompt: `--dimension ${d} --artifact ${target}${d === "architecture-fit" ? contextFlag : ""}${GOAL_DIMENSIONS.has(d) ? goalFlag : ""}${d === "correctness" ? citeFlag : ""}`,
			label: d,
			id: `plans-dim-${d}`,
		}));
	},
});

// Ship's grade panel writes its verdicts to a DISTINCT channel (same
// directory, different artifact basenames) so they never mix with build's
// plan/code verdicts — named for the workflow, completing the slice-verdicts
// / plan-verdicts / code-verdicts / ship-verdicts parallel.
export const shipVerdictOutcome = {
	name: "ship-verdicts",
	collector: directoryPathCollector({ dir: ".rpiv/artifacts/verdicts", ext: "json" }),
	parser: jsonBodyParser,
};

export {
	CODE_CONFIRM_FANOUT,
	CODE_DIMENSION_FANOUT,
	PLAN_CONFIRM_FANOUT,
	PLAN_DIMENSION_FANOUT,
	SLICE_DIMENSION_FANOUT,
};
