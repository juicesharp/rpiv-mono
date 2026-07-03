---
slug: validate
tagline: Independently re-runs each phase's success criteria against the working tree and emits a pass/fail validation report that catches half-finished phases the implement loop missed.
purpose: |
  A post-implementation audit. `validate` re-reads the plan, re-runs every `- [ ]` success-criterion against the actual working tree, and emits a structured report: pass/fail per criterion plus drift notes and follow-up tickets. Trust-but-verify after `implement` declares done.
when_to_use:
  - "`implement` has finished and you want third-party confirmation of completion."
  - You suspect drift between the plan's claims and the working tree.
  - Skip when there is no plan to validate against. There is nothing for `validate` to anchor on.
inputs:
  - name: plan path
    required: false
    source: Path to `.rpiv/artifacts/plans/*.md`. When omitted, recent commits are searched for a plan reference
outputs:
  - artifact: Validation report
    path: stdout / session message
    format: structured pass/fail report with drift notes
key_steps:
  - title: Discover context (current session OR fresh)
    rationale: Validation works either as an immediate audit (same session) or a cold audit (later run). Detecting the mode picks the right evidence-gathering path (session memory vs git log + diff).
  - title: Spawn parallel verification agents
    rationale: One `general-purpose` agent verifies code matches the plan; one verifies it follows codebase conventions. Running both catches "implemented but wrong shape" failures that single-axis checks miss.
  - title: Re-run automated verification commands
    rationale: Every plan command (`make check test`, etc.) is re-run against the working tree, independent of whatever `implement` claimed. The plan's checklist is treated as a contract to be re-verified, not as ground truth.
  - title: Walk each phase and re-check its `- [x]` claims
    rationale: A checked box without matching code is a drift signal. Drift notes surface mid-phase pivots and unfinished work the implement loop signed off prematurely.
  - title: Emit pass/fail report with follow-ups
    rationale: Output is structured for action. Every failure gets a follow-up note so nothing falls through the cracks between validation and the next pass.
related:
  upstream: [implement]
  downstream: []
---
