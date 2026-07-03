---
slug: design-slice
tagline: Designs one vertical slice from a slice map in isolation, writing its architecture decisions, file map, key interfaces, and success criteria to `.rpiv/artifacts/designs/`.
purpose: |
  The fanout unit of the build pipeline's design stage: N instances run in parallel, one per slice, each designing *only its own slice* against the footing the slice map cites. It does no discovery — the slice's `Draws on:` `file:line`s are the entire reading list, which is exactly why the design-readiness gate demands fully-cited slices upstream.
when_to_use:
  - Dispatched once per slice by the build pipeline's design fanout, after the slice map clears its gate.
  - A dependency's design exists and this slice must build against its published contract (`--upstream`).
  - Not standalone — the per-slice designs only become a plan after the design review and `synthesize`.
  - Prefer `design` when the work was never sliced — this skill assumes the decomposition is already cut and refuses to redraw it.
inputs:
  - name: slice map + slice name
    required: true
    source: "`<slices-path> Slice N: <title>` — a map under `.rpiv/artifacts/slices/` plus the single slice to design"
    notes: A missing path or unparseable `Slice N` is a dispatch error. The slice's `Out of scope` fence is binding.
  - name: --upstream
    required: false
    source: A direct dependency's design doc under `.rpiv/artifacts/designs/` (repeatable)
    notes: Injected by the fanout once the dependency completes. Only its `## Key Interfaces` and `## Notes / Deferred` are read — transitive dependencies are `synthesize`'s problem.
outputs:
  - artifact: Per-slice design doc
    path: .rpiv/artifacts/designs/
    format: markdown — Approach, File Map, Key Interfaces, Integration Points, Success Criteria, Notes / Deferred
key_steps:
  - title: Locate the one `## Slice N` section and honor its fences
    rationale: Sibling lanes run concurrently on the other slices — respecting `Out of scope` is what keeps N parallel designs from colliding on the same decision.
  - title: Read the slice's cited footing fully, and nothing more
    rationale: This skill runs no discovery or analysis subagents by design; the slice map's `Draws on:` citations are the whole evidence base, keeping each lane bounded and cheap.
  - title: Consume upstream `## Key Interfaces` as fixed contracts
    rationale: A shared contract has exactly one owning slice — redesigning a dependency's published shape would fork the truth that `synthesize` later has to reconcile by coin-flip.
  - title: Decide the slice's shape as code shape, not implementation
    rationale: Interfaces, file map, and decisions are what `synthesize` merges and the grade panel judges — actual code is written later, per phase, by `elaborate` and applied by `implement`.
  - title: Ask the developer only on a genuine blocking fork
    rationale: An undecided upstream contract or a real design fork cannot be settled from the inputs, but approval of the finished design belongs to the consolidated design review and the grade panel — not to per-slice prompts.
  - title: "Write the doc with `status: ready`"
    rationale: There is no self-review — the design review and the plan gate own validation, so the lane ends the moment the artifact lands.
related:
  upstream: [slice]
  downstream: [design-review]
---
