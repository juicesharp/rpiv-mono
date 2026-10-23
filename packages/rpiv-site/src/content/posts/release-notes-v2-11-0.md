---
title: "v2.11: the judge was the wall clock"
description: "The correctness judge was the slowest grader in 80% of panels. v2.11 moves risk rulings into their own concurrent unit and teaches the judge to read everything in one batch, then describe the code before comparing it to the claim. Build's planner also now gets the acceptance inventory it is judged against, so a valid divergence is ruled at the plan gate instead of halting the run hours later at validate."
pubDate: 2026-09-21T12:00:00Z
author: juicesharp
tags: ["release", "rpiv-pi"]
draft: false
---

v2.11 makes clean runs faster to grade. It has three changes, all in
`rpiv-pi`, and each comes from a real run or a corpus of runs. Nothing
breaks. There is no new flag and nothing to migrate. A trail recorded under
v2.10 folds unchanged.

For context, [v2.1 to v2.9](/blog/release-notes-v2-1-2-9) taught the
pipeline to finish. v2.10, two weeks ago, taught it to keep going while it
is still improving, and to resume where its retries stopped. That one lives
in the changelogs. Now that runs finish and resume reliably, their trails
show something new: where the time goes when nothing is wrong.

## Where a panel's time went

A `build` run grades its plan and its code with a panel of judges. Each
dimension gets its own child session, and the panel waits for the slowest
one. Across 175 plan and code panels, the `correctness` unit finished last
in 140 of them. That is 80%, at 2.1× the median sibling.

| Correctness unit | p50 wall |
|---|---|
| no `risks:`, no `--prior` | 4.9 min |
| a sibling dimension, same panels | 2.0 min |
| with risk rulings and prior adjudication | 6.6 min |

Two problems stacked up inside that unit. First, it had extra duties no
sibling had. It ruled on every risk flag the plan declared, and it
re-adjudicated its own prior verdict on every re-grade. Second, even without
those duties it ran two and a half times slower than a sibling. The cause
was *how* it worked, not what it was asked to do. So this release splits
out the duties, then fixes the method.

### Risk rulings become their own unit

When the graded plan's latest record declares `risks:`, the plan and code
gates (and `ship`'s) now dispatch a `risk-rulings` unit beside the others.
This happens at every tier, and never when there are no risks.

The new unit owns every risk flag. It also owns the mechanics-evidence and
verify-at-implement duties, and it adjudicates its own prior rulings on a
re-grade. It emits one ruling per flag and one finding per failed flag.
`correctness` keeps only its three semantic finding classes.

This helps beyond the wall clock in two ways.

First, a failed risk ruling no longer re-rolls correctness. Every risk fold
in the gates was already dimension-agnostic, so a failed or demoted ruling
now re-opens the risk unit *alone*. Before, it re-rolled the whole
correctness judgment, and we saw that flap: a verdict passed on semantics,
failed on one risk flag, then came back next round with different semantic
findings.

Second, the roster is now one authority. The fan-out, both gate predicates,
the confirm divert, the whole-lap progress hook and the dead-unit route all
fold the same list. So a risk unit that dies blocks like any panel member.
Before, a dead unit could hide behind a vacuous "all risk flags pass".

### The judge reads in one batch and commits before it compares

This is the bigger change. It touches no contract, gate or schema. It is
four edits to the text of the [`grade`](/docs/reference/skills/grade) skill.

The evidence came from 278 correctness judge sessions. The median session
ran 17 turns (p90 30), checking one claim per turn. It read a span, thought,
read the next span, thought again. Eighty-two sessions paged through a
single input file over serial turns, up to five turns for one file. One
re-grade spent four turns inside `node_modules/@vitest`, chasing a claim the
plan never made.

That pattern is expensive. The harness already runs all tool calls in one
assistant message concurrently, so each serial turn was a full reasoning
pass over the whole context, spent just to fetch one more range.

The four edits:

1. **Step 2 reads every input in one message.** A truncated read reports
   the file's line count, so all remaining ranges go in one follow-up. That
   is one turn, at most two, for the whole input set.
2. **Correctness runs inventory, then one evidence batch, then a
   commit-first compare.** The judge lists what to check from the artifact
   before reading any code. Risk flags, floor leads and prior findings are
   mandatory. It then adds at most eight sampled claims, with code blocks
   and edit dependencies first. It fetches evidence in one bounded batch,
   with at most two follow-ups, and gives its verdict by the sixth tool
   turn. Anything unread is recorded as `unverified:`. The key change comes
   next: the judge describes each span from the code alone, *before*
   comparing it to the artifact's sentence. A finding must say the claim is
   false as written. It can never say the judge would have designed it
   differently.
3. **Step 5 settles findings, pass and severity from evidence first, and
   writes `feedback` after.** `amend` uses the feedback field as its
   instructions, so the field stays. But a remedy written *during* the
   judgment recruits findings to justify itself. This is a change of order,
   not a removal.
4. **A "batch, then reason" hard rule applies to every dimension.**

The idea behind commit-first is borrowed, and the sources are worth naming.
A judge that reads the claim first and then the code scores plausibility.
A judge that describes the code first and compares after drops its
false-positive rate from about 0.72 to about 0.01 in the published
measurement (arXiv 2607.05904). Asking a judge for a fix alongside its
verdict makes false rejection worse (2603.00539). And in a corpus of
thirteen million agent sessions, inference was 88% of session time. Read
tools batched well there, while write and run tools did not (2608.00101).
Each finding matches what the correctness sessions showed.

**The replay.** Before shipping, we replayed the edits over the whole run
base: 55 build runs and 282 grade rounds, 117 of them routed to a fix arm.
A round can only flip if correctness was its *sole* blocker. Ten rounds
qualified, with 21 findings and 161 loop minutes between them.

We hand-classified them under the new rules, and zero of ten routes change.
Every finding that decided a route was a false-as-written claim backed by
observed evidence: a `beforeEach` used but not imported, a route reading a
channel that does not exist, and a replace anchor that cannot match after
an earlier phase. Two secondary findings would drop as design objections.
Neither decided its route. Every next-round verdict after those fixes
passed anyway, so nothing dropped would have come back.

| Correctness session | Observed | Projected |
|---|---|---|
| turns, median | 17 | ~6 |
| panel wall, median | 5.6 min | 2.6 to 4.3 min |

The projection is a model, so it ships with a live gate. The blocking-finding
rate per correctness verdict must stay within ±20% of the prior ten runs. If
the judge got faster by finding less, that gate will show it.

## The planner sees the inventory it is judged against

The third change closes a gap left by v2.8.

v2.8 gave `ship` and `build` a goal-derived acceptance inventory. It lists
observable outcomes drawn from your verbatim brief before planning, each
with a read-only command. The inventory goes to the completeness judge, and
`validate` runs it against the finished tree.

In `ship`, the planner got a contract too. `quick-plan` records a
disposition per item: `implemented`, or `deferred` with a reason. In
`build`, the port was incomplete. The inventory reached the judge and
`validate`, but never [`synthesize`](/docs/reference/skills/synthesize).
Build's planner never even received it.

Run `ea1c`, on the 20th, showed the cost. The brief was a one-line pointer
to a design review, so the inventory copied the review's suggested file
names, helper names and thresholds into its evidence commands. The plan
made better choices. But its only way to say so was a prose
"acceptance-divergence register" that declared five items failed by
recorded design.

| Time | What happened |
|---|---|
| 21:05Z | the completeness judge accepts the prose register at `low` |
| 00:05Z | `validate` reads only the frontmatter block, runs the five frozen commands verbatim, fails four, emits blockers |
| 00:32Z | `remediate` clears the one real gap by inserting the word `encoder` into a comment so a grep passes, correctly refuses the other four as not localized, and the no-op backstop halts the run with nothing committed |

About three hours ran after the divergence was already on record. The run
then ended on a halt whose fix was a plan edit, and nobody could make that
edit from `validate`.

Now build's `plan` stage reads `goal` and `acceptance`, and `plan-fix`
reads `acceptance`. `synthesize` gains one step: it writes an entry per
inventory id, in order, in the plan's frontmatter block. Both planners
share three dispositions:

| Disposition | The planner says | What `validate` does |
|---|---|---|
| `implemented` + `phase` | this phase's tree makes the command exit 0 as written | runs the inventory command |
| `deferred` + `reason` | not delivered, and here is why, with an `## Out of Scope` line | skips it, records the note |
| `rebound` + `phase` + `command` + `reason` | delivered, but the frozen command pins a mechanism the design changed; this replacement measures the same observable | runs the rebound command, records both under Deviations from Plan |

`rebound` is new, and it is narrow on purpose. The replacement command must
measure the *same* observable as the item's statement. It must reuse a check
the phase's own automated verification already runs. And it must not drop a
conjunct without saying why. If the substance was not delivered, the item
is `deferred`, never `rebound`. A rebound entry missing its command or
reason counts as undisposed, and the frozen command runs.

The completeness rubric closes the loop from the judging side. It checks the
inventory against the frontmatter block *only*. No block entry means
undisposed, whatever the prose says. An undisposed id, a dishonest
`implemented`, a weakening rebind or a dropped item is a blocking gap at
medium.

The rule that follows: the plan may change how an item is evidenced, never
whether it is required. A divergence is now ruled at the plan gate, where a
human sees it at design review, not at `validate` hours later.

The happy path is untouched. With no `--acceptance` on the dispatch, there
is no block and prompts are byte-identical. If every id is implemented, the
block is N one-line entries and nothing else is read or written. The whole
addition costs about 330 prompt tokens on a root merge. It costs nothing on
a sub-plan, which never carries the block.

## Where this leaves the pipeline

Every earlier release in this arc cut a halt or a wasted round. This one
cuts the time a clean run spends being judged, with verdicts held fixed by
replay. The next trails will show whether the projected panel times hold.
The live gate will show whether the judge got faster by finding less.

To watch it happen, run `/wf build "<brief>"`, step into a lane with `↓`,
and see `risk-rulings` land beside `correctness` instead of after it.
