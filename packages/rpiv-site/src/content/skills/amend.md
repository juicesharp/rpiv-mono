---
slug: amend
tagline: Surgically revises one artifact to clear the failing dimensions a grade panel flagged, re-emitting it in place so the gate re-judges the same channel.
purpose: |
  Closes a gate's fix loop *without* a wholesale rewrite: it applies only what the failing verdicts cite and leaves passing content byte-for-byte. The pipeline loops the re-emitted artifact straight back to the grade panel — that re-judging is the only validation, so the skill never self-reviews or asks questions.
when_to_use:
  - Dispatched as the revise stage of the pipeline's plan-fix and code-fix loops, after a grade panel returns failing verdicts.
  - Any graded artifact (research, plan, spliced code-bearing plan) needs targeted correction, not redesign.
  - Prefer `slice` in re-slice mode when the failure is structural — `amend` may touch only cited lines and cannot split a slice or break a dependency cycle.
inputs:
  - name: artifact
    required: true
    source: The single `--<channel>` flag not ending in `-verdicts`
    notes: Parsed generically, agnostic to the channel name — the same reviser serves every gate.
  - name: verdicts
    required: true
    source: "`--<channel>-verdicts <path>` (repeatable), verdict JSONs under `.rpiv/artifacts/verdicts/`"
    notes: Grouped by dimension; only the latest verdict per dimension counts.
outputs:
  - artifact: The revised artifact, re-emitted at its SAME path
    format: "unchanged — Edit in place, `status: ready` preserved, `last_updated` bumped"
key_steps:
  - title: Read the artifact fully and every verdict JSON
    rationale: Verdicts accumulate across fix loops, so an older failing verdict may already be superseded — only the latest per dimension (by `graded_at`) reflects the gate's current judgment.
  - title: Select only the failing findings
    rationale: Dimensions that pass are settled; touching them risks regressing a pass and expands the diff the panel must re-judge for no gain.
  - title: Apply each finding's feedback surgically at its `where` anchor
    rationale: The verdict's `feedback` is the instruction set and `where` locates the exact spot — changes no finding asked for are scope creep the panel never sanctioned.
  - title: Ground codebase-dependent fixes by reading, never editing, the repo
    rationale: The boundary is the working tree — `implement` owns code. But a code-bearing plan's embedded code blocks are artifact content, so a fabricated edit anchor or drifted `file:line` inside one is fixed in place like any other finding.
  - title: Re-emit to the same path
    rationale: Same filename keeps the artifact's channel latest-wins, so the grade panel re-judges the same unit instead of forking a parallel artifact history.
related:
  upstream: [grade]
  downstream: [grade, implement]
---
