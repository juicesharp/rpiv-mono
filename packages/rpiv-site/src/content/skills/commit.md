---
slug: commit
tagline: Reads the working tree, groups related changes into logical commits, and writes descriptive messages in the repo's style. Never amends, never adds AI attribution.
purpose: |
  Closes the implementation loop. Analyses staged + unstaged changes, splits them into atomic commits grouped by purpose (feature · fix · refactor · docs), and commits using the repo's style. Order is interchangeable with `code-review`.
when_to_use:
  - Work is finished and ready to land.
  - You want help splitting a noisy working tree into clean atomic commits.
  - Skip when the directory is not a git repo. `commit` stops and asks you to `git init`.
inputs:
  - name: $ARGUMENTS (commit hint)
    required: false
    source: Free-text hint or message. Empty falls back to inference from session history + `git diff`
outputs:
  - artifact: One or more git commits
    path: current branch
    format: imperative-mood messages, repo-style
key_steps:
  - title: Verify git availability
    rationale: Stops early when the directory is not a git repo. No commit attempt, no surprising side effects.
  - title: Read session context + `git diff`
    rationale: In-session runs leverage conversation history; cold runs rely on diff inspection. Both produce a why-not-just-what view that drives commit message quality.
  - title: Group files into atomic commits
    rationale: One logical change per commit. Mixed concerns (feature + bug + unrelated refactor) get split so future bisects land on the actual cause.
  - title: Confirm the plan with the developer before staging
    rationale: "`ask_user_question` shows the planned files and messages first. Catches grouping mistakes cheaply; correcting after a commit means a reset."
  - title: Stage by-name and commit; never `-A` or `.`
    rationale: Specific `git add` avoids accidental capture of `.env`, build artifacts, or unrelated WIP. Messages are written as if the user wrote them. No Claude attribution, no co-author lines.
related:
  upstream: [implement, validate]
  downstream: [code-review, changelog]
---
