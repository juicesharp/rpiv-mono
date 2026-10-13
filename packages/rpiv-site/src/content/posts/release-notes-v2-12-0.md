---
title: "v2.12: a challenger for build"
description: "v2.12 adds meta, a second way to run the loop, plus an A/B harness to measure it against build. It also clears the pi 0.99.1 typebox warning, protects your uncommitted work during a run, and changes one rule in the grade skill."
pubDate: 2026-09-30T20:00:00Z
author: juicesharp
tags: ["release", "rpiv-pi"]
draft: false
---

v2.12 has one big addition and three small fixes. Nothing breaks and nothing
needs migrating.

The addition is `meta`, a new built-in workflow, with a new judging skill
under it. The fixes are a manifest change across eight packages, a guard that
protects your working tree, and one severity rule in `grade`.

One fix needs a reinstall, so we start there.

## The pi 0.99.1 warning

If you updated pi to 0.99.1 this week, every session opened with this
warning, once per installed rpiv extension:

```
Host-provided extension packages must be declared in peerDependencies
with a "*" range, not dependencies: typebox.
```

Pi bundles its own `typebox` and points extension imports at it. Eight of our
packages also listed `typebox` under `dependencies`, so npm installed a second
copy. Pi now checks every extension's manifest and flags this.

All eight manifests now declare `typebox` as a `"*"` peer. To clear the
warning, update your extensions:

```
pi update
```

The fix is [#282](https://github.com/juicesharp/rpiv-mono/pull/282), from
gucliti. It was one of six near-identical PRs opened within a day. Thanks to
everyone who sent one.

Thanks also to the commenters who tested it for real. They ran the 0.99.1
loader on a tree with no physical `typebox`, and both extensions loaded
through pi's copy. That settled the last open question: `rpiv-config` could
drop its copy too.

A follow-up guard is in review. It will fail the build if a host-provided
package ever lands in `dependencies` again.

## meta: a graph of self-correcting units

`build` is the workflow this blog has followed since v2.0. It slices a brief,
designs each slice, plans, elaborates, and implements phase by phase. A panel
of five or six judges grades every artifact. It finishes large work:
[One day of the loop](/blog/one-day-of-the-loop) shows a whole device family
built in one run.

But we have never tested its shape against an alternative. We looked at 52
real `build` runs in one project. Here is what the trails show:

- Every fix round was whole-batch. 90 amend rounds rewrote the entire plan,
  and 193 panel runs re-graded all of it.
- The confirm pass upheld 40 of 40 failures it re-examined. Each took about
  six minutes.
- The demote pass demoted 0 of 193 verdicts.
- 7 of about 45 multi-round loops got worse partway through.
- Every final halt came from a corrector that could not reach the cause.

Each of these is a `build` design choice that does nothing, or does harm.
`meta` tests the opposite choices, one at a time.

### What a unit is

A `meta` workflow is an ordered list of units. Each unit is one loop:

```
produce → checks (code, first) → graders (LLM lenses, parallel) → gate
   ↑                                                               │
   └── fix (return record: unit, verdict, reason, evidence, scope) ─┘
```

Everything that differs from `build` happens inside that loop.

**Checks run first and stop early.** Each unit has deterministic checks, such
as citation counts, acceptance commands, or "the tree changed." They run
before any model is called. If a check fails, no grader runs.

**Graders use one or two lenses, not a panel.** A new skill, `lens-grade`,
judges one target through one lens. It uses a pass or fail rubric and writes
one JSON verdict. It only judges: it never edits, runs code, or spawns
anything. Lenses run in parallel, one session each. There is no confirm pass
and no demote pass.

**A failed gate sends back only what failed.** The corrector gets a return
record with the unit, the verdict, the reason, and the evidence as
`file:line`. It also gets a scope line: touch only what the evidence cites.
It does not get the whole artifact to rewrite.

**The loop knows when it is stuck.** Each unit has a `maxRounds`, capped at
four. If the same failure comes back on two rounds in a row, the loop stops.
It does not spend the rest of its budget on the same answer.

**A unit that runs out of rounds has three exits.** It can halt. It can accept
the failure and move on. Or it can escalate to an earlier unit. Escalation
starts a new generation at both ends. So if a failing implementation reopens
a plan, the plan is judged fresh, not against its old verdicts. Every loop
decision is saved on the gate record, so a resumed run makes the same choices.

**Finished runs teach the next one.** When a run reaches the end, it writes
every failure it corrected to `.rpiv/lessons/meta-lessons.json`. Each entry
is keyed by unit and reason, and counted. On the next run, that unit's
producer reads the most frequent ones as standing rules in its brief. The
fix loop repairs the current run. The lessons file improves every run after.

### The built-in graph

`/wf meta "<brief>"` runs five units:

| Unit | Skill | Checks | Lenses | Rounds | Exhausted |
|---|---|---|---|---|---|
| research | `research` | artifact written, 5+ citations | grounding | 2 | halt |
| acceptance | `acceptance` | artifact written, well-formed | none | 2 | halt |
| plan | `quick-plan` | written, plan citations, every acceptance item disposed | correctness, completeness | 3 | halt |
| implement | `implement`, fanned out by phase | tree changed, acceptance commands pass | goal | 3 | escalate to plan |
| commit | | | | | |

These are the same skills `build` and `ship` use. That is on purpose. An A/B
between the two then measures the loop's shape, not the prompts.

Four units compile to 17 engine stages, all generated. `build` has about 35,
wired by hand.

### What meta gives up

`meta` has real gaps, and any of them could make it worse:

- **No slicing and no parallel design.** A large brief becomes one plan.
  Decomposition is `build`'s strongest feature on big work.
- **Four fewer lenses.** Actionability, pattern-following, architecture-fit,
  and risk rulings are gone. In our runs they failed in 3 to 8% of panels.
  Rarely is not never.
- **No human checkpoint** before the end.
- **Noisy lessons.** They are raw failure reasons, not distilled rules, so
  they stay noisy until the counts build up.

That is exactly why the A/B harness ships with it.

### The A/B harness

`meta/ab.mjs` runs both workflows on the same brief from the same commit.
Each gets its own git worktree, so they run in parallel:

```
node ab.mjs setup   <repo> <label> "<brief>"
node ab.mjs compare <repo> <label> --eval "<your check>"
```

`compare` reports, for each arm: outcome, wall clock, active time, sessions,
tokens, stage visits and re-entries, rounds per unit, and the diff.

It also runs a shared scorecard. Your `--eval` commands and every arm's frozen
acceptance commands run on every arm's tree. No arm is graded only by its own
standard. Write your `--eval` checks before you look at either result.

We have no results yet. When the first paired runs are in, they get their own
post, whichever way they go.

## The run that touched your work

The first `meta` runs already exposed one problem.

On the 27th, we ran `edef` on a project with an uncommitted, unrelated
popover redesign from the night before. The implement unit's goal lens graded
the whole working-tree diff, including the redesign. It flagged the redesign
as something the goal did not ask for. The scoped fix then did exactly as
told: it touched only the files the evidence named, and ran `git checkout --`
on them.

`build` and `ship` subtract the run-start state from everything they judge.
`meta` did not. Now it does, in three layers:

1. **Backup at run start.** The run saves your existing uncommitted changes:
   a binary patch of tracked paths, copies of untracked ones, and a record on
   the goal channel.
2. **A check on every side-effect unit.** Each one confirms the pre-existing
   paths are still dirty. If one is not, the run stops at once with no
   correction round. The note names the restore command.
3. **Limits on graders and correctors.** On side-effect units, they judge only
   this run's changes and get the list of pre-existing paths. They cannot use
   `checkout`, `restore`, `reset`, `stash`, or `clean`.

The first layer matters most. Even if the other two fail, a run cannot lose
your work.

## One rule change in grade

v2.11 changed how `grade`'s correctness judge works. It learned to describe
code before comparing it to a claim. It also learned to rate a false claim in
copied text, like a code block or doc comment, at `medium`, even when the
code behaved correctly.

That second rule went too far. Now, a finding that can only be fixed by
editing text is `low`, even if the text is wrong. Examples are a comment, a
stale date, an attribution, or a fixture label. No executable line changes,
and no later stage fails, so it should not block the gate. It is still
reported, and `amend` fixes it along the way.

One rule stays the same: a claim that fails as written is `medium` or worse.

## Try it

```
/wf meta "<brief>"
```

Press `↓` to step into a lane and watch a unit's checks land before its
lenses do.

Have a brief you would normally give to `build`? Run it through both with
`ab.mjs` and send us the report.