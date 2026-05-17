---
title: "Reset between skills"
description: "Run each skill in a fresh context. Why the artifact-on-disk handoff exists, and how to implement multi-phase plans."
section: "guides"
order: 2
---

The pipeline's design rests on one operational rule: **every skill boots with a clean context window**. Between any two skill invocations, run `/new` (or whatever your harness calls "clear context") before kicking off the next one.

The artifact-on-disk handoff exists precisely for this reason. Each skill writes its output to `.rpiv/artifacts/<stage>/`, and the next skill reads it back. The chain is durable, not stateful: your next session can pick up a half-finished run without losing context, because state lives in markdown files, not the chat window.

Skipping the reset is the single most common cause of muddled output.

## The reminder pattern

The skills themselves emit a hand-off reminder when they finish:

```
🆕 Tip: start a fresh session with /new first
```

It applies to every transition in the chain, not just the one you just saw. The tip is a polite nag; the rule is hard.

## When NOT to reset

One case only: **within a single skill invocation**. `discover` runs a one-question-at-a-time interview inside one call, and `code-review` dispatches parallel specialist agents inside one call. The reset rule applies between skill *invocations*, not within them.

Every other transition resets. That includes phase-by-phase `/skill:implement` (see below).

## Implementing a multi-phase plan

If your plan has a single phase or is small enough to land in one shot, run:

```
/skill:implement .rpiv/artifacts/plans/<plan>.md
```

This executes every phase in a single invocation. One session, one pass, done.

For larger plans with multiple phases, run **one phase per session** with a reset between every phase:

```
/skill:implement .rpiv/artifacts/plans/<plan>.md Phase 1
```

Then `/new` to reset the context, review the diff, and run the next phase in a fresh session:

```
/skill:implement .rpiv/artifacts/plans/<plan>.md Phase 2
```

The plan artifact carries state between phases. It tracks `- [x]` completion markers as each success criterion lands, so a fresh context per phase keeps the agent focused on the slice in front of it instead of dragging accumulated chat noise from earlier phases.

## Next steps

- [Pick your path](/docs/guides/pick-a-path): which chain to run for what you're shipping
- [Handoffs](/docs/guides/handoffs): pause the pipeline and resume it later from a fresh session
- [Walk the chain](/docs/guides/first-skill-chain): the mid-size path demonstrated end-to-end
