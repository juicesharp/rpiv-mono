---
slug: blueprint
tagline: One-pass replacement for `design` + `plan` — decomposes a feature into vertical slices with developer micro-checkpoints and emits an implement-ready phased plan in a single run.
purpose: |
  Mid-sized features where the architecture is not load-bearing enough to deserve a separate `design` pass, but a phased plan is still required. `blueprint` collapses decomposition and phasing into one skill, with checkpoints *between* slices so review happens mid-flight instead of after the whole plan is final.
when_to_use:
  - The change touches 6+ files but architecture is not the hard part.
  - You want iterative review between slices, not after the full plan lands.
  - You're starting from a `research` or `explore` artifact and want to go straight to an implement-ready plan.
  - Pick `design` + `plan` instead when architecture is genuinely load-bearing and deserves its own pass.
inputs:
  - name: research artifact
    required: true
    source: Path to `.rpiv/artifacts/research/*.md` or `.rpiv/artifacts/solutions/*.md`
    notes: Open Questions seed the ambiguity queue; Developer Context Q/As are inherited decisions.
  - name: task description
    required: false
    source: Free-text alongside the artifact path
outputs:
  - artifact: Implementation plan
    path: .rpiv/artifacts/plans/
    format: markdown with `- [ ]` success-criteria checkboxes
key_steps:
  - title: Read research + key files into context
    rationale: Same as `design` — the skill proceeds against real code, not against research's summary.
  - title: Targeted depth research (parallel)
    rationale: "`codebase-pattern-finder` for code shape, optional `web-search-researcher` for novel work. Integration & precedent come from research itself — no rediscovery."
  - title: Dimension sweep + holistic self-critique
    rationale: Same six dimensions as `design` (data model · API · integration · scope · verification · performance) so a `blueprint` plan covers the same surface a `design`/`plan` pair would.
  - title: Decompose into vertical slices, then generate slice-by-slice
    rationale: Whole-feature decomposition first; per-slice code generation with developer micro-checkpoints between slices. Review interrupts the loop before it gets expensive to redirect.
  - title: Finalize directly into `.rpiv/artifacts/plans/`
    rationale: Output is plan-shaped, not design-shaped — `implement` consumes it directly, no second pass needed.
related:
  upstream: [research, explore]
  downstream: [implement, validate]
---
