---
title: "Handoffs"
description: "Pause the pipeline and resume it later from a fresh session, using create-handoff and resume-handoff."
section: "guides"
order: 3
---

The pipeline itself is durable: state lives in `.rpiv/artifacts/` markdown artifacts, not in the chat transcript. But **mid-skill state** (the active todo list, recent decisions, in-flight file changes you've half-applied, open questions) doesn't make it into the artifacts. For that, use handoffs.

A handoff is a compact snapshot of where you are: the current task, decisions made so far, in-flight changes, and open questions. You write it before closing the session; the next session reads it back and picks up exactly where you left off.

## When to use a handoff

- The session is getting long and you want to compact context before continuing.
- You're stopping for the day, the weekend, or until you've slept on a decision.
- You're handing the work to a teammate, or to yourself in a different harness.
- You're about to switch to a fresher model and want to preserve recent reasoning.

You DON'T need a handoff between pipeline skills. The artifact-on-disk handoff handles that. Handoffs are for **mid-skill** state, or for pauses where the next-step artifact alone wouldn't be enough to bootstrap a new session.

## Create a handoff

Inside your current session, when you're ready to pause:

```
/skill:create-handoff
```

`/skill:create-handoff` compacts the active task, recent decisions, in-flight file changes, and open questions into a single markdown file. It's intentionally concise: enough for a fresh session to pick up, not a full transcript.

**Output**: a handoff document under `.rpiv/artifacts/handoffs/<YYYY-MM-DD_HH-MM-SS>_<topic>.md` (timestamp-prefixed, like every other artifact skill).

`create-handoff` sits to the side of the main chain. Only `implement` surfaces it, as an optional next step for session pauses, and no skill *requires* a handoff to continue. You reach for it deliberately: invoke `/skill:create-handoff` yourself, or let the agent surface it when the session is getting large or you ask to wrap up. Pausing is a decision you make, not a step the chain takes on its own.

## Resume from a handoff

In a new session (fresh context, possibly a different machine), point `resume-handoff` at the handoff file:

```
/skill:resume-handoff .rpiv/artifacts/handoffs/<YYYY-MM-DD_HH-MM-SS>_<topic>.md
```

`/skill:resume-handoff` reads the handoff, verifies the current repo and branch state (warns if things have drifted since the handoff was written), and continues from the next step the handoff identifies. It's interactive: it asks before assuming.

## Where handoffs live

The whole `.rpiv/artifacts/` tree is gitignored by design, handoffs included. They live locally on the machine that wrote them. To hand off to a teammate, share the handoff file directly: commit it to a working branch, paste the contents in chat, copy it across machines. The pipeline never depends on handoffs for chain integrity; they're a convenience layer over the durable artifact chain underneath.

## Next steps

- [Reset between skills](/docs/guides/reset-between-skills): the every-transition reset rule that makes most handoffs unnecessary
- [Pick your path](/docs/guides/pick-a-path): the workflows handoffs slot into
