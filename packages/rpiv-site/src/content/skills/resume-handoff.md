---
slug: resume-handoff
tagline: Reads a handoff document, re-verifies the working tree against it, and continues exactly where the previous session stopped.
purpose: |
  The other half of the `create-handoff` pair. Reads a handoff document plus every artifact it points at, re-validates that the working tree still matches the handoff's claims, and proposes the next action. The new session then re-enters with full grounded context, not just memory.
when_to_use:
  - You're starting a fresh session and need to continue from yesterday's work.
  - Someone else handed you a handoff doc and you need to pick up cold.
  - Skip when there's no handoff. Start with `discover` / `research` instead.
inputs:
  - name: handoff path
    required: true
    source: Path to `.rpiv/artifacts/handoffs/*.md`
    notes: Plans, research, and solutions linked from the handoff are read directly.
outputs:
  - artifact: Validated session context + next-action proposal
    path: in-session message
    format: prose summary
key_steps:
  - title: Read the handoff and every linked artifact fully
    rationale: Plans, research, and solutions referenced by the handoff are read directly (no skill dispatch) so the resume agent starts with the same evidence base the previous session had.
  - title: Spawn focused research agents to refresh artifact context
    rationale: Parallel `general-purpose` agents re-read artifacts and extract decisions concurrently, so context warm-up is fast even with multi-document handoffs.
  - title: Verify working-tree state against "Recent changes" / "Learnings"
    rationale: Files cited by the handoff are re-read at HEAD; `git log`/`git diff` is used to detect drift since the handoff was written. Surfaces deltas before the agent commits to "continue".
  - title: Synthesize and present the current situation
    rationale: A side-by-side of handoff status vs. current state gives the developer a chance to redirect before the resume agent acts on stale assumptions.
  - title: Confirm next action, then resume
    rationale: Action items from the handoff aren't trusted blindly. The resume agent re-proposes the next step against verified state and waits for confirmation.
related:
  upstream: [create-handoff]
  downstream: [implement, plan, design]
---
