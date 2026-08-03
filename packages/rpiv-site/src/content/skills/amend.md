---
slug: amend
tagline: Surgically revises one artifact to clear the failing dimensions a grade panel flagged, re-emitting it in place so the gate re-judges the same channel.
purpose: |
  Closes a gate's fix loop *without* a wholesale rewrite: it applies only what the failing verdicts cite and leaves passing content byte-for-byte. The pipeline loops the re-emitted artifact straight back to the grade panel. That re-judging is the only validation, so the skill never self-reviews or asks questions.
when_to_use:
  - Dispatched as the revise stage of the pipeline's plan-fix and code-fix loops, after a grade panel returns failing verdicts.
  - Any graded artifact (research, plan, spliced code-bearing plan) needs targeted correction, not redesign.
  - Prefer `slice` in re-slice mode when the failure is structural. `amend` may touch only cited lines and cannot split a slice or break a dependency cycle.
inputs:
  - name: artifact
    required: true
    source: "The single `--<channel>` flag that is not a verdicts (`-verdicts`), citation-floor (`-cite-check`), or lineage-source (`--goal`/`--research`/`--subplans`) flag"
    notes: Parsed generically, agnostic to the channel name. The same reviser serves every gate; on both build fix arms it resolves to `--plans`. If exactly one artifact flag and at least one verdicts flag cannot be identified, the skill errors and stops.
  - name: verdicts
    required: true
    source: "`--<channel>-verdicts <path>` (repeatable), verdict JSONs under `.rpiv/artifacts/verdicts/`"
    notes: Grouped by dimension; only the latest verdict per dimension counts.
  - name: citation floors
    required: false
    source: "`--<channel>-cite-check <path>` (repeatable), cite-check verdict JSONs"
    notes: The deterministic citation floor's verdicts, threaded alongside the LLM panel's — `--plan-cite-check` on the plan-fix arm, `--code-cite-check` on the code-fix arm.
  - name: lineage sources
    required: false
    source: "`--goal`, `--research`, `--subplans` — read-only context, never the artifact to re-emit"
    notes: Build fix arms only. A completeness-class finding is repaired by reading the authoritative content here rather than reconstructing it from verdict prose. `plan-fix` threads all three; `code-fix` threads only `--goal` and `--research`.
outputs:
  - artifact: The revised artifact, re-emitted at its SAME path
    format: "unchanged: Edit in place, `status: ready` preserved, `last_updated` bumped"
key_steps:
  - title: Read the artifact fully and every verdict JSON
    rationale: Verdicts accumulate across fix loops, so an older failing verdict may already be superseded. Only the latest per dimension (by `graded_at`) reflects the gate's current judgment.
  - title: Select the failing findings — plus any verdict carrying a risk-duty demotion
    rationale: "Dimensions that pass are settled; touching them risks regressing a pass and expands the diff the panel must re-judge for no gain. The one exception is grader-side — a latest-per-dimension verdict with a non-empty `risk_duty_demotions` array is selected even when its own `pass` is `true`. That demotion is a signal to re-judge, not a plan defect: `amend` manufactures no `risks:` edits for it, so when nothing else fails the artifact is re-emitted unchanged with only `last_updated` bumped."
  - title: Apply each finding's feedback surgically at its `where` anchor
    rationale: The verdict's `feedback` is the instruction set and `where` locates the exact spot. Changes no finding asked for are scope creep the panel never sanctioned.
  - title: Ground codebase-dependent fixes by reading, never editing, the repo
    rationale: The boundary is the working tree. `implement` owns code. But a code-bearing plan's embedded code blocks are artifact content. So a fabricated edit anchor or drifted `file:line` inside one is fixed in place like any other finding.
  - title: Re-emit to the same path
    rationale: Same filename keeps the artifact's channel latest-wins, so the grade panel re-judges the same unit instead of forking a parallel artifact history.
related:
  upstream: [grade]
  downstream: [grade, implement]
---
