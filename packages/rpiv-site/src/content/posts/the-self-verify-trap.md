---
title: "The self-verify trap"
description: "v1.8.2 shipped half its FRD. Here is what broke, why the design skill missed it, and which blueprint upgrade from this month would have caught it."
pubDate: 2026-05-17T23:30:00Z
author: juicesharp
tags: ["blueprint", "design", "post-mortem"]
draft: false
---

## What broke

`v1.8.2` moved pipeline artifacts from `thoughts/shared/` to
`.rpiv/artifacts/`. The FRD asked for two things: the rename, and the
elimination of the empty seven-folder tree that appeared on every
`session_start`. The rename shipped. The tree still appears in any repo
where `pi` starts, under the new path.

## Root cause

The design artifact contradicted itself. Its Decisions section recorded
*"Greedy scaffolding removal"*. The code block fifty lines below
introduced `ARTIFACTS_DIRS` and a `mkdirSync` loop carrying the
self-incriminating comment `// Phase 2: mirrors old scaffolding`. Plan
inherited the contradiction. Tests were rewritten to assert the wrong
behavior. The regression landed under a "Migrate artifacts" headline
that nobody read adversarially.

## Why design missed it

The skill that ran was `/skill:design`. Its verification pass is a
self-check: the model that just wrote the code audits it against the
recorded decisions. The author of a contradiction is the worst auditor
of it. Self-verify emitted OK.

## What blueprint catches

Two upgrades landed in `blueprint` this month.

The first is a post-finalization review gate. An `artifact-reviewer`
agent walks the finalized artifact, persists severity-tagged findings
into the artifact itself, and pins status at `in-review` until the
developer triages every row. Even silenced findings leave a paper trail.

The second is a per-slice verifier dispatched mid-generation, before the
slice is locked. Fresh context, replaced system prompt: *"Assume the
slice is wrong. The author has already convinced themselves it is
right."* Its commitments audit demands the slice quote the satisfying
clause for each recorded decision or emit `NOT FOUND`. Run this bug
through it: decision `Greedy scaffolding removal` on file, slice code
containing `mirrors old scaffolding`. VIOLATION before the developer
ever sees the slice.

## Lesson

Self-criticism is unreliable. Criticizing someone else's work is easy.
`design`'s self-verify is cheap in tokens (no extra dispatch) but spends
its scrutiny on the worst available seat: the author auditing their own
output. `blueprint`'s slice-verifier pays for one more subagent call and
gets a fresh reader in return, with no investment in the code being
correct. For this class of bug, the token premium buys the only audit
that catches it. The follow-up commit is on the branch.

## Takeaways

`design` was always meant to inherit blueprint's gates once they had
proven out under real use. Both `artifact-reviewer` and `slice-verifier`
landed in blueprint this month. The backport into `design` is now on
the roadmap: replace self-verify with the per-slice verifier, and add a
post-finalization review pass with a triage table.

Until then: prefer `/skill:blueprint` whenever the work fits a phased
plan. It is the more robust path today, and the one that catches this
class of bug before it ships. Reserve `/skill:design` for the cases
where the architectural decomposition genuinely needs to live as a
separately reviewable artifact.
