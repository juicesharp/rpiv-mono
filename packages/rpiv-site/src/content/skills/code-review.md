---
slug: code-review
tagline: Reads a diff, branch, or PR through Quality · Security · Dependencies lenses with parallel specialist agents and returns one cited report under `.rpiv/artifacts/reviews/`.
purpose: |
  Multi-lens review using parallel specialist agents (integration-scanner, precedent-locator, peer-comparator, codebase-analyzer, web-search-researcher). The most token-hungry skill in the pipeline; drop it into any workflow at any point, not just before commit. Order is interchangeable with `commit`.
when_to_use:
  - Changes are ready for review (pending diff, branch, or PR).
  - You want a third opinion on quality, security risk, or dependency churn before landing.
  - You need a written, archivable review artifact.
inputs:
  - name: scope
    required: false
    source: One of `commit` · `staged` · `working` · `<hash>` · `A..B` · PR branch name
    notes: Empty defaults to feature-branch-vs-default-branch first-parent review.
outputs:
  - artifact: Review document
    path: .rpiv/artifacts/reviews/
    format: markdown with file:line citations
key_steps:
  - title: Resolve scope and assemble a `-U30` union diff
    rationale: 30 lines of surrounding context inline so agents rarely need extra `Read` calls. Union-of-changes (not net) so reverted intermediate work stays visible.
  - title: Wave-1. Integration, precedents, deps/CVE, peer-mirror (parallel)
    rationale: Integration map and peer-mirror gate Wave-2 quality/security; precedents gate reconciliation. Dispatching all four at T=0 keeps the critical path short.
  - title: Wave-2. Quality + Security lenses (parallel)
    rationale: File-oriented (not hunk-oriented) so findings see the whole unit of change. Wave-2 agents receive ONLY the Discovery Map + patch path. Context isolation prevents Wave-1 raw dumps from polluting downstream reasoning.
  - title: Wave-3. Predicate-Trace + Interaction Sweep + Gap-Finder
    rationale: Gated waves catch what single-lens audits miss (gating predicates, cross-file interactions, and findings the lenses didn't surface).
  - title: Reconcile, then verify each cited file:line
    rationale: Advisor reconciliation or inline dimension-sweep merges duplicates; every finding is then re-read at its cited line before the artifact is written. Unverified findings are dropped or demoted.
  - title: Write the review artifact and present follow-ups
    rationale: The artifact is the durable output; follow-ups become tickets, not lost session state.
related:
  upstream: [implement, commit]
  downstream: [revise, commit]
---
