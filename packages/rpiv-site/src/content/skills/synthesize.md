---
slug: synthesize
tagline: Merges independent per-slice designs into one coherent phased plan in `.rpiv/artifacts/plans/`, reconciling overlaps and wiring integration seams as the fan-in barrier of the design fanout.
purpose: |
  Each per-slice design was produced *blind to its siblings*, so someone must make them fit: merge colliding edits to the same file, wire each dependency to the real shape its owner defined, and resolve incompatible decisions to one. For large slice maps it runs hierarchically — per-cluster sub-plans, then a root merge — so no single pass must hold every design at once.
when_to_use:
  - Dispatched by the build pipeline after the design review accepts the per-slice designs.
  - Root mode (`--subplans`) when a cluster fanout has produced partial sub-plans to merge.
  - Prefer `plan` when there was no design fanout — this skill reconciles existing decisions; it never designs.
inputs:
  - name: --designs
    required: true
    source: Per-slice design docs under `.rpiv/artifacts/designs/` (repeatable)
    notes: Required in flat and partial modes; each contributes its File Map, Key Interfaces, Integration Points, and Success Criteria.
  - name: --subplans
    required: false
    source: Partial sub-plans from a cluster fanout (repeatable)
    notes: Selects root mode — the root reads each sub-plan's `summary`, `exports`, and phases instead of re-reading every design.
  - name: --research
    required: false
    source: The research artifact the slices rest on
    notes: Supplies cross-slice constraints during reconciliation.
  - name: --as-subplan
    required: false
    source: Flag from the cluster fanout
    notes: Emits a compact sub-plan (partial mode) instead of a full plan.
outputs:
  - artifact: Phased plan (flat / root mode)
    path: .rpiv/artifacts/plans/
    format: markdown with machine-readable `phases:` + `phase_count` frontmatter and Synthesis Notes
  - artifact: Sub-plan (partial mode)
    path: .rpiv/artifacts/subplans/
    format: same phase shape plus `summary` and `exports` frontmatter naming the seams the root wires
key_steps:
  - title: Read every input fully
    rationale: Reconciliation only works over the complete set — a design skimmed is a collision missed. Hierarchy, not selective reading, is how context stays bounded.
  - title: Reconcile overlap, integration, and conflict
    rationale: This is the whole point of the barrier — two blind designs touching the same file or symbol must become one coherent change, and a dependency must reference the real shape its owner defined, not a guess at it.
  - title: Record every resolution in Synthesis Notes
    rationale: The grade panel's correctness and architecture-fit members check the resolutions, and `elaborate` later reads the notes as the reconciled seams it must not re-decide.
  - title: Sequence one phase per slice, dependency-ordered
    rationale: A phase must never precede one it depends on, or `implement` builds against interfaces that do not exist yet; tightly-coupled slices may merge into one phase, with the merge noted.
  - title: Emit plan-compatible output with machine-readable phases
    rationale: "`phase_count` must equal both the `phases:` array length and the heading count — a downstream derive-check (a program, 0 LLM calls) rejects any mismatch — and the standard phase shape lets `implement` and `validate` consume the plan unchanged."
  - title: Decide conflicts yourself, never ask
    rationale: The skill is non-interactive — the design review already collected the human's calls, so an unresolvable conflict gets the most defensible resolution on record, and the grade panel catches a bad merge.
related:
  upstream: [design-review]
  downstream: [grade]
---
