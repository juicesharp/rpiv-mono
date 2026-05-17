---
slug: discover
tagline: Interviews you one question at a time to capture feature intent (Goals · Non-Goals · Functional Requirements · Acceptance Criteria · Decisions) into a Feature Requirements Document the research skill consumes.
purpose: |
  The canonical entry point when the feature idea is still fuzzy. `discover` pins down intent through a one-question-at-a-time interview so subsequent agents do not chase the wrong target. The FRD's Decisions block is consumed by `research` and propagates through Developer Context into `design`.
when_to_use:
  - The idea is fuzzy and the team wants it stress-tested before any codebase probe.
  - You have a half-written ticket or rough spec to refine into a structured FRD.
  - Skip when you already have a clear spec or ticket — go straight to `research`.
inputs:
  - name: $ARGUMENTS
    required: true
    source: Free-text feature description OR path to an existing FRD/ticket/doc to refine
    notes: A path triggers refinement mode — file is read FULLY as baseline context.
outputs:
  - artifact: Feature Requirements Document
    path: .rpiv/artifacts/discover/
    format: markdown (research-compatible)
key_steps:
  - title: Foundational intent question first — no agents, no `file:line`
    rationale: Intent shapes the probe scope. Probing the codebase before stated intent risks framing the FRD around what exists rather than what the developer is trying to solve.
  - title: Lightweight codebase probe shaped by stated intent
    rationale: Parallel locator agents run only after the intent answer narrows the slice. Keeps probe cost proportional to the feature size, not the codebase size.
  - title: Build the decision tree lazily — root + immediate children
    rationale: Expanding one layer at a time avoids speculative questions that depend on answers not yet given.
  - title: Batch-confirm evidence-based pre-resolutions
    rationale: When the probe surfaces a likely answer, the agent proposes it for confirmation rather than silently recording it. Surfaces disagreement before it propagates downstream.
  - title: Interview loop — tiered questions, re-queue cross-cutting answers
    rationale: Each answer can spawn follow-ups; cross-cutting answers re-queue affected branches so the tree stays internally consistent.
  - title: Synthesize answers into FRD sections; write a fresh artifact
    rationale: Each invocation always writes a NEW timestamp-distinct artifact — never appends — so a prior FRD is never silently mutated mid-iteration.
related:
  upstream: []
  downstream: [research, explore]
---
