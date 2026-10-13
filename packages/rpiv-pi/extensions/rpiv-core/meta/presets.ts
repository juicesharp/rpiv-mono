/**
 * The built-in `meta` unit graph — the A/B challenger to `build`.
 *
 *   meta   research → acceptance → plan → implement → commit
 *
 * research is the one mandatory unit; the rest are optional per graph.
 *
 * Same skills as build/ship (research, acceptance, quick-plan, implement), so
 * an A/B run measures the SHAPE — per-unit loops with code-first graders and
 * scoped returns vs build's sliced, panel-gated stage graph — not the prompts.
 */

import { IMPLEMENT_DAG_FANOUT } from "../built-ins/index.js";
import {
	acceptanceCommands,
	acceptanceDisposed,
	acceptanceWellFormed,
	artifactWritten,
	minCitations,
	planCitations,
	treeChanged,
} from "./checks.js";
import { defineUnitGraph, type UnitSpec } from "./unit-graph.js";

const research: UnitSpec = {
	skill: "research",
	output: "research",
	checks: [artifactWritten(20), minCitations(5)],
	graders: [
		{
			lens: "grounding",
			rubric:
				"FAIL if any claim the brief depends on is asserted without a file:line that actually shows it, or if a cited file:line does not say what the doc claims (open and check at least 5 citations). FAIL if the doc misses a module the brief obviously touches. Otherwise PASS.",
			context: ["goal"],
		},
	],
	maxRounds: 2,
};

const acceptance: UnitSpec = {
	skill: "acceptance",
	reads: ["goal", "research"],
	output: "acceptance",
	checks: [artifactWritten(5), acceptanceWellFormed],
	maxRounds: 2,
};

const plan: UnitSpec = {
	skill: "quick-plan",
	reads: ["research", "goal", "acceptance"],
	output: "plans",
	fix: {
		prompt: ({ flags }) =>
			`Revise the implementation plan in place so it clears the failures below. Read these inputs first: ${flags}. Keep the plan's frontmatter schema (phases, files, acceptance dispositions) intact; announce the plan's path when done.`,
	},
	checks: [artifactWritten(20), planCitations, acceptanceDisposed],
	graders: [
		{
			lens: "correctness",
			rubric:
				"FAIL (medium+) only for a defect that makes the plan wrong AS WRITTEN: a referenced symbol/API/file that does not exist or has a different signature, an edit anchor that does not match the code, or a phase whose code would not compile against the tree. Open the cited code — batch your reads — before ruling. Style and nits are low.",
			context: ["research"],
		},
		{
			lens: "completeness",
			rubric:
				"FAIL (medium+) if any ask in the goal is neither implemented by a phase nor explicitly deferred under Out of Scope, or if any acceptance item's disposition is dishonest (marked implemented but no phase delivers it). Otherwise PASS.",
			context: ["goal", "acceptance"],
		},
	],
	maxRounds: 3,
	// When the surgical plan-fix loop can't converge in 3 rounds, escalate to
	// acceptance (its immediate upstream) rather than halt terminally: that opens
	// a fresh generation, so plan re-plans from scratch (a clean quick-plan, not
	// another surgical patch of a plan that kept whack-a-moling defects) against
	// an acceptance inventory the escalation lets acceptance revise. Mirrors
	// implement→plan; bounded by the runner's absolute lap ceiling, which halts
	// the run if escalation also fails to converge.
	onExhausted: { escalateTo: "acceptance" },
};

const implement: UnitSpec = {
	skill: "implement",
	reads: ["plans"],
	loop: IMPLEMENT_DAG_FANOUT,
	fix: {
		prompt: ({ flags }) =>
			`Repair the implementation of the plan (${flags}) so the failing checks below pass. You are fixing, not re-implementing: the other phases are done and correct.`,
	},
	checks: [treeChanged, acceptanceCommands()],
	graders: [
		{
			lens: "goal",
			rubric:
				"Read the goal, then the working-tree diff (git diff + untracked files). FAIL (medium+) if the diff does not deliver an ask the goal makes, delivers something the goal did not ask for, or leaves an obvious break (dead code path, unwired call site). Cite file:line. Otherwise PASS.",
			context: ["goal", "plans"],
		},
	],
	maxRounds: 3,
	onExhausted: { escalateTo: "plan" },
};

export const metaWorkflow = defineUnitGraph({
	name: "meta",
	description:
		"Graph of self-correcting units: research → acceptance → plan → implement → commit. Each unit loops produce → deterministic checks → parallel lens graders → scoped correction (max 3 rounds; identical failures twice stop early); an exhausted plan escalates to acceptance and an exhausted implement escalates to plan — each opening a fresh generation rather than halting. No confirm/demote passes, no slicing; accepted runs feed their corrected failures forward as standing constraints (.rpiv/lessons). The A/B challenger to build.",
	units: [
		["research", research],
		["acceptance", acceptance],
		["plan", plan],
		["implement", implement],
	],
});
