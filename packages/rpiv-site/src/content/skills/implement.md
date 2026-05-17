---
slug: implement
tagline: Executes an approved phased plan one phase at a time, applies changes, runs each phase's success criteria, and only advances when they pass.
purpose: |
  The execution arm of the pipeline. `implement` reads a plan, applies the edits for one phase, runs the success-criteria checks, ticks the `- [x]` boxes, and refuses to advance until verification is green. Plans approved via design/blueprint/plan land in the codebase here.
when_to_use:
  - You have a phased plan under `.rpiv/artifacts/plans/` ready to execute.
  - You want to run a single phase only (`/skill:implement <plan> Phase 2`).
  - Skip for tiny bug fixes — apply the change inline off the research artifact instead of building a plan.
inputs:
  - name: $1 (plan path)
    required: true
    source: Path to `.rpiv/artifacts/plans/*.md`
  - name: ${@:2} (phase scope)
    required: false
    source: e.g. `Phase 2` — empty runs all phases sequentially
outputs:
  - artifact: Code changes
    path: working tree
    format: edits + commits per phase
  - artifact: Plan checkmarks
    path: same plan file
    format: "`- [x]` updates in place"
key_steps:
  - title: Read plan + cited files fully
    rationale: Implementation runs against the actual codebase, not against the plan's summary of it. Reading mentioned files without limits prevents partial-context surprises mid-phase.
  - title: Follow the plan's intent while adapting to reality
    rationale: Plans are designed, but reality drifts. On a genuine mismatch the agent stops, presents the deviation, and asks the developer to pick — follow the plan, skip the change, or revise the plan.
  - title: Verify each phase against its success criteria
    rationale: After each phase the agent runs the criteria (`make check test` or equivalent) before advancing. No green, no progress.
  - title: Tick checkboxes in the plan file
    rationale: "`- [x]` updates double as resume markers — re-runs and validate read the same source of truth."
  - title: Chain to the next phase or close out
    rationale: When the last in-scope phase is complete, `implement` emits a completion block that signals downstream skills (`validate`, `commit`) to start.
related:
  upstream: [plan, blueprint, design]
  downstream: [validate, commit, code-review]
---
