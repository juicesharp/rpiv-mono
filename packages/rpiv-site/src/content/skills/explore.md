---
slug: explore
tagline: Compares 2–4 candidate approaches across precedent-fit, integration risk, migration cost, verification cost, and novelty, then recommends one — ready to feed `design` or `blueprint`.
purpose: |
  When several valid approaches exist, `explore` produces a side-by-side comparison instead of jumping to one. Surface trade-offs explicitly so the design pass starts with the architectural shape already chosen.
when_to_use:
  - There are multiple valid implementations and you cannot pick on intuition alone.
  - The space includes external libraries — you need an ecosystem scan with links.
  - You're a valid pipeline entry point on its own (feeds `design` or `blueprint` directly).
inputs:
  - name: feature/change description
    required: true
    source: Free-text on invocation
  - name: tickets / research docs
    required: false
    source: Paths mentioned inline — read FULLY for constraints
outputs:
  - artifact: Solutions document
    path: .rpiv/artifacts/solutions/
    format: markdown (design-compatible)
key_steps:
  - title: Generate 2–4 named candidates from three sources
    rationale: Ecosystem scan via `web-search-researcher` for external libraries · design-space enumeration for first-principles shapes · user shortlist for already-named picks. Merging the three avoids missing whole categories of solution.
  - title: Confirm candidates × dimensions checkpoint
    rationale: Dimensions (approach-shape · precedent-fit · integration-risk · migration-cost · verification-cost · novelty) are confirmed *before* per-candidate fit agents are dispatched — keeps the analysis budget proportional to the relevant axes.
  - title: Per-candidate fit dispatch in parallel
    rationale: One agent per candidate, scoring against the locked dimensions. Running concurrently keeps the comparison balanced — no candidate gets stale context from prior reasoning.
  - title: Synthesize a comparison matrix + recommendation
    rationale: A matrix is scannable; a recommendation forces a position. Both produce a clean handoff to `design`/`blueprint`, which expects a chosen shape rather than a menu.
related:
  upstream: [discover]
  downstream: [design, blueprint]
---
