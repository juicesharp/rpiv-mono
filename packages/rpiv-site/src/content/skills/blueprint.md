---
slug: blueprint
tagline: One-pass replacement for `design` + `plan`. Decomposes a feature into vertical slices with developer micro-checkpoints and emits an implement-ready phased plan in a single run.
purpose: |
  Mid-sized features where the architecture is not load-bearing enough to deserve a separate `design` pass, but a phased plan is still required. `blueprint` collapses decomposition and phasing into one skill, with checkpoints *between* slices so review happens mid-flight instead of after the whole plan is final.
when_to_use:
  - The change touches 6+ files but architecture is not the hard part.
  - You want iterative review between slices, not after the full plan lands.
  - You're starting from a `research` or `explore` artifact and want to go straight to an implement-ready plan.
  - Pick `design` + `plan` instead when architecture is genuinely load-bearing and deserves its own pass.
inputs:
  - name: research or solutions artifact
    required: false
    source: Path to `.rpiv/artifacts/research/*.md` or `.rpiv/artifacts/solutions/*.md`
    notes: Optional — `blueprint` also runs standalone from a free-text feature description, in which case Step 2 fills the integration and precedent slots via agent dispatch. When an artifact is supplied, Open Questions seed the ambiguity queue and Developer Context Q/As are inherited decisions.
  - name: task description
    required: false
    source: Free-text feature description supplied *instead of* an artifact path (standalone mode for small tasks)
outputs:
  - artifact: Implementation plan
    path: .rpiv/artifacts/plans/
    format: markdown with `- [ ]` success-criteria checkboxes
key_steps:
  - title: Read research + key files into context
    rationale: Same as `design`. The skill proceeds against real code, not against research's summary.
  - title: Targeted depth research (parallel)
    rationale: "`codebase-pattern-finder` for code shape, optional `web-search-researcher` for novel work. Integration & precedent come from research itself (no rediscovery)."
  - title: Dimension sweep + holistic self-critique
    rationale: Same six dimensions as `design` (data model · API · integration · scope · verification · performance) so a `blueprint` plan covers the same surface a `design`/`plan` pair would.
  - title: Decompose into vertical slices, then generate slice-by-slice
    rationale: Whole-feature decomposition first; per-slice code generation with developer micro-checkpoints between slices. Review interrupts the loop before it gets expensive to redirect.
  - title: Finalize directly into `.rpiv/artifacts/plans/`
    rationale: "Output is plan-shaped, not design-shaped, so no second `plan` pass is needed. Finalize verifies every phase code fence and Success Criteria block is filled, rebuilds the `phases:` frontmatter array from the body, and flips `status: in-progress` to `status: in-review` — not `ready`, which keeps consumers off an artifact still being edited."
  - title: Independent plan review (artifact-code-reviewer + artifact-coverage-reviewer, in parallel)
    rationale: "Both reviewers are mandatory. Every phase code fence is re-audited against the live codebase at HEAD, and every `## Verification Notes` / `## Precedents & Lessons` entry is checked for a landing success-criteria bullet or visible code mirror. The merged severity-tagged table is persisted into the artifact as a durable audit trail, even when both reviewers return zero findings."
  - title: Developer triage, then flip to ready
    rationale: "No reviewer finding is auto-applied — the developer marks each row applied, deferred, or dismissed, and blockers are triaged sequentially since one resolution can invalidate later rows. Only once every row carries a `resolution` does `status` flip from `in-review` to `ready` and `implement` take over."
related:
  upstream: [research, explore]
  downstream: [implement, validate]
---
