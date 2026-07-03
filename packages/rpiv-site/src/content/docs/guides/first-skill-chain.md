---
title: "Walk the chain"
description: "Walk discover → research → blueprint → implement → validate → code-review → commit on a real feature, one artifact at a time."
section: "guides"
order: 1
---

The skill chain is rpiv-pi in motion. One skill produces an artifact, the next reads it, the next reads that. By the time you reach `/skill:implement` the agent already knows what to build and why. The decisions live in markdown files, not the chat window.

This guide walks **the mid-size feature path** on a single example: **adding a password-reset flow to a web app**. You answer one question at a time. The skills do the rest. For other scopes (small fixes, large architecture work), see [Pick your path](/docs/guides/pick-a-path).

> **Reset between every step.** Run `/new` (or your harness's equivalent) before each `/skill:*` invocation below. The chain hands off through markdown files in `.rpiv/artifacts/`, not the chat transcript. See [Reset between skills](/docs/guides/reset-between-skills) for why.

> **A note on filenames.** The artifact paths below are shown as `…/password-reset.md` for readability. On disk every skill timestamp-prefixes its output (the real file is `<YYYY-MM-DD_HH-MM-SS>_password-reset.md`), so multiple runs on the same topic never clobber each other.

## 01 · Discover *(optional)*

Start with a vague intent. No code is read yet.

```
/skill:discover add a password reset flow
```

`/skill:discover` interviews you one question at a time. It starts with **foundational intent** (what the feature must do for users) before any codebase probe runs. Each answer narrows the next question. Pre-resolutions surfaced by a light probe come up for confirmation, never silent inference.

**Output**: a Feature Requirements Document at `.rpiv/artifacts/discover/password-reset.md` with Goals, Non-Goals, Functional Requirements, Acceptance Criteria, and a **Decisions** block. The Decisions block is what every downstream skill inherits.

**Skip this step** if you already have a spec or ticket; pass it as free-text directly to step 02.

## 02 · Research

Hand the FRD (or your spec) to research.

```
/skill:research .rpiv/artifacts/discover/password-reset.md
```

`/skill:research` dispatches the `scope-tracer` subagent to formulate trace-quality questions like *"which flows already touch the user-auth table?"* or *"where does the session refresh logic live?"*, then answers them with parallel analysis agents. Every claim is grounded with a `file:line` citation.

**Output**: one synthesized research document at `.rpiv/artifacts/research/password-reset.md`. Blueprint reads this instead of re-scanning the codebase.

## 03 · Blueprint

Research becomes an implement-ready plan in a single step. `/skill:blueprint` collapses the canonical `design` and `plan` steps into one pass, the right default at this scope. On large or architecturally load-bearing work you'd run them separately instead; see [Pick your path](/docs/guides/pick-a-path) for which scope gets which chain.

```
/skill:blueprint .rpiv/artifacts/research/password-reset.md
```

`/skill:blueprint` decomposes the feature into **vertical slices**, the smallest units that can land independently. One slice becomes one phase, each with explicit success criteria for what proves it done. Blueprint also embeds developer micro-checkpoints between phases so you can steer mid-flight, instead of waking up to a finished branch you never reviewed.

**Output**: an implement-ready plan at `.rpiv/artifacts/plans/password-reset.md` with atomic phases, success criteria, parallelization notes, and the micro-checkpoint prompts.

## 04 · Implement (loop)

The chain ends in code, one phase at a time.

```
/skill:implement .rpiv/artifacts/plans/password-reset.md Phase 1
```

`/skill:implement` runs a **single phase per call**. It applies the phase's changes, runs the success criteria from the plan, and **refuses to mark the phase complete until they pass**. If they fail it stops, surfaces the failure with recovery context, and waits.

Then you review. This is the micro-checkpoint blueprint embedded between phases. Look at the diff. If it's good, run the next phase.

```
/skill:implement .rpiv/artifacts/plans/password-reset.md Phase 2
```

Loop until every phase ships. No new markdown artifact gets written; the output is your code edits plus phase-verification logs in the plan (`- [ ]` flipped to `- [x]` as each success criterion lands), paused at every checkpoint for your review.

## 05 · Validate

An independent re-check.

```
/skill:validate .rpiv/artifacts/plans/password-reset.md
```

`/skill:validate` re-reads the plan and re-runs the success criteria against the working tree as it stands now. It produces a pass/fail row per criterion with drift notes for anything `/skill:implement` finished but didn't quite finish. The second pair of eyes the chain needed but never got.

**Output**: a validation report at `.rpiv/artifacts/validation/password-reset.md`, with a `verdict: pass | fail` in its frontmatter.

## 06 · Code-review

A multi-lens review over the whole diff.

```
/skill:code-review
```

`/skill:code-review` runs parallel specialist agents across its Quality, Security, and Dependencies lenses (plus peer-mirror, precedent, and CVE checks where they apply) and writes a review document. It's the most token-hungry skill in the pipeline, but it does A+ work for the cost. You can also drop it in anywhere ad-hoc, not just here.

**Output**: a review document at `.rpiv/artifacts/reviews/<slug>.md`.

## 07 · Commit

Group the changes into logical commits.

```
/skill:commit
```

`/skill:commit` analyzes the staged and unstaged diff, groups related changes by purpose, drafts commit messages in the repo's style, and asks for one confirm before writing the commits.

**Output**: one or more git commits.

The order of 06 and 07 is your call. Review-then-commit folds findings into the message and groups fix-ups with the change. Commit-then-review locks the diff first and addresses findings in a follow-up.

## When the plan needs to bend

Reviews surface real flaws. Phases hit obstacles the design didn't anticipate. The chain doesn't reset; you `/skill:revise` the plan to surgically update it in place, then resume `/skill:implement` from the affected phase. `revise` preserves structure rather than rewriting from scratch.

## The shape of a chain

Each command takes the previous step's artifact path. State lives in `.rpiv/artifacts/…`, not in the conversation. That's the whole point. Your next session can pick up the chain mid-flow without losing context, and the agent never has to re-derive earlier decisions.

If you skip a step, the next skill notices and offers to run the missing one. If you revise an artifact mid-flight, downstream skills pick up the new version on the next invocation. The chain is durable, not stateful.

## Next steps

- [Pick your path](/docs/guides/pick-a-path): five paths mapped to feature scope (trivial to large)
- [Reset between skills](/docs/guides/reset-between-skills): the fresh-context rule between every transition
- [Skills reference](/docs/reference/skills): every skill and what it writes
- [Agents reference](/docs/reference/agents): the specialists skills dispatch internally
