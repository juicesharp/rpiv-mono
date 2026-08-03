---
slug: design
tagline: Decomposes a complex feature into vertical slices and produces a design artifact (architecture decisions, slice breakdown, file map) that the planning skills consume.
purpose: |
  Establishes the *correct architecture* for a change before any phased plan is written. Decomposes the work into the smallest set of vertical slices that can land independently, locks architectural decisions with developer micro-checkpoints, and emits a plan-compatible artifact. Use it when architecture is the hard part of the change.
when_to_use:
  - The change touches 6+ files across multiple layers.
  - Architecture is genuinely load-bearing (schema, API contract, or wiring across boundaries).
  - You already have a `research` or `explore` artifact and want a separate decomposition pass.
  - Prefer `blueprint` for mid-sized features where decomposition + plan can fold into one pass.
inputs:
  - name: research artifact
    required: true
    source: Path to `.rpiv/artifacts/research/*.md` or `.rpiv/artifacts/solutions/*.md`
    notes: Read FULLY; its Open Questions seed the ambiguity queue, its Q/As are inherited decisions.
  - name: task description
    required: false
    source: Free-text alongside the artifact path
outputs:
  - artifact: Design document
    path: .rpiv/artifacts/designs/
    format: markdown (plan-compatible)
key_steps:
  - title: Read research + key source files into context
    rationale: The design proceeds against actual code, not against a re-summary of research. Reading the cited files up-front avoids re-discovery cost mid-design.
  - title: Targeted depth research (parallel)
    rationale: "`codebase-pattern-finder`, `codebase-analyzer`, `integration-scanner` and (when commits are available) `precedent-locator` run in parallel. Focuses on HOW things work (not WHERE) because discovery already happened."
  - title: Dimension sweep (triage ambiguities)
    rationale: Findings are filtered through six dimensions (data model · API · integration · scope · verification · performance) that map 1:1 to `plan` sections. This guarantees nothing the planner needs is missing. Simple decisions are recorded with `file:line` evidence; only genuine ambiguities reach the developer.
  - title: Developer checkpoint on genuine ambiguities
    rationale: One question at a time, each grounded in `file:line` evidence. Pulls only NEW information the agents could not find.
  - title: Decompose into vertical slices, then generate slice-by-slice
    rationale: Whole-feature decomposition first, then per-slice code generation with developer micro-checkpoints between slices. Stops architectural drift across slices without paying full-rewrite cost.
  - title: Verify every slice with `slice-verifier` before the micro-checkpoint
    rationale: "Mandatory at Step 6.2 for every slice — no skipping, no batching across slices. The agent sees the slice's generated code *and* its Success Criteria together and emits a three-row `Decisions / Cross-slice / Research` summary. A VIOLATION is either fixed and re-dispatched, or surfaced verbatim at the 6.3 micro-checkpoint for developer ratification — never silently dismissed. This is design's only quality gate: the `artifact-code-reviewer` + `artifact-coverage-reviewer` pair runs later, inside `/skill:plan` Step 4."
  - title: Verify cross-slice integration
    rationale: After generation, scan all slices for shared contracts (types, signatures, wiring) and confirm they match, the last step before the artifact is finalized.
related:
  upstream: [research, explore]
  downstream: [plan, implement]
---
