---
title: "One morning of the loop"
description: "Issue #32 from a two-part feature request to a second approved review in three and a half hours. A walk-through of what driver-in-the-loop looks like when you can read every artifact along the way."
pubDate: 2026-05-18T16:00:00Z
author: juicesharp
tags: ["workflow", "case-study", "blueprint", "code-review", "alignment"]
draft: false
---

The interesting failure mode in LLM-assisted development isn't bugs. It's a
class of code that compiles, passes tests, ships, and quietly degrades the
codebase: locally correct, globally misaligned. Closing the alignment gap
takes a driver in the loop. What follows is what one morning of that loop
looks like.

At 7:58 AM, GitHub issue #32 was a two-part feature request. By 11:34 AM
the same morning, it had shipped twice. Two commits, two approving code
reviews, zero blockers. The code change was small, around 330 lines across
five files. The interesting part isn't the code. It's the choreography
that produced it.

## The task

`disabledForModels` is a config knob in `rpiv-advisor`. It is a list of
model identifiers like `"anthropic:sonnet"` or `"openai:gpt-5.5"` for
which the advisor tool is silently stripped. Useful if you don't want a
junior model second-guessing a senior one.

Issue #32 asked for two things at once: handle recursive
self-consultation, and fix the "effort-level blind spot", the inability
to say "block this model only when it's thinking hard." The two are
tangled in the issue text but they aren't the same problem. A good first
move is to untangle, not to code.

That is what the first skill is for.

## /discover: scope is a deliverable

The developer didn't open `advisor.ts`. They ran `/discover`, which
produced an FRD.

`/discover` interviews. It asks targeted questions and records each
answer as a *decision* with a one-line rationale. For example:

> **Q (Scope):** Who hits the recursive self-consultation problem and
> the effort-level blind spot today?
> **Chosen:** Effort-level filtering only. Recursive is explicitly out
> of scope.
> **Rationale:** Developer stated "Recursive is not a problem."

Five decisions like this got locked: field name (`minEffort`, not
`effort`), validation behavior (silent-drop, no normalization), where
the executor's effort level comes from (Pi session context). One
question got marked **unresolved** and pushed forward: *"Is
`ctx.thinking` available at `before_agent_start`?"* Let research figure
that out.

This is the first thing the loop does differently from "just start
coding." Half of issue #32 was dropped on purpose, and the drop is
recorded with reasoning. The skill structures human involvement as
participation, not approval: the developer decides what's in scope and
what isn't, and the FRD captures *both* halves of that decision.
Nothing falls through the cracks because the skill literally writes a
`## Non-Goals` section that has to be filled in.

Time: 11 minutes.

## /research: verify before you plan

The FRD's open question got handed to `/research`, which spun up
parallel agents to read the relevant code, the upstream Pi types, and
similar past changes.

It came back with five findings the developer would have hit *during*
implementation otherwise:

1. The FRD's assumption was wrong. `ctx.thinking` doesn't exist. The
   thinking level lives on `pi.getThinkingLevel()`, the extension API,
   not on `ExtensionContext`.
2. There is a type mismatch in upstream. `pi-ai` exports a 5-value
   `ThinkingLevel`; `pi-agent-core` exports a 6-value one that includes
   `"off"`. Handle this at the comparison layer.
3. One handler must be rewritten. `before_agent_start` currently only
   strips the advisor and never re-adds it. Effort-aware logic forces
   it to become bidirectional.
4. There are four call sites, not two: `before_agent_start`,
   `model_select`, `restoreAdvisorState`, and the `/advisor` command
   itself.
5. The mock factory is broken. `createMockPi` doesn't include
   `getThinkingLevel`, so the next test that calls it will throw a
   `TypeError`.

The part most people skip past: `/research` also pulled precedents. It
found commit `588792b` ("per-executor-model blocklist") and its code
review. That review had three findings on file: a stale
`getActiveTools()` snapshot after an `await`, a `disabledForModels`
field that survives `saveAdvisorConfig` only through a `{ ...existing }`
spread with no round-trip test, and an `event.model` vs `ctx.model`
divergence note.

Those findings get distilled into "Composite Lessons" at the bottom of
the research artifact. Every one of them shows up in the plan as a
defensive measure. Past code-review findings auto-flow into future
plans. This is the part of the workflow most people underestimate.
Bugs that were fixed once tend to recur in adjacent features, and
`/research` is what stops the recurrence.

The research artifact also forwards the FRD's six question-answer pairs
verbatim into its own `## Developer Context` footer, then adds a
seventh checkpoint question (*"add a `thinking_level_select` handler,
or defer to before_agent_start?"*) answered mid-session. Skills hand
context forward whole, not summarized, so the next stage reads
everything the previous stages decided.

Time: 19 minutes.

## /blueprint: the plan is the contract

The `/blueprint` skill read the research and produced a four-phase plan,
each phase a diff plus success criteria:

1. **Foundation.** Types, validation, ordinal helper, blocking predicates.
2. **Existing handler updates.** Thread `pi.getThinkingLevel()` through
   four call sites; make `before_agent_start` bidirectional.
3. **New `thinking_level_select` handler and wiring.** Mirror
   `model_select`'s strip/re-add pattern.
4. **Tests.** 15 new tests covering at-threshold, above, below,
   `"off"`, and config round-trip.

The plan's `## Verification Notes` cites the v1 review verbatim:
*"Stale snapshot after `await`. Precedent: `588792b` review finding I1.
Config round-trip. Precedent: `588792b` review finding I2."* The plan
is written defensively against the exact bugs the last cycle caught.

But the most interesting thing in the plan happened before the
developer ever saw it.

`/blueprint` has two internal self-checks, and they are designed against
a single failure mode: same-model, same-context self-validation. A
verifier that inherits the author's chat anchors on the same framings,
ratifies instead of attacks, and waves through tests that encode the
author's mental model rather than probe it. The cure is fresh context,
every time.

The slice-verifier runs *during* decomposition, in a separate context.
On this plan it found a redundant "same-level no-op" test in Phase 4
and removed it before finalization. The plan that hit the developer's
screen was already trimmed. The audit trail is preserved in the
footer: *"Phase 4: Tests, approved as generated (removed 'same-level
no-op' test per slice-verifier finding)."*

The artifact-reviewer runs *after* finalization, also in a separate
context. It caught that Phase 4's verification block claimed "13 new
tests" when the actual count was 15. Marked `applied: corrected test
count to 15`.

These aren't redundant. The first prevents content drift; the second
prevents accounting drift. The plan that goes into implementation has
been twice-checked, both passes adversarial, both in contexts that
haven't been pre-anchored by the plan's author.

Time: 20 minutes including both self-checks.

## Implement, /validate, /commit

The developer executed the plan phase by phase, running `npm run check`
and `npm test` between phases. Nothing dramatic.

Then `/validate` ran. It does not produce its own artifact, and that is
the design. It mutates the plan in place, ticking each
success-criterion checkbox:

```
- [x] Type checking passes: `npm run check`
- [x] Existing blocklist tests still pass
- [x] EFFORT_ORDINAL constant is correct
- [x] before_agent_start handler has both strip and re-add branches
```

By the time the last `[ ]` flipped to `[x]` (there were 17), the plan
*was* the validation report. There is no sidecar doc to keep in sync.

Then `/commit` wrote the message. Look at it next to the plan:

> `feat(rpiv-advisor): add effort-level filtering for disabledForModels`
>
> Extend disabledForModels from flat string[] blocklist to support
> { model, minEffort } entries that block only when the executor's
> thinking level meets or exceeds a threshold. Add thinking_level_select
> handler for immediate strip/re-add on effort changes mid-session.
> Make before_agent_start bidirectional (re-adds when effort drops).
> Thread pi.getThinkingLevel() through all four blocking call sites.

It uses the plan's own vocabulary: "thread through all four blocking
call sites", "bidirectional". That is not paraphrasing; `/commit` reads
the plan. The result: `git log` is one navigation hop from the artifact
tree. A developer six months from now can `git show b44024e`, find the
plan, find the research, find the FRD, and reconstruct *why*.

`/commit` always runs before `/code-review`. The commit gives the
review a stable artifact to evaluate, and the review's frontmatter
records the commit hash in scope. Both are addressable forever.

Time: 75 minutes for all of phase-by-phase implementation plus validate
plus commit. Commit `b44024e` was born.

## /code-review: more than a checklist

If you only read the summary, this is the skill that looks simplest. It
isn't.

The review of `b44024e` came back `approved` with three suggestions and
four discussion items. Easy summary. But peek at the frontmatter:

```
verification: { verified: 4, weakened: 3, falsified: 0 }
```

There were seven candidate findings. The skill's own verification pass
demoted three from suggestions to discussion items, which is why some
findings appear as 💭 in the artifact. The review self-corrects before
the developer reads it.

The Recommendation block names internal mechanisms most reviews never
expose:

> *"Cascade-detection triples confirm zero hits. No stranded state
> (EFFORT_ORDINAL `indexOf` semantics are correct), no
> duplicate-processing (handlers are idempotent check-then-set), no
> contradictory-predicate deadlock."*
>
> *"Precedent weighting: Precedent 1 (`588792b`) has follow-up count =
> 1 (this commit itself), threshold is ≥ 2. No precedent weighting
> bumps apply."*
>
> *"Target status: `approved`."*

Three things to notice.

Named failure modes. Stranded state, duplicate processing,
contradictory predicates. Every review checks for these explicitly, not
just "does the code look right."

Quantitative precedent weighting. A bug pattern with ≥2 follow-up fixes
auto-bumps the severity of new findings in the same area. Past pain
gets weighted.

The skill commits to a verdict. "Target status: approved." The review
is a decision, not a question.

It also includes an `Impact` table mapping the `test-utils/pi.ts` mock
change to 20+ test files across 8 packages. That is automatic
blast-radius analysis no human bothers to compile by hand.

The three approved suggestions: a dead `?? { provider: "", id: "" }`
fallback that is unreachable; an `/advisor` command-handler effort path
not directly covered by tests; a module JSDoc still claiming "three
lifecycle hooks" when there are now four. Not blockers. The *next*
plan.

Time: 25 minutes.

## Round two, in a quarter of the time

`/blueprint` ran again, this time producing a three-phase plan, one
phase per accepted finding, all independent. Crucially, it also wrote
a `## What We're NOT Doing` section naming the four discussion items
explicitly with reasoning for each deferral:

> *"Q4 (silent re-add in before_agent_start): Intentional by cadence.
> Documenting is optional, not blocking."*

This is the workflow's spine. You can't silently drop work. Every
dropped item gets named.

The plan's Step 10 review came back clean: *"No findings.
Artifact-reviewer cleared the artifact."* The slice-verifier didn't
fire either. That is a clean signal: this really is a trivial
three-phase change, not a feature pretending to be one.

Implementation, validate, commit, review. 35 minutes total. Commit
`115ce77` landed. Review #2 came back `approved` with one optional
suggestion (`ctx.model!` non-null assertion, extract a guard if you
want). Done.

Review #2's precedent table now lists `b44024e` as a same-day follow-up
to itself. The system tracks its own iteration cycle.

## The shape

```
07:58  /discover        FRD: scope-narrowed, 5 decisions, 1 open Q
08:09  /research        verified assumptions, pulled precedents,
                        4 composite lessons
08:28  /blueprint       4 phases; slice-verifier removed 1 redundant
                        test; artifact-reviewer corrected test count
09:43  commit b44024e   impl + /validate + /commit
10:08  /code-review     verified 4, weakened 3, falsified 0; approved
10:35  /blueprint       3 phases for Q2/Q5/Q6; 4 deferrals named
11:19  commit 115ce77   impl + /validate + /commit
11:34  /code-review     1 optional finding; approved
```

Three and a half hours. Two commits. Six artifacts. Two reviews. Issue
#32, at least its effort-level half, is in production.

## What the developer brought

Reading this, it is tempting to credit the skills. Don't. The developer:

- Decided to drop half of issue #32 and could defend the drop.
- Recognized that "`before_agent_start` must become bidirectional" was
  the highest-risk change and watched it.
- Triaged seven review findings into "fix these three now, defer those
  four, here is why."
- Read every artifact. The skills produce them; the developer owns
  them.

The skills do not write the code. They structure the conversation
between intent and codebase. Participation, not approval.

## What the loop brought

Things the developer would, realistically, have skipped:

- Forcing the FRD's open question to be resolved *before* coding.
- Pulling the v1 blocklist's three review findings into the new plan's
  verification list, so the same stale-snapshot bug couldn't happen
  twice.
- Sending the plan itself through an adversarial review before any code
  gets written, in a fresh context, with findings triaged on the
  artifact.
- Verifying and weakening review findings instead of dumping all seven
  on the developer.
- Computing the 20+ files and 8 packages blast radius.
- Recording the four deferred findings with reasons, instead of leaving
  them to atrophy in someone's head.

These are the boring, careful, load-bearing parts of professional
engineering. The skills do them without negotiation.

## Why this shape

LLMs produce correct code, not aligned code. Output compiles and passes
tests, but doesn't necessarily fit the codebase's existing patterns,
respect conventions that aren't written down anywhere, make the boring
choices mature systems rely on, or stay reviewable and extensible by
the next person who touches the file. Closing that gap takes an
experienced engineer who carries the context the model can't have. The
realistic operating model for the whole interval where fully autonomous
coding is structurally out of reach is a driver in the loop.

Misaligned code isn't zero-value. It is negative-value. It compiles, it
ships, then it taxes every engineer who reads that file afterward and
costs the next refactor a half-day of reasoning about near-duplicates
that shouldn't exist. The cost of a driver-in-the-loop pipeline is
latency, paid up front and visible on a dashboard. The cost of skipping
it is alignment debt, paid later, by someone else, and rarely traced
back to the diff that caused it.

Three and a half hours of latency was visible on the dashboard this
morning. Zero alignment debt got created in exchange. That is the trade
the loop is designed to make.

On GLM 5.1, no less. With proper orchestration, affordable models ship
production-ready features.

## Three things to take home

**Artifacts are the unit of work, not commits.** Commits are how
artifacts land in the codebase. `git log` is just the table of
contents; the chapters live in the artifact tree.

**Lessons compound.** A bug caught in the v1 blocklist review
(`588792b`, finding I1) became a composite lesson in research, became a
verification note in the v2 plan, became a defensive change in the v2
implementation, became zero recurrence in the v2 review. One bug, four
artifacts, doesn't come back. That is the loop that actually pays for
itself.

**Skills don't replace knowledge. They make it transferable.** Anyone
reading the artifacts three months from now can reconstruct what was
decided and why. Including you.
